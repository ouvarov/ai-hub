/**
 * Known Vault secret keys and registry metadata, parsed at build time.
 * Re-generate with: node skill-runner/scripts/bundle-docs.js
 */
export const KNOWN_VAULT_KEYS: string[] = ["MCP_OAUTH_ISSUER","MCP_OAUTH_JWKS_URL","MCP_OAUTH_AUDIENCE","MCP_OAUTH_CLIENT_ID","GITHUB_APP_ID","GITHUB_APP_INSTALLATION_ID","GITHUB_APP_PRIVATE_KEY","ACTION_API_KEY","LOKI_URL","LOKI_TENANT_ID"];

/**
 * Registry metadata — known entry names and import paths from both registries.
 * Used by submit_for_review to detect removed entries and invalid imports.
 */
export const KNOWN_REGISTRY = {"skillEntries":["wordStats"],"agentEntries":[],"actionEntries":[],"skillRunnerImportPaths":["@shared/skills/text/word-stats"],"actionRunnerImportPaths":[]} as const;
