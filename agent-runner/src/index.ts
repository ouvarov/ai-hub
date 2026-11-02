import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTools, executeActionByName } from "./tools/run-action";
import { userFromHeaders } from "@shared/lib/caller-identity";
import { crons } from "./crons-registry";
import { selectDueJobs } from "@shared/skills/cron/select-due-jobs";

type Env = {
  GATEWAY_URL?: string;
  GATEWAY?: Fetcher;
};

export class AgentRunnerMCP extends McpAgent<Env> {
  server = new McpServer(
    {
      name: "Acme Agent Runner",
      version: "1.0.0",
    },
    {
      instructions:
        "Agent Runner — executes actions that call external APIs (Jira, Strapi, Slack, etc.) with secrets from Vault. Actions are MCP tools you can call directly.",
    },
  );

  async init() {
    // Fetch secrets from gateway (gateway has Vault access, Durable Objects don't)
    let secrets: Record<string, string> = {};
    if (this.env.GATEWAY) {
      try {
        const res = await this.env.GATEWAY.fetch(
          "https://internal/__internal/secrets",
        );
        if (res.ok) {
          const data = (await res.json()) as {
            secrets: Record<string, string>;
          };
          secrets = data.secrets;
        }
      } catch {
        // Gateway unavailable — secrets stay empty
      }
    }

    // Local dev fallback: when Gateway is unavailable, read secrets from .dev.vars
    if (Object.keys(secrets).length === 0) {
      for (const [key, val] of Object.entries(this.env)) {
        if (typeof val === "string" && key !== "GATEWAY_URL") {
          secrets[key] = val;
        }
      }
    }

    const raw = this.props as Record<string, unknown> | undefined;
    const userProps = raw?.email
      ? {
          email: String(raw.email),
          name: raw.name ? String(raw.name) : "Unknown",
          groups: Array.isArray(raw.groups) ? (raw.groups as string[]) : [],
        }
      : undefined;

    registerActionTools(this.server, secrets, userProps);
  }
}

// MCP handler for Claude Desktop
const mcpServe = AgentRunnerMCP.serve("/mcp");

/** Fetch secrets from Gateway with in-memory cache (5 min TTL, same as Gateway's Vault cache) */
let cachedSecrets: { data: Record<string, string>; expiresAt: number } | null = null;

async function fetchSecrets(env: Env): Promise<Record<string, string>> {
  if (cachedSecrets && cachedSecrets.expiresAt > Date.now()) {
    return cachedSecrets.data;
  }
  if (env.GATEWAY) {
    try {
      const res = await env.GATEWAY.fetch("https://internal/__internal/secrets");
      if (res.ok) {
        const data = (await res.json()) as { secrets: Record<string, string> };
        cachedSecrets = { data: data.secrets, expiresAt: Date.now() + 5 * 60 * 1000 };
        return data.secrets;
      }
    } catch {
      // Gateway unavailable
    }
  }

  // Local dev fallback: read secrets from .dev.vars / wrangler vars
  const secrets: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string" && key !== "GATEWAY_URL") {
      secrets[key] = val;
    }
  }
  return secrets;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // HTTP webhook route: POST /actions/:name
    // Called by Gateway after API key verification
    if (
      url.pathname.startsWith("/actions/") &&
      request.method === "POST"
    ) {
      // This route has no auth of its own — the API-key gate lives in the gateway,
      // and we trust the X-User-* identity headers only because the gateway sets
      // them from a validated token. That trust holds ONLY when the request arrived
      // over the gateway's service binding. A service-binding call carries no
      // cf-connecting-ip; a request straight from the public edge does. Reject the
      // latter so a public hostname can never be used to invoke actions or forge an
      // identity. Mirrors the gateway's own /__internal/secrets guard.
      if (request.headers.get("cf-connecting-ip")) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const actionName = url.pathname.slice("/actions/".length);
      if (actionName.includes("/")) {
        return Response.json({ error: "Invalid action name" }, { status: 400 });
      }
      try {
        const secrets = await fetchSecrets(env);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        // Caller identity, when the request came through an authenticated path.
        // See userFromHeaders for why these headers are trustworthy here.
        const result = await executeActionByName(
          actionName,
          body,
          secrets,
          (p) => ctx.waitUntil(p),
          userFromHeaders(request.headers),
        );
        return Response.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(
          JSON.stringify({
            event: "action_http_error",
            action: actionName,
            error: message,
          }),
        );
        return Response.json(
          { error: "action_execution_failed", message },
          { status: 500 },
        );
      }
    }

    // MCP route: everything else goes to McpAgent
    const email = request.headers.get("X-User-Email");
    if (email) {
      const name = request.headers.get("X-User-Name") || "Unknown";
      const groupsRaw = request.headers.get("X-User-Groups");
      let groups: string[] = [];
      try { groups = groupsRaw ? JSON.parse(groupsRaw) : []; } catch { /* ignore */ }
      (ctx as unknown as { props: Record<string, unknown> }).props = {
        email,
        name,
        groups,
      };
    }
    return mcpServe.fetch(request, env, ctx);
  },

  // Cron-jobs scheduler (thin shell). Cloudflare fires this once per minute
  // (see wrangler [triggers]). All decision logic lives in the pure, unit-
  // tested cron_select_due_jobs skill; here we only snapshot the registry,
  // ask which jobs are due, dispatch each due job's target action in-process,
  // and emit a structured cron_run log line.
  //
  // Known v1 limitation: no run-state store, so idempotency relies on CF's
  // once-per-minute tick. Around DST transitions a job scheduled inside the
  // shifted window can fire twice (fall-back) or be skipped (spring-forward);
  // the run-log store fast-follow closes this via persisted lastRun.
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    try {
      const { due } = await selectDueJobs.execute({
        jobs: crons.map((c) => ({
          name: c.meta.name,
          schedule: c.meta.schedule,
          timezone: c.meta.timezone,
          enabled: c.meta.enabled,
          lastRunMinuteIso: null, // v1: no run-state store yet
        })),
        at: new Date().toISOString(),
      });
      if (due.length === 0) return;

      const byName = new Map(crons.map((c) => [c.meta.name, c]));
      const secrets = await fetchSecrets(env);

      for (const name of due) {
        const job = byName.get(name);
        if (!job) continue;
        const startedAt = new Date().toISOString();
        ctx.waitUntil(
          executeActionByName(
            job.meta.target.name,
            job.meta.target.input ?? {},
            secrets,
            (p) => ctx.waitUntil(p),
          )
            .then(() =>
              console.log(
                JSON.stringify({
                  event: "cron_run",
                  job: name,
                  trigger: "cron",
                  action: job.meta.target.name,
                  status: "ok",
                  startedAt,
                  finishedAt: new Date().toISOString(),
                }),
              ),
            )
            .catch((err: unknown) =>
              console.log(
                JSON.stringify({
                  event: "cron_run",
                  job: name,
                  trigger: "cron",
                  action: job.meta.target.name,
                  status: "error",
                  error: err instanceof Error ? err.message : String(err),
                  startedAt,
                  finishedAt: new Date().toISOString(),
                }),
              ),
            ),
        );
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          event: "cron_scheduler_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  },
};
