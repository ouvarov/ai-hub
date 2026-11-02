import type { OAuthHelpers, AuthRequest } from "@cloudflare/workers-oauth-provider";
import { services } from "./registry";
import {
  createVaultClient,
  loadAIHubSecrets,
  VAULT_ADDR_TUNNEL,
  type VaultClient,
} from "@shared/lib/vault";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Env = {
  OAUTH_KV: KVNamespace;
  SKILL_RUNNER: Fetcher;
  AGENT_RUNNER: Fetcher;
  VAULT_TOKEN: string;
  VAULT_SERVICE: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;
  [key: string]: unknown;
};

/** User info extracted from Authentik ID token or userinfo endpoint */
export interface AuthUser {
  email: string;
  name: string;
  sub: string;
  groups: string[];
}

/** Props stored with the OAuth grant and passed to apiHandler via ctx.props */
export interface TokenProps {
  email: string;
  name: string;
  userId: string;
  groups: string[];
  /** Authentik access token — used to fetch fresh userinfo (groups) */
  authentikAccessToken?: string;
  /** Authentik refresh token — used to renew access token when expired */
  authentikRefreshToken?: string;
}

// ─── Vault helpers ───────────────────────────────────────────────────────────

const secretsCache = new WeakMap<Env, Promise<Record<string, string>>>();

function getVaultClient(env: Env): VaultClient {
  return createVaultClient({
    token: env.VAULT_TOKEN,
    addr: VAULT_ADDR_TUNNEL,
    fetchFn: (...args) => env.VAULT_SERVICE!.fetch(...args),
  });
}

function getSecrets(env: Env): Promise<Record<string, string>> {
  if (!secretsCache.has(env)) {
    secretsCache.set(env, loadAIHubSecrets(getVaultClient(env)));
  }
  return secretsCache.get(env)!;
}

// ─── Cookie helpers (HMAC-signed session) ────────────────────────────────────

const COOKIE_NAME = "aihub_session_v2";
const COOKIE_MAX_AGE = 3600; // 1 hour
const TOKENS_KV_PREFIX = "authentik_tokens:";
const TOKENS_KV_TTL = 86400; // 24 hours — aligned with Authentik refresh token lifetime

/**
 * Derive a signing key from VAULT_TOKEN using HMAC-SHA256.
 * VAULT_TOKEN is the only wrangler secret — we reuse it as cookie-signing material.
 */
async function getSigningKey(env: Env): Promise<CryptoKey> {
  if (!env.VAULT_TOKEN) {
    throw new Error("VAULT_TOKEN is not configured — cannot sign cookies or state");
  }
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(env.VAULT_TOKEN + ":cookie-signing");
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signCookie(value: string, env: Env): Promise<string> {
  const key = await getSigningKey(env);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${value}.${sigHex}`;
}

async function verifyCookie(
  cookie: string,
  env: Env,
): Promise<string | null> {
  const lastDot = cookie.lastIndexOf(".");
  if (lastDot === -1) return null;

  const value = cookie.slice(0, lastDot);
  const sigHex = cookie.slice(lastDot + 1);

  const key = await getSigningKey(env);
  const encoder = new TextEncoder();
  const pairs = sigHex.match(/.{2}/g);
  if (!pairs) return null;
  const sigBytes = new Uint8Array(
    pairs.map((h) => parseInt(h, 16)),
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(value),
  );

  return valid ? value : null;
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie") || "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) cookies[k] = rest.join("=");
  }
  return cookies;
}

// ─── Safe base64 (handles non-ASCII) ─────────────────────────────────────────

function safeBase64Encode(str: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

function safeBase64Decode(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ─── Signed state parameter (HMAC-protected) ────────────────────────────────

async function signState(payload: string, env: Env): Promise<string> {
  const encoded = safeBase64Encode(payload);
  return signCookie(encoded, env);
}

async function verifyState(state: string, env: Env): Promise<string | null> {
  const encoded = await verifyCookie(state, env);
  if (!encoded) return null;
  try {
    return safeBase64Decode(encoded);
  } catch {
    return null;
  }
}

// ─── Authentik helpers ───────────────────────────────────────────────────────

const AUTHENTIK_BASE = "https://auth.example.com";
const AUTHENTIK_AUTHORIZE = `${AUTHENTIK_BASE}/application/o/authorize/`;
const AUTHENTIK_TOKEN = `${AUTHENTIK_BASE}/application/o/token/`;
const AUTHENTIK_USERINFO = `${AUTHENTIK_BASE}/application/o/userinfo/`;
const AUTHENTIK_CLIENT_ID = "ai-hub-mcp";

/**
 * Exchange an Authentik authorization code for tokens.
 */
async function exchangeAuthentikCode(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: AUTHENTIK_CLIENT_ID,
  });

  const res = await fetch(AUTHENTIK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentik token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token?: string; id_token?: string }>;
}

/**
 * Refresh an Authentik access token using a refresh token.
 */
async function refreshAuthentikToken(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token?: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: AUTHENTIK_CLIENT_ID,
  });

  const res = await fetch(AUTHENTIK_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Authentik token refresh failed (${res.status})`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token?: string }>;
}

