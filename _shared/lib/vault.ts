/**
 * Vault KVv2 client for Cloudflare Workers.
 */

const VAULT_MOUNT = "ai-hub";

export const VAULT_ADDR_DIRECT = "https://vault.example.com/";
export const VAULT_ADDR_TUNNEL = "http://10.0.0.1:8200/";

export interface VaultConfig {
  token: string;
  addr: string;
  fetchFn?: (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;
  cacheTtlMs?: number;
}

interface CacheEntry {
  data: Record<string, string>;
  expiresAt: number;
}

interface VaultKVv2Response {
  data?: {
    data?: Record<string, unknown>;
  };
  errors?: string[];
}

function normalizeVaultValues(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (value === undefined || value === null) {
      out[key] = "";
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}

export interface VaultClient {
  getSecrets(path: string): Promise<Record<string, string>>;
  getSecret(path: string, key: string): Promise<string | undefined>;
  clearCache(): void;
}

export function createVaultClient(config: VaultConfig): VaultClient {
  const cache = new Map<string, CacheEntry>();
  const ttl = config.cacheTtlMs ?? 5 * 60 * 1000;

  async function fetchSecrets(path: string): Promise<Record<string, string>> {
    const cached = cache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const doFetch = config.fetchFn ?? (globalThis as unknown as { fetch: VaultConfig["fetchFn"] }).fetch!;
    const baseAddr = config.addr.endsWith("/") ? config.addr : `${config.addr}/`;
    const url = `${baseAddr}v1/${VAULT_MOUNT}/data/${path}`;
    const res = await doFetch(url, {
      headers: {
        "X-Vault-Token": config.token,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Vault: failed to fetch "${VAULT_MOUNT}/${path}" (HTTP ${res.status}): ${body}`,
      );
    }

    const json = (await res.json()) as VaultKVv2Response;

    if (json.errors?.length) {
      throw new Error(`Vault: ${json.errors.join(", ")}`);
    }

    const data = normalizeVaultValues(json.data?.data ?? {});

    cache.set(path, { data, expiresAt: Date.now() + ttl });

    return data;
  }

  return {
    getSecrets: fetchSecrets,

    async getSecret(path: string, key: string): Promise<string | undefined> {
      const secrets = await fetchSecrets(path);
      return secrets[key];
    },

    clearCache() {
      cache.clear();
    },
  };
}


/**
 * Load every secret the platform itself needs into one flat UPPER_SNAKE map.
 *
 * Template ships only the platform paths. When an action needs a new secret,
 * the builder adds one `vault.getSecrets("<path>")` line and maps its keys
 * here — the return object below is parsed at build time into
 * KNOWN_VAULT_KEYS (see skill-runner/scripts/bundle-docs.js), so keep every
 * key on its own line in `KEY: source.key ?? ""` form.
 */
export async function loadAIHubSecrets(
  vault: VaultClient,
): Promise<Record<string, string>> {
  const [
    oauth,
    github,
    actionApiKey,
    loki,
  ] = await Promise.all([
    vault.getSecrets("oauth").catch(() => ({} as Record<string, string>)),
    vault.getSecrets("github").catch(() => ({} as Record<string, string>)),
    vault.getSecrets("action-api-key").catch(() => ({} as Record<string, string>)),
    vault.getSecrets("loki").catch(() => ({} as Record<string, string>)),
  ]);

  return {
    MCP_OAUTH_ISSUER: oauth.issuer ?? "",
    MCP_OAUTH_JWKS_URL: oauth.jwks_url ?? "",
    MCP_OAUTH_AUDIENCE: oauth.audience ?? "",
    MCP_OAUTH_CLIENT_ID: oauth.client_id ?? "",
    GITHUB_APP_ID: github.app_id ?? "",
    GITHUB_APP_INSTALLATION_ID: github.installation_id ?? "",
    GITHUB_APP_PRIVATE_KEY: github.private_key ?? "",
    ACTION_API_KEY: actionApiKey.value ?? "",
    LOKI_URL: loki.url ?? "",
    LOKI_TENANT_ID: loki.tenant_id ?? "",
  };
}
