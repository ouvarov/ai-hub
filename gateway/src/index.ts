import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { defaultHandler, apiHandler } from "./oauth-handlers";
import { services } from "./registry";
import type { Env } from "./oauth-handlers";

/**
 * Acme AI Hub Gateway — OAuth 2.1 server-side provider.
 *
 * OAuthProvider handles automatically:
 *   - /.well-known/oauth-authorization-server  (metadata)
 *   - /.well-known/oauth-protected-resource    (RFC 9728)
 *   - /oauth/token                             (code exchange, refresh)
 *   - /oauth/register                          (dynamic client registration)
 *   - Token storage in OAUTH_KV
 *   - PKCE S256 validation
 *   - Access token validation on apiRoute requests
 *
 * We implement:
 *   - /authorize         (redirect to Authentik, session cookie)
 *   - /auth/callback     (Authentik code exchange, complete OAuth flow)
 *   - apiHandler         (authenticated proxy to downstream MCP services)
 *   - Public routes      (/, /health, /services in defaultHandler)
 *
 * NOTE: apiRoute:"/" only matches exactly "/", not all paths (OAuthProvider special-case).
 * We must list each service prefix explicitly so token validation works on service paths.
 */
export default new OAuthProvider<Env>({
  // Each registered service gets its own apiRoute prefix for token validation.
  // OAuthProvider treats "/" as exact-match only, so we list service prefixes.
  apiRoute: Object.keys(services).map((key) => `/${key}`),
  apiHandler: apiHandler,

  // Handles public routes (/health, /services, /) and the OAuth authorize flow
  defaultHandler: defaultHandler,

  // OAuth endpoints
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",

  // Token configuration
  scopesSupported: ["mcp:read", "mcp:tools"],
  accessTokenTTL: 3600,       // 1 hour
  refreshTokenTTL: 2592000,   // 30 days

  // Security: require S256 PKCE, no implicit flow
  allowImplicitFlow: false,
  allowPlainPKCE: false,
});