/**
 * Fetch user info from Authentik userinfo endpoint.
 */
async function fetchAuthentikUserInfo(
  accessToken: string,
): Promise<AuthUser> {
  const res = await fetch(AUTHENTIK_USERINFO, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Authentik userinfo failed (${res.status})`);
  }

  const raw = await res.text();
  console.log(JSON.stringify({ event: "authentik_userinfo_raw", status: res.status, body: raw }));

  let data: {
    sub: string;
    email?: string;
    preferred_username?: string;
    name?: string;
    groups?: string[];
  };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Authentik userinfo returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  return {
    sub: data.sub,
    email: data.email || data.preferred_username || "unknown",
    name: data.name || data.preferred_username || "Unknown User",
    groups: data.groups ?? [],
  };
}

// ─── Health check ────────────────────────────────────────────────────────────

interface CheckResult {
  status: "ok" | "error";
  ms?: number;
  error?: string;
  [key: string]: unknown;
}

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  checks: Record<string, CheckResult>;
}

async function handleHealthCheck(env: Env): Promise<Response> {
  const checks: HealthStatus["checks"] = {};

  // 1a. Vault connectivity — can we reach Vault via VPC tunnel?
  const vaultConnStart = Date.now();
  try {
    // sys/health is unauthenticated — tests raw connectivity
    const doFetch = (...args: Parameters<typeof fetch>) => env.VAULT_SERVICE!.fetch(...args);
    const res = await doFetch(
      `${VAULT_ADDR_TUNNEL}v1/sys/health`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) } as Record<string, unknown>,
    );
    const body = await res.json() as { initialized?: boolean; sealed?: boolean };
    checks.vault_reachable = {
      status: res.ok || res.status === 429 || res.status === 472 || res.status === 473 ? "ok" : "error",
      ms: Date.now() - vaultConnStart,
      initialized: body.initialized,
      sealed: body.sealed,
    };
  } catch (err) {
    checks.vault_reachable = { status: "error", ms: Date.now() - vaultConnStart, error: err instanceof Error ? err.message : String(err) };
  }

  // 1b. Vault token — self-lookup to check if token is valid and its TTL
  const tokenStart = Date.now();
  try {
    const doFetch = (...args: Parameters<typeof fetch>) => env.VAULT_SERVICE!.fetch(...args);
    const res = await doFetch(
      `${VAULT_ADDR_TUNNEL}v1/auth/token/lookup-self`,
      { headers: { "X-Vault-Token": env.VAULT_TOKEN, Accept: "application/json" }, signal: AbortSignal.timeout(5000) } as Record<string, unknown>,
    );
    if (!res.ok) {
      checks.vault_token = { status: "error", ms: Date.now() - tokenStart, error: `HTTP ${res.status} — token likely expired` };
    } else {
      const data = await res.json() as { data?: { ttl?: number; expire_time?: string; display_name?: string; renewable?: boolean } };
      const ttl = data.data?.ttl ?? 0;
      const expireTime = data.data?.expire_time ?? "unknown";
      const ttlHours = Math.round(ttl / 3600);
      checks.vault_token = {
        status: ttl > 3600 ? "ok" : "error",
        ms: Date.now() - tokenStart,
        ttl_seconds: ttl,
        ttl_human: ttlHours > 24 ? `${Math.round(ttlHours / 24)}d` : `${ttlHours}h`,
        expire_time: expireTime,
        renewable: data.data?.renewable,
        ...(ttl <= 3600 ? { error: `Token expires in ${ttlHours}h — needs renewal` } : {}),
      };
    }
  } catch (err) {
    checks.vault_token = { status: "error", ms: Date.now() - tokenStart, error: err instanceof Error ? err.message : String(err) };
  }

  // 1c. Vault secrets — can we load all secrets?
  const secretsStart = Date.now();
  try {
    // Force fresh fetch — bypass WeakMap cache
    const secrets = await loadAIHubSecrets(getVaultClient(env));
    const keyCount = Object.keys(secrets).length;
    const hasGitHub = !!(secrets.GITHUB_APP_ID && secrets.GITHUB_APP_PRIVATE_KEY);
    const hasOAuth = !!(secrets.MCP_OAUTH_ISSUER && secrets.MCP_OAUTH_CLIENT_ID);
    const hasActionKey = !!secrets.ACTION_API_KEY;

    checks.vault_secrets = { status: "ok", ms: Date.now() - secretsStart, keys: keyCount };
    checks.vault_secrets_github = { status: hasGitHub ? "ok" : "error", ...(hasGitHub ? {} : { error: "GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY missing" }) };
    checks.vault_secrets_oauth = { status: hasOAuth ? "ok" : "error", ...(hasOAuth ? {} : { error: "MCP_OAUTH_ISSUER or MCP_OAUTH_CLIENT_ID missing" }) };
    checks.vault_secrets_action_key = { status: hasActionKey ? "ok" : "error", ...(hasActionKey ? {} : { error: "ACTION_API_KEY missing" }) };
  } catch (err) {
    checks.vault_secrets = { status: "error", ms: Date.now() - secretsStart, error: err instanceof Error ? err.message : String(err) };
  }

  // 2. Authentik — is it reachable?
  const authentikStart = Date.now();
  try {
    const res = await fetch(AUTHENTIK_BASE + "/application/o/ai-hub-mcp/.well-known/openid-configuration", {
      signal: AbortSignal.timeout(5000),
    });
    checks.authentik = { status: res.ok ? "ok" : "error", ms: Date.now() - authentikStart, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    checks.authentik = { status: "error", ms: Date.now() - authentikStart, error: err instanceof Error ? err.message : String(err) };
  }

  // 3. Service bindings — skill-runner and agent-runner reachable?
  for (const [name, bindingKey] of [["skill_runner", "SKILL_RUNNER"], ["agent_runner", "AGENT_RUNNER"]] as const) {
    const start = Date.now();
    const binding = getBinding(env, bindingKey);
    if (!binding) {
      checks[name] = { status: "error", error: `binding ${bindingKey} not configured` };
      continue;
    }
    try {
      const res = await binding.fetch("https://internal/health", { signal: AbortSignal.timeout(5000) });
      checks[name] = { status: res.ok || res.status === 404 ? "ok" : "error", ms: Date.now() - start };
    } catch (err) {
      checks[name] = { status: "error", ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 4. KV — OAuth token storage accessible?
  const kvStart = Date.now();
  try {
    await env.OAUTH_KV.get("__health_check_ping");
    checks.oauth_kv = { status: "ok", ms: Date.now() - kvStart };
  } catch (err) {
    checks.oauth_kv = { status: "error", ms: Date.now() - kvStart, error: err instanceof Error ? err.message : String(err) };
  }

  const hasError = Object.values(checks).some((c) => c.status === "error");
  const vaultDown = checks.vault_reachable?.status === "error" || checks.vault_token?.status === "error";
  const overall: HealthStatus["status"] = vaultDown ? "down" : hasError ? "degraded" : "ok";

  const result: HealthStatus = {
    status: overall,
    timestamp: new Date().toISOString(),
    checks,
  };

  return Response.json(result, { status: overall === "ok" ? 200 : 503 });
}

// ─── Default handler (public routes + OAuth authorize flow) ──────────────────

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public routes
    if (path === "/" || path === "") {
      return Response.json({
        name: "Acme AI Hub Gateway",
        version: "0.2.0",
        docs: "GET /services - list MCP servers, skills, agents. GET /health - status.",
      });
    }

    if (path === "/health") {
      return handleHealthCheck(env);
    }

    if (path === "/services") {
      return Response.json(
        Object.entries(services).map(([key, s]) => ({
          key,
          name: s.name,
          description: s.description,
          skills: s.skills,
          agents: s.agents,
        })),
      );
    }

    // Internal secrets endpoint — only accessible via service binding, never from internet
    if (path === "/__internal/secrets") {
      // Verify this is a service binding call (no cf-connecting-ip = internal)
      if (request.headers.get("cf-connecting-ip")) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      try {
        const secrets = await getSecrets(env);
        return Response.json({ secrets });
      } catch {
        return Response.json({ error: "vault_unavailable" }, { status: 502 });
      }
    }

    // ── Webhook route: POST /actions/:name ──────────────────────────────────
    // API key auth (X-Action-Key), not OAuth. Returns 200 OK immediately, processes async.
    if (path.startsWith("/actions/") && request.method === "POST") {
      const actionName = path.slice("/actions/".length);
      if (!actionName) {
        return Response.json({ error: "Missing action name" }, { status: 400 });
      }

      // Verify API key
      const providedKey = request.headers.get("X-Action-Key");
      if (!providedKey) {
        return Response.json({ error: "Missing X-Action-Key header" }, { status: 401 });
      }

      let secrets: Record<string, string>;
      try {
        secrets = await getSecrets(env);
      } catch {
        return Response.json({ error: "vault_unavailable" }, { status: 502 });
      }

      // TODO: support per-action custom keys (action.meta.apiKeySecret)
      const expectedKey = secrets.ACTION_API_KEY;
      if (!expectedKey) {
        return Response.json({ error: "ACTION_API_KEY not configured in Vault" }, { status: 503 });
      }

      const enc = new TextEncoder();
      const a = enc.encode(providedKey);
      const b = enc.encode(expectedKey);
      if (a.length !== b.length || !(await crypto.subtle.timingSafeEqual(a, b))) {
        return Response.json({ error: "Invalid API key" }, { status: 401 });
      }

      // Forward to Agent Runner async — return 200 OK immediately
      const binding = getBinding(env, "AGENT_RUNNER");
      if (!binding) {
        return Response.json({ error: "Agent Runner not available" }, { status: 503 });
      }

      const body = await request.text();
      ctx.waitUntil(
        binding
          .fetch(
            new Request(`https://internal/actions/${actionName}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            }),
          )
          .then((res) => {
            if (!res.ok) {
              console.log(
                JSON.stringify({
                  event: "action_webhook_error",
                  action: actionName,
                  status: res.status,
                }),
              );
            }
          })
          .catch((err) => {
            console.log(
              JSON.stringify({
                event: "action_webhook_error",
                action: actionName,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }),
      );

      return Response.json({ accepted: true, action: actionName });
    }

    // OAuth authorize endpoint
    if (path === "/authorize") {
      return handleAuthorize(request, env);
    }

    // Authentik callback
    if (path === "/auth/callback") {
      return handleCallback(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

/**
 * /authorize — entry point for OAuth flow.
 *
 * 1. Parse the OAuth authorization request from the MCP client.
 * 2. Check for an existing Authentik session (signed cookie).
 * 3. If no session: redirect to Authentik with the original OAuth request in `state`.
 * 4. If session: complete the authorization and redirect back to the client.
 */
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // Parse the original OAuth auth request (from Claude Desktop)
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    console.error("Failed to parse auth request:", err);
    return Response.json(
      { error: "Invalid authorization request" },
      { status: 400 },
    );
  }

  // Check for existing session cookie
  const cookies = parseCookies(request);
  const sessionCookie = cookies[COOKIE_NAME];

  if (sessionCookie) {
    const payload = await verifyCookie(sessionCookie, env);
    if (payload) {
      try {
        const user: AuthUser = JSON.parse(payload);
        return completeAuth(env, authRequest, user);
      } catch {
        // Invalid cookie payload — fall through to redirect
      }
    }
  }

  // No valid session — redirect to Authentik
  const origin = new URL(request.url).origin;
  const callbackUri = `${origin}/auth/callback`;

  // Encode the original OAuth request in state so we can resume after Authentik callback
  const statePayload = JSON.stringify({
    oauthRequest: {
      responseType: authRequest.responseType,
      clientId: authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      state: authRequest.state,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      resource: authRequest.resource,
    },
  });
  const state = await signState(statePayload, env);

  const authentikUrl = new URL(AUTHENTIK_AUTHORIZE);
  authentikUrl.searchParams.set("response_type", "code");
  authentikUrl.searchParams.set("client_id", AUTHENTIK_CLIENT_ID);
  authentikUrl.searchParams.set("redirect_uri", callbackUri);
  authentikUrl.searchParams.set("scope", "openid profile email groups");
  authentikUrl.searchParams.set("state", state);

  return Response.redirect(authentikUrl.toString(), 302);
}

/**
 * /auth/callback — Authentik redirects here after user login.
 *
 * 1. Exchange the Authentik auth code for tokens.
 * 2. Fetch user info.
 * 3. Set a signed session cookie.
 * 4. Decode the original OAuth request from state.
 * 5. Complete the OAuth authorization flow.
 */
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Handle Authentik errors (user denied consent, account disabled, etc.)
  const authentikError = url.searchParams.get("error");
  if (authentikError) {
    const description = url.searchParams.get("error_description") || "Unknown error";
    return Response.json(
      { error: "Authentication denied", reason: authentikError, description },
      { status: 403 },
    );
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  if (!code || !stateParam) {
    return Response.json(
      { error: "Missing code or state from Authentik callback" },
      { status: 400 },
    );
  }

  // Verify and decode HMAC-signed state to recover original OAuth request
  const stateJson = await verifyState(stateParam, env);
  if (!stateJson) {
    return Response.json({ error: "Invalid or tampered state parameter" }, { status: 400 });
  }

  let stateData: {
    oauthRequest: {
      responseType: string;
      clientId: string;
      redirectUri: string;
      scope: string[];
      state: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      resource?: string | string[];
    };
  };
  try {
    stateData = JSON.parse(stateJson);
  } catch {
    return Response.json({ error: "Invalid state parameter" }, { status: 400 });
  }

  // Exchange Authentik code for tokens
  const origin = new URL(request.url).origin;
  const callbackUri = `${origin}/auth/callback`;

  let user: AuthUser;
  let authentikAccessToken: string | undefined;
  let authentikRefreshToken: string | undefined;
  try {
    const tokens = await exchangeAuthentikCode(code, callbackUri);
    authentikAccessToken = tokens.access_token;
    authentikRefreshToken = tokens.refresh_token;
    user = await fetchAuthentikUserInfo(tokens.access_token);
  } catch (err) {
    console.error("Authentik authentication failed:", err);
    return Response.json(
      { error: "Authentication failed" },
      { status: 502 },
    );
  }

  // Persist Authentik tokens in KV so cookie-based re-auth can use them for live group resolution
  try {
    await env.OAUTH_KV.put(
      `${TOKENS_KV_PREFIX}${user.sub}`,
      JSON.stringify({ accessToken: authentikAccessToken, refreshToken: authentikRefreshToken }),
      { expirationTtl: TOKENS_KV_TTL },
    );
  } catch (err) {
    console.log(JSON.stringify({ event: "kv_store_tokens_failed", userId: user.sub, error: err instanceof Error ? err.message : String(err) }));
  }

  // Reconstruct the AuthRequest from state
  const authRequest: AuthRequest = {
    responseType: stateData.oauthRequest.responseType,
    clientId: stateData.oauthRequest.clientId,
    redirectUri: stateData.oauthRequest.redirectUri,
    scope: stateData.oauthRequest.scope,
    state: stateData.oauthRequest.state,
    codeChallenge: stateData.oauthRequest.codeChallenge,
    codeChallengeMethod: stateData.oauthRequest.codeChallengeMethod,
    resource: stateData.oauthRequest.resource,
  };

  // Complete authorization — generates auth code and redirects to client
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.sub,
    metadata: { email: user.email, name: user.name },
    scope: authRequest.scope,
    props: {
      email: user.email,
      name: user.name,
      userId: user.sub,
      groups: user.groups,
      authentikAccessToken,
      authentikRefreshToken,
    } satisfies TokenProps,
  });

  // Set session cookie so future /authorize calls skip Authentik login
  const cookieValue = await signCookie(
    JSON.stringify(user),
    env,
  );

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": `${COOKIE_NAME}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    },
  });
}

