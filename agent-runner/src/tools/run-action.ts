import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { actions } from "../registry";
import type { ActionContext } from "@shared/types";
import { toActionUser } from "@shared/lib/caller-identity";
import { createActionLogger } from "@shared/lib/logger";
import { hasAccess } from "@shared/lib/access";

export interface UserProps {
  email?: string;
  name?: string;
  groups?: string[];
}

/** Structured log entry for observability. Middleware logs this for every action execution. */
interface ActionLog {
  action: string;
  trigger: "mcp" | "webhook";
  duration_ms: number;
  status: "ok" | "error";
  error?: string;
  tokens?: { input_tokens: number; output_tokens: number; model: string };
}

export function registerActionTools(
  server: McpServer,
  secrets: Record<string, string>,
  userProps?: UserProps,
) {
  const userGroups = userProps?.groups ?? [];
  const registeredNames = new Set<string>();

  for (const action of actions) {
    if (!hasAccess(action.meta.allowedGroups, userGroups)) continue;
    if (registeredNames.has(action.meta.name)) {
      throw new Error(
        `Duplicate action name: "${action.meta.name}". Each action must have a unique name.`,
      );
    }
    registeredNames.add(action.meta.name);

    let description = `[Action] ${action.meta.description}`;
    if (action.meta.gather && action.meta.gather.length > 0) {
      description +=
        "\nBEFORE calling this action, use your available MCP tools to gather:\n";
      description += action.meta.gather
        .map((g: string, i: number) => `${i + 1}. ${g}`)
        .join("\n");
      description += "\nPass the gathered data as JSON input.";
    }
    if (action.meta.inputSchema) {
      description += `\n\nExpected input JSON structure:\n${JSON.stringify(action.meta.inputSchema, null, 2)}`;
    }

    server.tool(
      action.meta.name,
      description,
      {
        input: z.string().describe("JSON string with action input parameters"),
      },
      async ({ input }: { input: string }) => {
        const start = Date.now();
        let tokenReport: ActionLog["tokens"] | undefined;
        const logger = createActionLogger(secrets, {
          action: action.meta.name,
          trigger: "mcp",
        });

        // Build action context with secrets, logger, metrics — and the caller.
        // userProps comes from the OAuth-derived X-User-* headers (via this.props),
        // so an action can scope its work to the person who actually called it.
        const ctx: ActionContext = {
          env: secrets,
          user: toActionUser(userProps),
          logger,
          metrics: {
            reportTokens(usage) {
              tokenReport = usage;
            },
          },
        };

        try {
          const parsed = JSON.parse(input);
          logger.info("Action started");
          const result = await action.execute(parsed, ctx);
          const durationMs = Date.now() - start;

          // Middleware: structured log for observability
          const log: ActionLog = {
            action: action.meta.name,
            trigger: "mcp",
            duration_ms: durationMs,
            status: "ok",
            ...(tokenReport ? { tokens: tokenReport } : {}),
          };
          console.log(JSON.stringify(log));

          logger.info("Action completed", {
            status: "ok",
            duration_ms: String(durationMs),
            ...(tokenReport
              ? {
                  input_tokens: String(tokenReport.input_tokens),
                  output_tokens: String(tokenReport.output_tokens),
                  model: tokenReport.model,
                }
              : {}),
          });
          await logger.flush();

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result ?? null, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - start;

          // Middleware: structured error log
          const log: ActionLog = {
            action: action.meta.name,
            trigger: "mcp",
            duration_ms: durationMs,
            status: "error",
            error: message,
            ...(tokenReport ? { tokens: tokenReport } : {}),
          };
          console.log(JSON.stringify(log));

          logger.error("Action failed", {
            status: "error",
            duration_ms: String(durationMs),
            error: message,
            ...(tokenReport
              ? {
                  input_tokens: String(tokenReport.input_tokens),
                  output_tokens: String(tokenReport.output_tokens),
                  model: tokenReport.model,
                }
              : {}),
          });
          await logger.flush();

          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }
}

/** Pre-built map for O(1) action lookup by name */
const actionMap = new Map(actions.map((a) => [a.meta.name, a]));

/**
 * Execute an action by name via HTTP (webhook path).
 * Called from index.ts for POST /actions/:name requests.
 * Same middleware logging as MCP path.
 */
export async function executeActionByName(
  actionName: string,
  input: unknown,
  secrets: Record<string, string>,
  waitUntil?: (promise: Promise<unknown>) => void,
  user?: UserProps,
): Promise<unknown> {
  const action = actionMap.get(actionName);
  if (!action) {
    throw new Error(`Action not found: ${actionName}`);
  }

  const start = Date.now();
  let tokenReport: ActionLog["tokens"] | undefined;
  const logger = createActionLogger(secrets, {
    action: actionName,
    trigger: "webhook",
  });

  const ctx: ActionContext = {
    env: secrets,
    user: toActionUser(user),
    logger,
    metrics: {
      reportTokens(usage) {
        tokenReport = usage;
      },
    },
  };

  const flushLogger = () => {
    const p = logger.flush();
    if (waitUntil) {
      waitUntil(p);
    }
    return p;
  };

  try {
    logger.info("Action started");
    const result = await action.execute(input, ctx);
    const durationMs = Date.now() - start;

    const log: ActionLog = {
      action: actionName,
      trigger: "webhook",
      duration_ms: durationMs,
      status: "ok",
      ...(tokenReport ? { tokens: tokenReport } : {}),
    };
    console.log(JSON.stringify(log));

    logger.info("Action completed", {
      status: "ok",
      duration_ms: String(durationMs),
      ...(tokenReport
        ? {
            input_tokens: String(tokenReport.input_tokens),
            output_tokens: String(tokenReport.output_tokens),
            model: tokenReport.model,
          }
        : {}),
    });
    flushLogger();

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;

    const log: ActionLog = {
      action: actionName,
      trigger: "webhook",
      duration_ms: durationMs,
      status: "error",
      error: message,
      ...(tokenReport ? { tokens: tokenReport } : {}),
    };
    console.log(JSON.stringify(log));

    logger.error("Action failed", {
      status: "error",
      duration_ms: String(durationMs),
      error: message,
      ...(tokenReport
        ? {
            input_tokens: String(tokenReport.input_tokens),
            output_tokens: String(tokenReport.output_tokens),
            model: tokenReport.model,
          }
        : {}),
    });
    flushLogger();

    throw err;
  }
}
