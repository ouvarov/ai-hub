/**
 * Action — a side-effect function that calls external APIs.
 *
 * Rules:
 * - Makes fetch() calls to external services (Jira, Strapi, Slack, etc.)
 * - Secrets (API tokens) come from Vault via `ctx.env`
 * - Self-contained: owns input parsing, fetch calls, and output
 * - Can be triggered by: Claude Desktop (MCP tool), webhook (HTTP), cron, or backend call
 * - Action doesn't know its trigger — it receives input, does fetch, returns result
 *
 * Two flavors:
 * - Action-API: simple fetch, no Claude API
 * - Action-Agent: fetch + Claude API for text analysis/generation/classification
 */

export interface ActionLogger {
  // meta values may be any JSON-serialisable scalar/structure — the logger
  // JSON.stringifies them into the Loki line (see _shared/lib/logger.ts).
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * The authenticated caller, as established by the Gateway's OAuth flow.
 *
 * Populated ONLY when the action was triggered by a signed-in person over MCP
 * (directly on agent-runner, or via the skill-runner proxy). Webhook and cron
 * triggers carry no person, so `ctx.user` is undefined there — an action that
 * scopes data to its caller must treat that as "refuse", not "default".
 *
 * This is the ONLY trustworthy identity an action has. Never accept an email
 * from the action's own input for authorization or data scoping: input is
 * whatever the model or webhook caller chose to send, while this value comes
 * from headers the Gateway sets after verifying the OAuth token (and the
 * public webhook path rebuilds its forwarded request without any user
 * headers, so it cannot be forged from outside).
 */
export interface ActionUser {
  email: string;
  name: string;
  groups: string[];
}

export interface ActionContext {
  /** API tokens and secrets injected from Vault via Gateway /__internal/secrets */
  env: Record<string, string>;
  /** Authenticated caller for MCP-triggered runs; undefined for webhook/cron. */
  user?: ActionUser;
  /** Logger for action-level observability. Logs are sent to Grafana Loki by middleware. */
  logger: ActionLogger;
  /** Metrics reporting — used by middleware and action internals */
  metrics: {
    /** Report Claude API token usage (Action-Agent only). Builder inserts this automatically. */
    reportTokens(usage: {
      input_tokens: number;
      output_tokens: number;
      model: string;
    }): void;
  };
}

export interface ActionMeta {
  name: string;
  description: string;
  /** Knowledge domain: jira, strapi, slack, github */
  service: string;
  /** What Claude should fetch from other MCPs before calling this action */
  gather?: string[];
  /**
   * JSON example of the expected input structure.
   * Used to generate the MCP tool description so Claude knows what to pass.
   */
  inputSchema?: Record<string, unknown>;
  /** ADR filename (e.g. "004-strapi-subscription") — links to docs/adr/{name}.md */
  adr?: string;
  /** Authentik groups that can access this action. Empty/undefined = public (everyone). */
  allowedGroups?: string[];
  /**
   * Custom Vault secret name for API key auth.
   * Omit → uses default shared key (ai-hub/action-api-key).
   * Set → uses Vault at ai-hub/{apiKeySecret}.
   *
   * TODO: Not yet implemented — gateway always uses default key.
   * When implemented, gateway should read this field from action registry
   * and look up the corresponding Vault secret.
   */
  apiKeySecret?: string;
}

export type Action<TInput, TOutput> = {
  meta: ActionMeta;
  execute: (input: TInput, ctx: ActionContext) => Promise<TOutput>;
};

/** Helper to define an action with proper typing. */
export function defineAction<TInput, TOutput>(
  meta: ActionMeta,
  execute: (input: TInput, ctx: ActionContext) => Promise<TOutput>,
): Action<TInput, TOutput> {
  return {
    meta,
    execute: (input, ctx) => execute(input, ctx),
  };
}