/**
 * Complete the OAuth authorization flow with a known user.
 * Retrieves stored Authentik tokens from KV so resolveGroups() can fetch fresh groups.
 */
async function completeAuth(
  env: Env,
  authRequest: AuthRequest,
  user: AuthUser,
): Promise<Response> {
  // Retrieve Authentik tokens stored during initial login
  let authentikAccessToken: string | undefined;
  let authentikRefreshToken: string | undefined;
  try {
    const stored = await env.OAUTH_KV.get(`${TOKENS_KV_PREFIX}${user.sub}`);
    if (stored) {
      const parsed = JSON.parse(stored) as { accessToken?: string; refreshToken?: string };
      authentikAccessToken = parsed.accessToken;
      authentikRefreshToken = parsed.refreshToken;
    }
  } catch (err) {
    console.log(JSON.stringify({ event: "kv_read_tokens_failed", userId: user.sub, error: err instanceof Error ? err.message : String(err) }));
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: user.sub,
    metadata: { email: user.email, name: user.name },
    scope: authRequest.scope,
    props: {
      email: user.email,
      name: user.name,
      userId: user.sub,
      groups: user.groups,
      authentikAccessToken,
      authentikRefreshToken,
    } satisfies TokenProps,
  });

  return Response.redirect(redirectTo, 302);
}

