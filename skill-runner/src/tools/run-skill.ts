import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { skills, agents } from "../registry";
import { actions as liveActions } from "../../../agent-runner/src/registry";
import { hasAccess } from "@shared/lib/access";
import { createSkillLogger } from "@shared/lib/logger";
import { createGitHubClient, type GitHubClient } from "@shared/lib/github";
import {
  CLAUDE_MD,
  TEMPLATE_MD,
  BMAD_COMMANDS,
  getBmadWorkflow,
  getBmadConfig,
  getAdrIndex,
  getAdr,
  type BmadCommand,
} from "../bundled-docs";
import { KNOWN_VAULT_KEYS, KNOWN_REGISTRY } from "../vault-keys.generated";
import { validateSubmission, formatErrors, type SubmissionFile } from "./validate-submission";
import { resolveFiles, filesParam, normalizeFiles } from "./resolve-files";
import type { RunGates } from "../builder-run-state";
import {
  checkGates,
  newRunId,
  openRun,
  resolveGateStore,
  RUN_ID_DESCRIPTION,
  type BuilderRunsNamespace,
  type GateStore,
} from "../builder-gates";

/** Fetch base content for edit-mode resolution, or a clear error if GitHub is unconfigured. */
function makeBaseFetcher(fetchMainFile?: (p: string) => Promise<string | null>) {
  return fetchMainFile ?? (async () => {
    throw new Error("GitHub App is not configured — cannot fetch the base file for `edits`. Use `content` mode.");
  });
}

type SkillRunnerEnv = {
  GATEWAY_URL?: string;
};

const REPO_OWNER = "acme";
const REPO_NAME = "ai-hub";

/** Builds a main-HEAD fetcher backed by GitHub App credentials, or null if unconfigured. */
function buildMainFetcher(secrets?: Record<string, string>): ((path: string) => Promise<string | null>) | undefined {
  if (!secrets) return undefined;
  const { GITHUB_APP_ID: appId, GITHUB_APP_INSTALLATION_ID: installationId, GITHUB_APP_PRIVATE_KEY: privateKey } = secrets;
  if (!appId || !installationId || !privateKey) return undefined;
  let client: GitHubClient | null = null;
  return async (path: string) => {
    try {
      if (!client) client = createGitHubClient({ appId, installationId, privateKey });
      return await client.getFileContent(REPO_OWNER, REPO_NAME, path, "main");
    } catch {
      return null;
    }
  };
}

async function runContentValidation(files: SubmissionFile[], fetchMainFile?: (p: string) => Promise<string | null>) {
  return validateSubmission(files, {
    liveSkillsCount: skills.length,
    liveAgentsCount: agents.length,
    liveActionsCount: liveActions.length,
    knownVaultKeys: KNOWN_VAULT_KEYS,
    knownRegistry: KNOWN_REGISTRY,
    fetchMainFile,
  });
}

export interface UserProps {
  email?: string;
  name?: string;
  groups?: string[];
}

/**
 * Pipeline gates are scoped to a builder RUN, not to the transport session.
 *
 * MCP 2026-07-28 removed protocol-level sessions and the Mcp-Session-Id header
 * (SEP-2567), and the spec's stated replacement for cross-call state is an
 * explicit, server-minted handle passed as an ordinary tool argument. Clients that
 * went stateless stopped reusing sessions, and since the agents framework addresses
 * this Durable Object by session id, session-scoped gates now start empty on every
 * call — the pipeline could never be completed. Gate state lives in
 * BuilderRunState keyed by runId; session gates remain as the fallback.
 */
export type BuilderGates = RunGates;

