import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
// Import action metadata from agent-runner registry.
// Only meta is used (name, description, gather, inputSchema) — execution is proxied via service binding.
// esbuild resolves this at build time; no runtime cross-worker import.
import { actions } from "../../../agent-runner/src/registry";
import { hasAccess } from "@shared/lib/access";
import { identityHeaders } from "@shared/lib/caller-identity";
import type { UserProps } from "./run-skill";

/** Default agent-runner URL for local dev when service binding is unavailable */
const LOCAL_AGENT_RUNNER_URL = "http://localhost:8788";

/**
 * Proxy layer: registers agent-runner actions as MCP tools in skill-runner.
 * When called, proxies execution to agent-runner via Cloudflare service binding.
 * Falls back to HTTP fetch to localhost:8788 for local dev (wrangler dev).
 *
 * This lets users connect a single MCP (skill-runner) and access everything:
 * skills, agents, AND actions.
 *
 * Access control: `hasAccess(action.meta.allowedGroups, userProps.groups)`, the
 * same one-liner run-skill and run-action use. `hasAccess` already returns true
 * when no groups are declared, so ungated actions stay public and there is no
 * proxy-specific rule left to diverge. A runtime re-check inside the handler
 * provides defense-in-depth.
 */
export function registerProxyActionTools(
  server: McpServer,
  agentRunner: Fetcher | undefined,
  userProps?: UserProps,
) {
  if (actions.length === 0) return;
  const userGroups = userProps?.groups ?? [];

  for (const action of actions) {
    if (!hasAccess(action.meta.allowedGroups, userGroups)) continue;

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
        if (!hasAccess(action.meta.allowedGroups, userGroups)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: access denied for action "${action.meta.name}". Required group membership is missing.`,
              },
            ],
            isError: true,
          };
        }
        try {
          const parsed = JSON.parse(input);

          // Proxy to agent-runner: service binding in production, HTTP in local dev
          const url = `${agentRunner ? "https://internal" : LOCAL_AGENT_RUNNER_URL}/actions/${action.meta.name}`;
          const fetcher = agentRunner ?? globalThis;
          // Forward the OAuth-derived caller identity so the action's ctx.user
          // is populated. Internal hop only — see caller-identity.ts.
          const res = await fetcher.fetch(url, {
            method: "POST",
            headers: identityHeaders(userProps),
            body: JSON.stringify(parsed),
          });

          if (!res.ok) {
            const err = await res.text();
            return {
              content: [{ type: "text" as const, text: `Error (${res.status}): ${err}` }],
              isError: true,
            };
          }

          const result = await res.json();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }
}
