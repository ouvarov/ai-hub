import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBuilderLogger } from "@shared/lib/logger";
import { skills, agents } from "./registry";
import { actions } from "../../agent-runner/src/registry";

/**
 * Skill, agent and action tools already log themselves (job="skills" / "actions").
 * Excluding them by name keeps this wrapper opt-out-free for builder tools — a new
 * builder tool is instrumented automatically — without double-logging domain tools.
 */
const DOMAIN_TOOL_NAMES = new Set<string>([
  ...skills.map((s) => s.meta.name),
  ...agents.map((a) => a.meta.name),
  ...actions.map((a) => a.meta.name),
]);

export interface BuilderTelemetryMeta {
  secrets: Record<string, string>;
  user?: string;
  transport?: string;
  /**
   * Resolved at call time, not at registration: tools are registered during init(),
   * before the client has identified itself. The MCP SDK (1.26.0) exposes clientInfo
   * but not the negotiated protocol version, so that is not logged yet.
   */
  client?: () => string | undefined;
}

interface ToolResultShape {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
}

function firstLine(result: ToolResultShape): string {
  const text = result.content?.find((c) => typeof c.text === "string")?.text ?? "";
  return text.split("\n")[0]!.slice(0, 200);
}

function extractRunId(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (arg && typeof arg === "object" && "runId" in arg) {
      const value = (arg as { runId?: unknown }).runId;
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Wraps server.tool() so every Builder tool registered afterwards logs one Loki
 * event per call: invoked / blocked (handler returned isError) / failed (threw).
 *
 * Wrapping registration rather than each handler is deliberate — Why: a new
 * builder tool must not be able to ship without telemetry. Before this, the 16
 * builder tools logged nothing, so a user-reported pipeline failure left no
 * server-side trace and could not be confirmed.
 */
export function instrumentBuilderTools(server: McpServer, meta: BuilderTelemetryMeta): void {
  const register = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    let handlerIndex = -1;
    for (let i = args.length - 1; i > 0; i--) {
      if (typeof args[i] === "function") {
        handlerIndex = i;
        break;
      }
    }
    const toolName = String(args[0]);
    if (handlerIndex === -1 || DOMAIN_TOOL_NAMES.has(toolName)) return register(...args);

    const handler = args[handlerIndex] as (...handlerArgs: unknown[]) => Promise<ToolResultShape>;

    args[handlerIndex] = async (...handlerArgs: unknown[]) => {
      const started = Date.now();
      const logger = createBuilderLogger(meta.secrets, { tool: toolName, user: meta.user });
      const client = meta.client?.();
      const base: Record<string, string> = {
        ...(meta.transport ? { transport: meta.transport } : {}),
        ...(client ? { client } : {}),
        run_id: extractRunId(handlerArgs) ?? "none",
      };

      try {
        const result = await handler(...handlerArgs);
        const blocked = result?.isError === true;
        const fields = { ...base, status: blocked ? "blocked" : "ok", duration_ms: String(Date.now() - started) };
        if (blocked) logger.warn("Builder tool blocked", { ...fields, reason: firstLine(result) });
        else logger.info("Builder tool invoked", fields);
        await logger.flush();
        return result;
      } catch (err) {
        logger.error("Builder tool failed", {
          ...base,
          status: "error",
          duration_ms: String(Date.now() - started),
          error: err instanceof Error ? err.message : String(err),
        });
        await logger.flush();
        throw err;
      }
    };

    return register(...args);
  };
}