export function registerSkillTools(
  server: McpServer,
  env: SkillRunnerEnv = {},
  userProps?: UserProps,
  session?: GateStore,
  transportType?: string,
  secrets?: Record<string, string>,
  runs?: BuilderRunsNamespace,
) {
  const gatewayUrl = env.GATEWAY_URL;
  const fetchMainFile = buildMainFetcher(secrets);

  const gatesFor = (runId?: string) =>
    resolveGateStore({ runId, runs, session, user: userProps?.email });

  const gateError = (message: string) => ({
    content: [{ type: "text" as const, text: `⛔ ${message}` }],
    isError: true,
  });

  const missingSteps = (action: string, missing: string[], store?: GateStore) => {
    const hint = store?.scope.startsWith("run:")
      ? ""
      : `\n\nNo runId was passed, so these steps are tracked per transport session — which MCP 2026-07-28 no longer keeps stable. Call start_building and pass its runId to every builder tool.`;
    return gateError(
      `Cannot ${action} — missing steps:\n${missing.map((m) => `- ${m}`).join("\n")}\n\nComplete these steps first.${hint}`,
    );
  };

  // ── Builder entry point ──────────────────────────────────────────

  server.tool(
    "start_building",
    `Start the Builder pipeline — the entry point for creating skills, agents, or actions.

Call this when the user wants to create, modify, or automate something.
Do NOT ask questions first. Call this tool, read the returned docs (CLAUDE.md + TEMPLATE.md), then proceed.

This returns a runId. Pass that runId to EVERY subsequent builder call — it is what
keeps the pipeline together, because the MCP transport no longer guarantees a stable
session (MCP 2026-07-28 / SEP-2567).

Next step: call list_skills + list_agents to check existing items.`,
    {},
    async () => {
      const runId = newRunId();
      const run = await openRun(runs, runId, userProps?.email ?? "");
      const runLine = run
        ? `runId: ${runId}\n\n⚠️ Pass "runId": "${runId}" as an argument to EVERY builder tool call from now on (list_skills, list_agents, run_bmad, confirm_plan, submit_for_review, submit_final, create_pull_request). Pipeline progress is tracked against it.`
        : `runId: unavailable (run store not reachable — pipeline steps fall back to per-session tracking)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `--- PIPELINE RUN ---\n${runLine}\n\n--- CONNECTION INFO ---\nTransport: ${transportType ?? "unknown"}\nUser: ${userProps?.email ?? "anonymous"}\n\n--- CLAUDE.md (Architecture Rules) ---\n\n${CLAUDE_MD}\n\n--- TEMPLATE.md (Code Patterns) ---\n\n${TEMPLATE_MD}\n\n--- NEXT STEP ---\nYou have read the project docs. Now:\n1. Call list_skills to see all existing skills\n2. Call list_agents to see all existing agents\n3. Ask the user clarifying questions if needed (run_bmad for discovery)\n4. Call confirm_plan with your proposed plan\n\nIMPORTANT: Before updating ANY existing file, use read_repo_file to read its current content. NEVER rewrite a file from memory.\nTo EDIT an existing file, prefer the "edits" field (anchored ops applied server-side) over re-sending the whole file as "content" — this is how you avoid dropping sections of large files.\n\nDo NOT generate code before confirm_plan is approved by the user.`,
          },
        ],
      };
    },
  );

  // ── Plan confirmation ─────────────────────────────────────────

  server.tool(
    "confirm_plan",
    `Present the plan to the user for approval.

Call this AFTER:
1. start_building (read CLAUDE.md + TEMPLATE.md)
2. list_skills + list_agents (checked existing items)
3. run_bmad (if discovery was needed)

Include:
- Data flow map
- Reused skills/actions
- New skills/actions/agents to create with type decisions
- Files with paths
- Access control (allowedGroups or public)

After calling this, STOP and wait for user approval ("yes").`,
    {
      plan: z.string().min(20).describe(
        "Full plan text including data flow map, file list, type decisions, and access control. " +
        "MUST include both registries (skill-runner and agent-runner) if adding new items. " +
        "MUST mention vault.ts changes if new actions need new env keys. " +
        "MUST include a Type Decision Checklist: for each new item, state why it's a Skill vs Action vs Agent."
      ),
      runId: z.string().optional().describe(RUN_ID_DESCRIPTION),
    },
    async ({ plan, runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);

      const missing = checkGates(resolved.store, "listSkills", "listAgents", "calledBmad");
      if (missing.length > 0) return missingSteps("confirm plan", missing, resolved.store);

      await resolved.store?.mark("confirmPlan");
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Plan registered. Now STOP and show the plan to the user:\n\n${plan}\n\nAsk: "Does this plan look correct? Should I proceed?"\nDo NOT generate code until the user says yes.`,
          },
        ],
      };
    },
  );

  // ── Submit for review (validates generated code) ─────────────────

  server.tool(
    "submit_for_review",
    `Submit generated code for validation.

Call this AFTER generating all files (skills, agents, registry.ts, ADR).
Validates:
- skill-runner/src/registry.ts is included with all new AND existing skills/agents
- agent-runner/src/registry.ts is included with all new AND existing actions
- Existing registry entries are NOT removed (checked by name, not just count)
- Import paths point to real files (existing or submitted)
- vault.ts integrity preserved (if modified)
- ADR file is included

If validation fails — fix and call again.
If validation passes — run BMAD reviews, then call submit_final.

DO NOT call submit_final or create_pull_request without passing submit_for_review first.

EDITING EXISTING FILES: for a change to an existing file (especially a large one), pass "edits" on that file instead of "content" — send only the changed lines with a unique anchor. The server applies them to the current file, so you never re-transmit (and never truncate) the whole file. Use "content" only for new files or a full rewrite.`,
    {
      files: filesParam(
        "All generated files including both registry.ts files and ADR. Each entry uses either content (full file) or edits (delta on an existing file).",
      ),
      runId: z.string().optional().describe(RUN_ID_DESCRIPTION),
    },
    async ({ files: rawFiles, runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);

      const missing = checkGates(resolved.store, "listSkills", "listAgents", "calledBmad", "confirmPlan");
      if (missing.length > 0) return missingSteps("submit for review", missing, resolved.store);

      let files: SubmissionFile[];
      try {
        files = await resolveFiles(normalizeFiles(rawFiles), makeBaseFetcher(fetchMainFile));
      } catch (err) {
        return { content: [{ type: "text" as const, text: `⛔ ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      const { errors, warnings } = await runContentValidation(files, fetchMainFile);

      if (errors.length > 0) {
        return {
          content: [{ type: "text" as const, text: `⛔ Validation failed. Fix and call submit_for_review again:\n\n${formatErrors({ errors, warnings })}` }],
          isError: true,
        };
      }

      await resolved.store?.mark("submitForReview");
      const warningText = warnings.length > 0 ? `\n\n⚠️ Warnings (address before finalizing):\n${warnings.map((w, i) => `${i + 1}. ${w}`).join("\n")}` : "";
      return {
        content: [{ type: "text" as const, text: `✅ Validation passed (${files.length} files, both registries OK, ADR included).${warningText}\n\nNow run ALL THREE BMAD reviews:\n1. run_bmad("bmad-review-adversarial-general") — review the code cynically\n2. run_bmad("bmad-review-edge-case-hunter") — find boundary conditions\n3. run_bmad("bmad-review-code-quality") — check naming, DRY, error handling, performance\n4. Fix any critical issues\n5. Call submit_final with all files + your review findings` }],
      };
    },
  );

  // ── Submit final (review findings gate) ────────────────────

  server.tool(
    "submit_final",
    `Submit final code with BMAD review findings for user approval.

Call this AFTER:
1. submit_for_review passed
2. You ran ALL THREE BMAD reviews (adversarial + edge-case + code-quality)
3. You fixed critical issues

Pass all files AND your review findings. The tool validates that findings are non-empty (you actually did the review).

After calling this, STOP and wait for user to approve. Then call create_pull_request.`,
    {
      files: filesParam(
        "All final files (with fixes applied). Each entry uses either content (full file) or edits (delta on an existing file — preferred for large files).",
      ),
      reviewFindings: z.string().min(20).describe("BMAD review findings summary: what was found by adversarial review, what was found by edge-case hunter, what was fixed. Must be non-trivial — if empty or too short, the review was not done properly."),
      runId: z.string().optional().describe(RUN_ID_DESCRIPTION),
    },
    async ({ files: rawFiles, reviewFindings, runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);

      const missing = checkGates(resolved.store, "listSkills", "listAgents", "calledBmad", "confirmPlan", "submitForReview");
      if (missing.length > 0) return missingSteps("submit final", missing, resolved.store);
      if (reviewFindings.trim().length < 20) {
        return {
          content: [{ type: "text" as const, text: `⛔ Review findings are too short. You must run ALL THREE BMAD reviews and report actual findings. Call run_bmad("bmad-review-adversarial-general"), run_bmad("bmad-review-edge-case-hunter"), and run_bmad("bmad-review-code-quality"), then submit real findings.` }],
          isError: true,
        };
      }

      let files: SubmissionFile[];
      try {
        files = await resolveFiles(normalizeFiles(rawFiles), makeBaseFetcher(fetchMainFile));
      } catch (err) {
        return { content: [{ type: "text" as const, text: `⛔ ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      // Re-run content validation on the final file set. Gates alone don't guarantee
      // the submitted files match what passed submit_for_review — defense against TOCTOU.
      const { errors, warnings } = await runContentValidation(files, fetchMainFile);
      if (errors.length > 0) {
        return {
          content: [{ type: "text" as const, text: `⛔ Final file set failed validation. The files passed to submit_final differ from what was validated earlier, or a regression slipped in. Fix and call submit_final again:\n\n${formatErrors({ errors, warnings })}` }],
          isError: true,
        };
      }

      const fileList = files.map((f) => `- ${f.path}`).join("\n");
      const warningText = warnings.length > 0 ? `\n\n⚠️ Warnings still present:\n${warnings.map((w, i) => `${i + 1}. ${w}`).join("\n")}` : "";
      await resolved.store?.mark("submitFinal");
      return {
        content: [{ type: "text" as const, text: `✅ Final submission ready (${files.length} files).${warningText}\n\nShow the user:\n1. **How it works** (non-technical, one paragraph)\n2. **Files created:**\n${fileList}\n3. **How to use** (example trigger phrase)\n4. **Review summary:**\n${reviewFindings}\n\nAsk: "All correct? Create the PR?"\nSTOP — wait for user confirmation.\nAfter "yes" — call create_pull_request with all ${files.length} files.` }],
      };
    },
  );

  // ── BMAD Discovery tools ───────────────────────────────────────

  server.tool(
    "run_bmad",
    `Run a BMAD workflow. Used for discovery (brainstorming, elicitation) and code review (adversarial, edge-case, code-quality).

Available commands:
- bmad-brainstorming — when idea is vague, facilitates creative ideation
- bmad-advanced-elicitation — when gaps found in dimensions check
- bmad-create-product-brief — for complex products, creates structured brief
- bmad-review-adversarial-general — cynical code review, finds architecture violations and logic bugs
- bmad-review-edge-case-hunter — finds crashes on empty input, division by zero, silent failures
- bmad-review-code-quality — reviews naming, complexity, DRY, error handling, performance, pattern compliance
- bmad-domain-research — when domain is unfamiliar
- bmad-technical-research — when technology is unfamiliar
- bmad-market-research — when competitive landscape needed
- bmad-help — when user is lost

Returns the full workflow with all steps. Follow the instructions in the returned workflow.md file.`,
    {
      command: z.enum(BMAD_COMMANDS as [string, ...string[]]).describe("BMAD command to run"),
      runId: z.string().optional().describe(RUN_ID_DESCRIPTION),
    },
    async ({ command, runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);
      await resolved.store?.mark("calledBmad");
      const files = getBmadWorkflow(command as BmadCommand);
      if (!files) {
        return { content: [{ type: "text" as const, text: `Unknown BMAD command: ${command}` }], isError: true };
      }
      const parts: string[] = [];
      const sortedKeys = Object.keys(files).sort((a, b) => {
        if (a === "workflow.md" || a === "SKILL.md") return -1;
        if (b === "workflow.md" || b === "SKILL.md") return 1;
        return a.localeCompare(b);
      });
      for (const key of sortedKeys) {
        if (key.endsWith(".yaml")) continue;
        parts.push(`--- FILE: ${key} ---\n\n${files[key]}`);
      }
      const helpCsv = getBmadConfig("_bmad/_config/bmad-help.csv");
      if (command === "bmad-help" && helpCsv) {
        parts.push(`--- FILE: _config/bmad-help.csv ---\n\n${helpCsv}`);
      }
      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    },
  );

  // ── Skill/Agent listing ────────────────────────────────────────

  server.tool(
    "list_skills",
    "List all available skills with their names and descriptions.",
    { runId: z.string().optional().describe(RUN_ID_DESCRIPTION) },
    async ({ runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);
      await resolved.store?.mark("listSkills");
      const list = skills.filter((s) => hasAccess(s.meta.allowedGroups, userGroups)).map((s) => {
        const parts = s.meta.name.split("_");
        const domain = parts[0];
        const rest = parts.slice(1).join("-");
        return {
          name: s.meta.name,
          description: s.meta.description,
          domain: s.meta.service,
          filePath: `_shared/skills/${domain}/${rest}.ts`,
          gather: s.meta.gather || [],
          adr: s.meta.adr || null,
          allowedGroups: s.meta.allowedGroups || [],
        };
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
    },
  );

  server.tool(
    "list_agents",
    "List all available agents with their names, descriptions, and which skills they use.",
    { runId: z.string().optional().describe(RUN_ID_DESCRIPTION) },
    async ({ runId }) => {
      const resolved = await gatesFor(runId);
      if (!resolved.ok) return gateError(resolved.message);
      await resolved.store?.mark("listAgents");
      const list = agents.filter((a) => hasAccess(a.meta.allowedGroups, userGroups)).map((a) => {
        const fileName = a.meta.name.replace(/_/g, "-");
        return {
          name: a.meta.name,
          description: a.meta.description,
          skills: a.meta.skills,
          filePath: `_shared/agents/${fileName}.ts`,
          adr: a.meta.adr || null,
          allowedGroups: a.meta.allowedGroups || [],
        };
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
    },
  );

  // ── Gateway services ─────────────────────────────────────────

  server.tool(
    "list_services",
    "List all deployed MCP services registered in the gateway. Returns service names, descriptions, URLs, skills, and agents.",
    {},
    async () => {
      if (!gatewayUrl) {
        return { content: [{ type: "text" as const, text: "GATEWAY_URL env var is not configured." }], isError: true };
      }
      try {
        const res = await fetch(`${gatewayUrl}/services`);
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to fetch services: ${res.status}` }], isError: true };
        }
        const data = await res.text();
        return { content: [{ type: "text" as const, text: data }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error fetching services: ${message}` }], isError: true };
      }
    },
  );

  // ── Current user identity (from Authentik OAuth) ──────────────────

  server.tool(
    "whoami",
    "Returns the current authenticated user's name, email, and groups (from Authentik). Use this when generating ADRs to fill the Author field.",
    {},
    async () => {
      if (!userProps?.email) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ name: "Unknown", email: "unknown", groups: [], authenticated: false }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ name: userProps.name ?? "Unknown", email: userProps.email, groups: userProps.groups ?? [], authenticated: true }) }] };
    },
  );

  // ── ADRs (bundled at build time) ──────────────────────────────

  server.tool(
    "list_adrs",
    "List all Architecture Decision Records (ADRs). Each ADR documents why a skill, agent, or MCP service was created, including the original user request.",
    {},
    async () => {
      const index = getAdrIndex();
      if (!index) {
        return { content: [{ type: "text" as const, text: "No ADRs found yet." }] };
      }
      return { content: [{ type: "text" as const, text: index }] };
    },
  );

  server.tool(
    "get_adr",
    "Get a specific Architecture Decision Record (ADR) by its filename. Returns the full ADR content including the original user request, brief, decision rationale, and data flow.",
    {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Only lowercase letters, numbers, and hyphens allowed").describe("ADR filename without extension, e.g. '001-preref-analyzer'"),
    },
    async ({ name }) => {
      const content = getAdr(name);
      if (!content) {
        return { content: [{ type: "text" as const, text: `ADR not found: ${name}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  const userGroups = userProps?.groups ?? [];

  // ── Register skills as tools ───────────────────────────────────

  const registeredNames = new Set<string>();
  for (const skill of skills) {
    if (!hasAccess(skill.meta.allowedGroups, userGroups)) continue;
    if (registeredNames.has(skill.meta.name)) {
      throw new Error(`Duplicate skill name: "${skill.meta.name}". Each skill must have a unique name.`);
    }
    registeredNames.add(skill.meta.name);
    let description = skill.meta.description;
    if (skill.meta.gather && skill.meta.gather.length > 0) {
      description += "\nBEFORE calling this skill, use your available MCP tools to gather:\n";
      description += skill.meta.gather.map((g: string, i: number) => `${i + 1}. ${g}`).join("\n");
      description += "\nPass the gathered data as JSON input.";
    }
    if (skill.meta.inputSchema) {
      description += `\n\nExpected input JSON structure:\n${JSON.stringify(skill.meta.inputSchema, null, 2)}`;
    }

    server.tool(
      skill.meta.name,
      description,
      { input: z.string().describe("JSON string with skill input parameters") },
      async ({ input }: { input: string }) => {
        const start = Date.now();
        const logger = createSkillLogger(secrets ?? {}, { name: skill.meta.name, kind: "skill", user: userProps?.email });
        try {
          const parsed = JSON.parse(input);
          const result = await skill.execute(parsed, { env: {} });
          logger.info("Skill invoked", { status: "ok", duration_ms: String(Date.now() - start) });
          await logger.flush();
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Skill failed", { status: "error", duration_ms: String(Date.now() - start), error: message });
          await logger.flush();
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  // ── Register agents as tools ───────────────────────────────────

  for (const agent of agents) {
    if (!hasAccess(agent.meta.allowedGroups, userGroups)) continue;
    if (registeredNames.has(agent.meta.name)) {
      throw new Error(`Duplicate name: "${agent.meta.name}". Skills and agents share a namespace — each must have a unique name.`);
    }
    registeredNames.add(agent.meta.name);

    let description = `[Agent] ${agent.meta.description}`;
    description += `\nOrchestrates skills: ${agent.meta.skills.join(", ")}`;

    const gatherSteps: string[] = agent.meta.gather ?? [];
    if (gatherSteps.length === 0) {
      for (const skillName of agent.meta.skills) {
        const skill = skills.find((s) => s.meta.name === skillName);
        if (skill?.meta.gather) {
          gatherSteps.push(...skill.meta.gather);
        }
      }
    }
    if (gatherSteps.length > 0) {
      description += "\n\nBEFORE calling this agent, use your available MCP tools to gather:\n";
      description += [...new Set(gatherSteps)].map((g, i) => `${i + 1}. ${g}`).join("\n");
      description += "\nPass the gathered data as JSON input.";
    }

    server.tool(
      agent.meta.name,
      description,
      { input: z.string().describe("JSON string with agent input parameters") },
      async ({ input }: { input: string }) => {
        const start = Date.now();
        const logger = createSkillLogger(secrets ?? {}, { name: agent.meta.name, kind: "agent", user: userProps?.email });
        try {
          const parsed = JSON.parse(input);
          const result = await agent.execute(parsed, { env: {} });
          logger.info("Agent invoked", { status: "ok", duration_ms: String(Date.now() - start) });
          await logger.flush();
          return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Agent failed", { status: "error", duration_ms: String(Date.now() - start), error: message });
          await logger.flush();
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }
}
