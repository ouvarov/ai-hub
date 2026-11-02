import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSkillTools } from "./tools/run-skill";
import { registerGitHubTools } from "./tools/github-pr";
import { registerProxyActionTools } from "./tools/proxy-actions";
import { BUILDER_INSTRUCTIONS } from "./builder-instructions";
import { BuilderRunState } from "./builder-run-state";
import { createSessionGateStore } from "./builder-gates";
import { instrumentBuilderTools } from "./builder-telemetry";

export { BuilderRunState };

type Env = {
  GATEWAY_URL?: string;
  GATEWAY?: Fetcher;
  AGENT_RUNNER?: Fetcher;
  BUILDER_RUNS?: DurableObjectNamespace<BuilderRunState>;
};

export class SkillRunnerMCP extends McpAgent<Env> {
  server = new McpServer(
    {
      name: "Acme AI Hub",
      version: "1.0.0",
    },
    {
      instructions: BUILDER_INSTRUCTIONS,
    },
  );

  async init() {
    // Fetch secrets from gateway (gateway has Vault access, Durable Objects don't)
    let secrets: Record<string, string> = {};
    if (this.env.GATEWAY) {
      try {
        const res = await this.env.GATEWAY.fetch("https://internal/__internal/secrets");
        if (res.ok) {
          const data = (await res.json()) as { secrets: Record<string, string> };
          secrets = data.secrets;
        }
      } catch {
        // Gateway unavailable — secrets stay empty
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

    // Log transport type for debugging client compatibility
    const transportType = this.getTransportType();
    console.log(`[AI Hub] Connection: transport=${transportType}, user=${userProps?.email ?? "anonymous"}`);

    // Session-scoped gates remain as the fallback for calls that carry no runId.
    const session = await createSessionGateStore(this.ctx.storage);

    // Must run BEFORE the builder tools are registered — it wraps server.tool().
    instrumentBuilderTools(this.server, {
      secrets,
      user: userProps?.email,
      transport: transportType,
      client: () => {
        const info = this.server.server.getClientVersion();
        return info ? `${info.name}/${info.version}` : undefined;
      },
    });

    registerSkillTools(this.server, this.env, userProps, session, transportType, secrets, this.env.BUILDER_RUNS);
    registerGitHubTools(this.server, secrets, userProps, session, this.env.BUILDER_RUNS);
    registerProxyActionTools(this.server, this.env.AGENT_RUNNER, userProps);
  }
}

// Wrap serve() to inject ctx.props from gateway's X-User-* headers.
// Gateway sets these headers from OAuth identity; agents framework reads ctx.props
// to pass user identity into the Durable Object as this.props.
const mcpServe = SkillRunnerMCP.serve("/mcp");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const email = request.headers.get("X-User-Email");
    if (email) {
      const name = request.headers.get("X-User-Name") || "Unknown";
      const groupsRaw = request.headers.get("X-User-Groups");
      let groups: string[] = [];
      try { groups = groupsRaw ? JSON.parse(groupsRaw) : []; } catch { /* ignore */ }
      (ctx as unknown as { props: Record<string, unknown> }).props = { email, name, groups };
    }
    return mcpServe.fetch(request, env, ctx);
  },
};