// ─── Live groups resolver (fetches fresh groups from Authentik) ─────────────

interface GroupsCacheEntry {
  groups: string[];
  expiresAt: number;
}

const groupsCache = new Map<string, GroupsCacheEntry>();
const GROUPS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/**
 * Fetch fresh user groups from Authentik using stored tokens.
 * Falls back to props.groups if Authentik is unreachable or tokens expired.
 * When tokens are refreshed, updates both props (for current request) and KV (for future cookie-based re-auth).
 */
async function resolveGroups(props: TokenProps, env: Env): Promise<string[]> {
  const cacheKey = props.userId;
  const cached = groupsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.groups;
  }

  if (!props.authentikAccessToken) {
    return props.groups ?? [];
  }

  // Try fetching userinfo with current access token
  try {
    const user = await fetchAuthentikUserInfo(props.authentikAccessToken);
    groupsCache.set(cacheKey, { groups: user.groups, expiresAt: Date.now() + GROUPS_CACHE_TTL });
    return user.groups;
  } catch (err) {
    console.log(JSON.stringify({ event: "resolve_groups_access_token_failed", userId: props.userId, error: err instanceof Error ? err.message : String(err) }));
  }

  if (!props.authentikRefreshToken) {
    return props.groups ?? [];
  }

  try {
    const tokens = await refreshAuthentikToken(props.authentikRefreshToken);
    const user = await fetchAuthentikUserInfo(tokens.access_token);
    groupsCache.set(cacheKey, { groups: user.groups, expiresAt: Date.now() + GROUPS_CACHE_TTL });

    // Update props so current request uses fresh tokens
    props.authentikAccessToken = tokens.access_token;
    if (tokens.refresh_token) {
      props.authentikRefreshToken = tokens.refresh_token;
    }

    // Persist refreshed tokens to KV for future cookie-based re-auth
    try {
      await env.OAUTH_KV.put(
        `${TOKENS_KV_PREFIX}${props.userId}`,
        JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? props.authentikRefreshToken }),
        { expirationTtl: TOKENS_KV_TTL },
      );
    } catch (err) {
      console.log(JSON.stringify({ event: "kv_update_tokens_failed", userId: props.userId, error: err instanceof Error ? err.message : String(err) }));
    }

    return user.groups;
  } catch (err) {
    console.log(JSON.stringify({ event: "resolve_groups_refresh_failed", userId: props.userId, error: err instanceof Error ? err.message : String(err) }));
    return props.groups ?? [];
  }
}

// ─── API handler (authenticated proxy to downstream services) ────────────────

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

function getBinding(env: Env, bindingName: string): Fetcher | null {
  const binding = env[bindingName];
  if (binding && typeof (binding as Fetcher).fetch === "function") {
    return binding as Fetcher;
  }
  return null;
}

function buildProxyRequest(request: Request, path: string, userProps?: TokenProps): Request {
  const headers = new Headers(request.headers);
  // Identity is asserted ONLY from the validated OAuth props. Delete any inbound
  // X-User-* first so a client cannot smuggle an identity by sending these headers
  // itself: absence of validated props must mean absence of identity downstream,
  // not pass-through of whatever the client sent.
  headers.delete("X-User-Email");
  headers.delete("X-User-Name");
  headers.delete("X-User-Groups");
  if (userProps?.email) {
    headers.set("X-User-Email", userProps.email);
    headers.set("X-User-Name", userProps.name || "Unknown");
    headers.set("X-User-Groups", JSON.stringify(userProps.groups ?? []));
  }
  return new Request(`https://internal${path}`, {
    method: request.method,
    headers,
    body: METHODS_WITH_BODY.has(request.method) ? request.body : undefined,
  });
}

/**
 * API handler receives requests that match apiRoute prefixes AND have a valid access token.
 * ctx.props contains { email, name, userId } from the OAuth grant.
 *
 * Cast to satisfy OAuthProvider's ExportedHandlerWithFetch requirement
 * (ExportedHandler has fetch as optional; we guarantee it here).
 */
export const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Extract service name from path: /:service/mcp, /:service/sse, etc.
    const match = path.match(/^\/([^/]+)(\/.*)?$/);
    if (!match) {
      return Response.json({ error: "Invalid path" }, { status: 404 });
    }

    const serviceKey = match[1];
    const subPath = match[2] || "/";
    const service = services[serviceKey];

    if (!service) {
      return Response.json(
        { error: `Unknown service: ${serviceKey}`, available: Object.keys(services) },
        { status: 404 },
      );
    }

    const binding = getBinding(env, service.binding);
    if (!binding) {
      return Response.json(
        { error: `Service binding not configured: ${service.binding}` },
        { status: 503 },
      );
    }

    try {
      // OAuthProvider sets ctx.props with authenticated user identity
      const userProps = (ctx as unknown as { props?: TokenProps }).props;
      // Fetch fresh groups from Authentik (cached 2 min) instead of relying on stale grant props
      if (userProps) {
        userProps.groups = await resolveGroups(userProps, env);
      }
      const proxyReq = buildProxyRequest(request, subPath, userProps);
      const res = await binding.fetch(proxyReq);
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    } catch {
      return Response.json(
        { error: "Service unavailable", service: serviceKey },
        { status: 502 },
      );
    }
  },
};
