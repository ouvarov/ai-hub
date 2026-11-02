import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGitHubClient } from "@shared/lib/github";
import { formatBugReport } from "@shared/skills/github/format-bug-report";
import { formatEnhancementReport } from "@shared/skills/github/format-enhancement-report";
import {
  checkGates,
  recordRunPullRequest,
  resolveGateStore,
  resolveRunStrict,
  RUN_ID_DESCRIPTION,
  type BuilderRunsNamespace,
  type GateStore,
} from "../builder-gates";
import {
  SELF_MERGE_ALLOWED_PREFIXES,
  evaluateMergeReadiness,
  formatMergePlan,
} from "./merge-readiness";
import { reviewNextStep } from "./review-next-step";
import { skills, agents } from "../registry";
import { actions as liveActions } from "../../../agent-runner/src/registry";
import { KNOWN_VAULT_KEYS, KNOWN_REGISTRY } from "../vault-keys.generated";
import { validateSubmission, formatErrors, extractDefineExports, type SubmissionFile } from "./validate-submission";
import { deriveRegistry, sameSemantics, type NewRegistryEntry } from "./derive-registry";
import {
  resolveFiles,
  filesParam,
  normalizeFiles,
  stringArrayParam,
  normalizeStringArray,
} from "./resolve-files";

const REPO_OWNER = "acme";
const REPO_NAME = "ai-hub";

// ── Auto-regenerate vault-keys.generated.ts from registry + vault files ──

const VAULT_TS_PATH = "_shared/lib/vault.ts";
const SKILL_REGISTRY_PATH = "skill-runner/src/registry.ts";
const ACTION_REGISTRY_PATH = "agent-runner/src/registry.ts";
const VAULT_KEYS_PATH = "skill-runner/src/vault-keys.generated.ts";

/** Parse UPPER_SNAKE_CASE keys from the return block of loadAIHubSecrets() */
function parseVaultKeys(vaultTsContent: string): string[] {
  const match = vaultTsContent.match(/return\s*\{([^}]+)\}\s*;\s*\n\}/s);
  if (!match) return [];
  const keys: string[] = [];
  for (const m of match[1].matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:/gm)) {
    keys.push(m[1]);
  }
  return keys;
}

/** Parse imports and array entries from a registry file */
function parseRegistryContent(content: string) {
  const imports: string[] = [];
  const importPaths: string[] = [];
  for (const m of content.matchAll(/import\s*\{\s*([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ") && n !== "type");
    for (const name of names) imports.push(name);
    if (m[2].startsWith("@shared/")) importPaths.push(m[2]);
  }
  const arrays: Record<string, string[]> = {};
  for (const m of content.matchAll(/export\s+const\s+(\w+)[^=]*=\s*\[([^\]]*)\]/gs)) {
    arrays[m[1]] = m[2].replace(/\/\/[^\n]*/g, "").split(",").map((e) => e.trim()).filter(Boolean);
  }
  return { imports, importPaths: [...new Set(importPaths)], arrays };
}

function unionPreserveOrder(primary: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...primary, ...extra]) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

/**
 * Generate vault-keys.generated.ts from vault.ts + both registries.
 * Registry metadata is the union of main-HEAD and submitted content — it NEVER shrinks,
 * so even if a bad PR somehow slips through content validation, the baseline for the
 * next PR stays intact.
 */
function generateVaultKeysContent(
  vaultTs: string,
  skillRegistryTs: string,
  actionRegistryTs: string,
  mainSkillRegistryTs: string,
  mainActionRegistryTs: string,
): string {
  const vaultKeys = parseVaultKeys(vaultTs);
  const subSkill = parseRegistryContent(skillRegistryTs);
  const subAction = parseRegistryContent(actionRegistryTs);
  const mainSkill = parseRegistryContent(mainSkillRegistryTs);
  const mainAction = parseRegistryContent(mainActionRegistryTs);

  const registryMeta = {
    skillEntries: unionPreserveOrder(mainSkill.arrays.skills ?? [], subSkill.arrays.skills ?? []),
    agentEntries: unionPreserveOrder(mainSkill.arrays.agents ?? [], subSkill.arrays.agents ?? []),
    actionEntries: unionPreserveOrder(mainAction.arrays.actions ?? [], subAction.arrays.actions ?? []),
    skillRunnerImportPaths: unionPreserveOrder(mainSkill.importPaths, subSkill.importPaths),
    actionRunnerImportPaths: unionPreserveOrder(mainAction.importPaths, subAction.importPaths),
  };
  return `/**\n * Known Vault secret keys and registry metadata, parsed at build time.\n * Re-generate with: node skill-runner/scripts/bundle-docs.js\n */\nexport const KNOWN_VAULT_KEYS: string[] = ${JSON.stringify(vaultKeys)};\n\n/**\n * Registry metadata — known entry names and import paths from both registries.\n * Used by submit_for_review to detect removed entries and invalid imports.\n */\nexport const KNOWN_REGISTRY = ${JSON.stringify(registryMeta)} as const;\n`;
}

/**
 * Collect the new registry entries a submission introduces, so the server can
 * additively insert them into main's registry (preserving comments) instead of
 * trusting the LLM-regenerated file. `registry` selects which file we are building:
 * the skill-runner registry holds skills + agents; the agent-runner registry holds
 * actions.
 */
function collectNewEntries(
  files: { path: string; content: string }[],
  registry: "skill" | "action",
): NewRegistryEntry[] {
  const out: NewRegistryEntry[] = [];
  for (const f of files) {
    if (!f.path.endsWith(".ts")) continue;
    const importPath = f.path.replace(/^_shared\//, "@shared/").replace(/\.ts$/, "");
    if (registry === "skill") {
      if (f.path.startsWith("_shared/skills/")) {
        for (const name of extractDefineExports(f.content, "Skill")) out.push({ exportName: name, importPath, arrayName: "skills" });
      }
      if (f.path.startsWith("_shared/agents/")) {
        for (const name of extractDefineExports(f.content, "Agent")) out.push({ exportName: name, importPath, arrayName: "agents" });
      }
    } else {
      if (f.path.startsWith("_shared/actions/")) {
        for (const name of extractDefineExports(f.content, "Action")) out.push({ exportName: name, importPath, arrayName: "actions" });
      }
    }
  }
  return out;
}

export interface UserProps {
  email?: string;
  name?: string;
  groups?: string[];
}

export function registerGitHubTools(
  server: McpServer,
  secrets: Record<string, string>,
  userProps?: UserProps,
  session?: GateStore,
  runs?: BuilderRunsNamespace,
) {
  const appId = secrets.GITHUB_APP_ID;
  const installationId = secrets.GITHUB_APP_INSTALLATION_ID;
  const privateKey = secrets.GITHUB_APP_PRIVATE_KEY;

  const configured = !!(appId && installationId && privateKey);

  // ── Read repo file (builder-only, not exposed to end users) ─────
  server.tool(
    "read_repo_file",
    `Read a file from the ai-hub repository on GitHub (main branch by default).

Builder-only tool. Use this to read existing files before updating them — e.g. registry.ts, vault.ts, or any source file.
NEVER rewrite a file without reading it first.
Do NOT use this tool to show file contents to the user — it is for the builder pipeline only.`,
    {
      path: z.string().describe('File path relative to repo root, e.g. "skill-runner/src/registry.ts"'),
      ref: z.string().optional().describe('Git ref (branch/tag/sha). Default: "main"'),
    },
    async ({ path, ref }) => {
      if (!configured) {
        return {
          content: [{ type: "text" as const, text: "GitHub App credentials are not configured." }],
          isError: true,
        };
      }
      try {
        const gh = createGitHubClient({ appId, installationId, privateKey });
        const content = await gh.getFileContent(REPO_OWNER, REPO_NAME, path, ref ?? "main");
        if (content === null) {
          return {
            content: [{ type: "text" as const, text: `File not found: ${path} (ref: ${ref ?? "main"})` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to read file: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "create_pull_request",
    `Create a Pull Request in the ai-hub repository with generated code files.

Use this as the FINAL step of the Builder flow — after the user approves the plan and generated code.

Provide ALL files that need to be created or updated. Each file needs its full path (relative to repo root) plus either "content" (full file) or "edits" (a delta on an existing file).

For a change to an existing file — especially a large one — use "edits" (anchored ops applied to the current file on the server), NOT "content". This is what prevents dropped/truncated sections on big files.

The PR will be created from a GitHub App bot account — no user GitHub token needed.`,
    {
      branch: z
        .string()
        .regex(/^[a-z0-9][a-z0-9/_-]*$/, "Lowercase, hyphens, slashes allowed")
        .describe('Branch name, e.g. "feat/design-checker-agent"'),
      title: z.string().describe("PR title — short, under 70 chars"),
      body: z.string().describe("PR body in markdown — summary, what was created, how to test"),
      files: filesParam("Files to create or update in the PR. Each entry uses content (full file) or edits (delta on an existing file)."),
      runId: z.string().optional().describe(RUN_ID_DESCRIPTION),
    },
    async ({ branch, title, body, files: rawFiles, runId }) => {
      // Enforce pipeline gates — all 6 must be passed
      {
        const resolved = await resolveGateStore({ runId, runs, session, user: userProps?.email });
        if (!resolved.ok) {
          return { content: [{ type: "text" as const, text: `⛔ ${resolved.message}` }], isError: true };
        }
        const missing = checkGates(
          resolved.store,
          "listSkills", "listAgents", "calledBmad", "confirmPlan", "submitForReview", "submitFinal",
        );
        const staleSessionHint = resolved.store?.scope.startsWith("run:")
          ? "Complete all pipeline steps first — they are idempotent, so re-calling a missing one is safe."
          : "No runId was passed, so gates are tracked per transport session — which MCP 2026-07-28 no longer keeps stable. Call start_building and pass its runId to every builder tool.";
        if (missing.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `\u26d4 Cannot create PR — pipeline gates not passed.\n\nMissing:\n${missing.map((m) => `- ${m}`).join("\n")}\n\n${staleSessionHint}`,
              },
            ],
            isError: true,
          };
        }
      }

      if (!configured) {
        return {
          content: [
            {
              type: "text" as const,
              text: "GitHub App credentials are not configured. Ask DevOps to sync Vault secrets to skill-runner wrangler secrets (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY).",
            },
          ],
          isError: true,
        };
      }

      try {
        const gh = createGitHubClient({ appId, installationId, privateKey });

        // Resolve edit-mode entries against main HEAD into concrete { path, content }.
        // Editing an existing large file sends only a delta, so the model never
        // re-transmits (and never truncates) the whole file. Content-mode entries
        // pass through unchanged; everything below validates the resolved content.
        let files: SubmissionFile[];
        try {
          files = await resolveFiles(normalizeFiles(rawFiles), (path) => gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main"));
        } catch (err) {
          return { content: [{ type: "text" as const, text: `⛔ ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }

        // Last-line content validation. Gates say "a validation happened earlier",
        // but they don't fingerprint the files that passed — re-run the same checks
        // on whatever is actually about to land in the PR.
        const preCheck = await validateSubmission(files, {
          liveSkillsCount: skills.length,
          liveAgentsCount: agents.length,
          liveActionsCount: liveActions.length,
          knownVaultKeys: KNOWN_VAULT_KEYS,
          knownRegistry: KNOWN_REGISTRY,
          fetchMainFile: async (path) => await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main"),
        });
        if (preCheck.errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `⛔ create_pull_request blocked — final content validation failed:\n\n${formatErrors(preCheck)}\n\nFix the files and call submit_final again before retrying create_pull_request.` }],
            isError: true,
          };
        }

        // ── Preserve human comments in registry files ──
        // The submitted registry is LLM-regenerated and may have dropped section
        // comments / doc notes. Re-derive it from main HEAD by ADDING only the new
        // imports + entries, keeping every existing line intact. Trust the derived
        // file ONLY when it is semantically identical to the submitted one (a pure
        // add); renames/removals/reorders fall back to the submitted content.
        const registryDerivationTargets: { path: string; registry: "skill" | "action" }[] = [
          { path: SKILL_REGISTRY_PATH, registry: "skill" },
          { path: ACTION_REGISTRY_PATH, registry: "action" },
        ];
        for (const { path, registry } of registryDerivationTargets) {
          const idx = files.findIndex((f) => f.path === path);
          if (idx < 0) continue;
          const main = await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main");
          if (main === null) continue; // registry didn't exist on main — leave submitted as-is
          const derived = deriveRegistry(main, collectNewEntries(files, registry));
          if (sameSemantics(derived, files[idx].content)) {
            files[idx].content = derived;
          }
        }

        // Auto-regenerate vault-keys.generated.ts if registries or vault.ts changed.
        // Uses union(main HEAD, submitted) so KNOWN_REGISTRY never shrinks.
        const hasRegistryOrVault = files.some((f) =>
          f.path === VAULT_TS_PATH || f.path === SKILL_REGISTRY_PATH || f.path === ACTION_REGISTRY_PATH
        );
        if (hasRegistryOrVault) {
          const getSubmittedOrMain = async (path: string) => {
            const submitted = files.find((f) => f.path === path);
            if (submitted) return submitted.content;
            return (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main")) ?? "";
          };
          const getMain = async (path: string) =>
            (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main")) ?? "";

          const [vaultTs, skillReg, actionReg, mainSkillReg, mainActionReg] = await Promise.all([
            getSubmittedOrMain(VAULT_TS_PATH),
            getSubmittedOrMain(SKILL_REGISTRY_PATH),
            getSubmittedOrMain(ACTION_REGISTRY_PATH),
            getMain(SKILL_REGISTRY_PATH),
            getMain(ACTION_REGISTRY_PATH),
          ]);
          const vaultKeysContent = generateVaultKeysContent(vaultTs, skillReg, actionReg, mainSkillReg, mainActionReg);
          const existing = files.findIndex((f) => f.path === VAULT_KEYS_PATH);
          if (existing >= 0) {
            files[existing].content = vaultKeysContent;
          } else {
            files.push({ path: VAULT_KEYS_PATH, content: vaultKeysContent });
          }
        }

        const result = await gh.createPullRequest({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          branch,
          base: "main",
          title,
          body,
          files,
        });

        // Bind the PR to this run. confirm_merge merges only what it finds here,
        // which is what stops a run being pointed at somebody else's PR.
        await recordRunPullRequest(runs, runId, {
          number: result.prNumber,
          branch: result.branch,
          url: result.prUrl,
          createdAt: Date.now(),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  prUrl: result.prUrl,
                  prNumber: result.prNumber,
                  branch: result.branch,
                  message: `PR #${result.prNumber} created successfully!`,
                  nextStep:
                    `Do NOT stop yet — every PR gets a ReviewBot review AND a CI run. Poll get_pr_review (prNumber: ${result.prNumber}) every ~30s (event-driven, ~5-minute cap). It reads the ReviewBot review, comments, AND CI check status via the builder's own GitHub App — no external GitHub connector needed.\n` +
                    `Handle CI first: if checks.stillRunning, wait and poll again; if checks.failed > 0, read the returned failureLogs, fix the cause, and push_fix_to_pr on the returned "branch" (a new commit re-runs CI) — repeat until checks.allPassed.\n` +
                    `Then address every actionable ReviewBot comment the same way (fix + push_fix_to_pr; skip nits with a brief reason) and keep following get_pr_review's nextStep. ` +
                    `Once CI is green and ReviewBot's latest review is APPROVED, this run can merge its own PR with confirm_merge (${runId ? `runId: ${runId}` : "it needs the runId from start_building"}) — offer that to the user instead of sending them to find a maintainer.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to create PR: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "get_pr_review",
    `Read an ai-hub PR's CI check status, ReviewBot bot review, and comments.

Use this in Phase 7 (after create_pull_request) to poll for CI + the ReviewBot review, then again after each push_fix_to_pr to confirm CI is green and nothing new is flagged.

Reads via the builder's own GitHub App (which now has the "Checks: Read" scope) — NO external GitHub connector or user GitHub account needed. This is how non-technical users on Claude Web get the review-and-fix loop.

Returns:
- "checks": { runs[], stillRunning, failed, allPassed } — CI status on the PR head commit. allPassed is false when zero checks have run (an empty check set is NOT a green build).
- "failureLogs": tail of each failed job's log (only populated when checks.failed > 0), so you can fix without leaving the tool.
- "reviewBotCommentCount" + "comments" (reviews + inline + general, oldest-first, each flagged isReviewBot).
- "branch" (pass to push_fix_to_pr), "headSha", PR "state".

Polling: resolve CI first (wait while stillRunning; fix + push_fix_to_pr while failed), then address the ReviewBot review (event-driven, ~5-minute cap). Follow the "nextStep" field. Finish when CI is green and the review is addressed.`,
    {
      prNumber: z
        .number()
        .int()
        .positive()
        .describe("PR number returned by create_pull_request"),
    },
    async ({ prNumber }) => {
      if (!configured) {
        return {
          content: [{ type: "text" as const, text: "GitHub App credentials are not configured." }],
          isError: true,
        };
      }
      try {
        const gh = createGitHubClient({ appId, installationId, privateKey });
        const review = await gh.getPullRequestReview(REPO_OWNER, REPO_NAME, prNumber);
        const c = review.checks;

        // If CI has failed, pull the tail of each failed job's log so the caller can see
        // what to fix without leaving the tool.
        let failureLogs: Awaited<ReturnType<typeof gh.getFailedCheckLogs>> = [];
        if (c.failed > 0) {
          try {
            failureLogs = await gh.getFailedCheckLogs(REPO_OWNER, REPO_NAME, c.runs);
          } catch {
            failureLogs = [];
          }
        }

        const nextStep = reviewNextStep({
          branch: review.branch,
          checks: c,
          reviewBotCommentCount: review.reviewBotCommentCount,
          latestReviewBotReviewState: review.latestReviewBotReviewState,
          latestReviewBotReviewAt: review.latestReviewBotReviewAt,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, ...review, failureLogs, nextStep }, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to read PR review: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "push_fix_to_pr",
    `Push fix commits to an existing PR branch in ai-hub.

Use this when the user reviewed a PR and wants to fix something — e.g. "fix the bug in line 42" or "add missing import".

Automatically merges main into the branch before pushing if the branch is behind. If there are merge conflicts, resolves them by combining main's tree with branch-specific changes and your fix files. You never need to handle conflicts manually.

Supports file renames: add the new path in \`files\` and the old path in \`deletedFiles\`.

You read the current file from the PR branch, apply the fix, and push a new commit. The PR automatically updates.

Fixing a skill/agent/action that was INTRODUCED BY THIS PR is supported — that is an edit, not a new entry. Adding a brand-new skill/agent/action still requires the full builder flow.

For a change to an existing file, prefer "edits" (anchored ops applied to the current branch file on the server) over re-sending full "content" — this avoids truncating large files.`,
    {
      branch: z
        .string()
        .describe('The PR branch name to push to, e.g. "feat/slack-reader"'),
      commitMessage: z
        .string()
        .describe("Short commit message describing the fix"),
      files: filesParam(
        "Files to create or update in the PR (can be empty if only deleting). Each entry uses content (full file) or edits (delta on an existing file).",
        { allowEmpty: true },
      ),
      deletedFiles: stringArrayParam(
        "File paths to delete from the branch (for renames: delete old path, add new path in files).",
      ),
    },
    async ({ branch, commitMessage, files: rawFiles, deletedFiles: rawDeletedFiles }) => {
      let deletedFiles: string[] | undefined;
      try {
        deletedFiles = normalizeStringArray(rawDeletedFiles);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `⛔ deletedFiles: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      if (!configured) {
        return {
          content: [{ type: "text" as const, text: "GitHub App credentials are not configured." }],
          isError: true,
        };
      }

      try {
        const gh = createGitHubClient({ appId, installationId, privateKey });

        // Resolve edit-mode entries against the PR branch (falling back to main) so a
        // fix to a large existing file sends only a delta instead of the whole file.
        let files: SubmissionFile[];
        try {
          files = await resolveFiles(normalizeFiles(rawFiles, { allowEmpty: true }), async (path) =>
            (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, branch)) ??
            (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main")),
          );
        } catch (err) {
          return { content: [{ type: "text" as const, text: `⛔ ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }

        // Partial-mode validation. Fix-pushes intentionally touch a subset of files
        // so the "full" validator over-triggers — but we still enforce overwrite
        // detection, type-decision rules, conventions, and refuse to let a fix push
        // sneak in a new defineSkill/defineAgent/defineAction.
        if (files.length > 0) {
          const preCheck = await validateSubmission(files, {
            liveSkillsCount: skills.length,
            liveAgentsCount: agents.length,
            liveActionsCount: liveActions.length,
            knownVaultKeys: KNOWN_VAULT_KEYS,
            knownRegistry: KNOWN_REGISTRY,
            fetchMainFile: async (path) => await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main"),
            fetchBranchFile: async (path) => await gh.getFileContent(REPO_OWNER, REPO_NAME, path, branch),
            mode: "fix",
          });
          if (preCheck.errors.length > 0) {
            return {
              content: [{ type: "text" as const, text: `⛔ push_fix_to_pr blocked — fix-push validation failed:\n\n${formatErrors(preCheck)}\n\nFix the files and retry. For new skills/agents/actions use the full builder flow, not push_fix_to_pr.` }],
              isError: true,
            };
          }
        }

        // Auto-regenerate vault-keys.generated.ts if registries or vault.ts changed.
        // Baseline for KNOWN_REGISTRY is always main HEAD (unioned with submitted) so a
        // fix-push that accidentally drops an entry can't erode the repo's baseline.
        const hasRegistryOrVault = files.some((f) =>
          f.path === VAULT_TS_PATH || f.path === SKILL_REGISTRY_PATH || f.path === ACTION_REGISTRY_PATH
        );
        if (hasRegistryOrVault) {
          const getSubmittedOrRef = async (path: string) => {
            const submitted = files.find((f) => f.path === path);
            if (submitted) return submitted.content;
            return (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, branch))
              ?? (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main"))
              ?? "";
          };
          const getMain = async (path: string) =>
            (await gh.getFileContent(REPO_OWNER, REPO_NAME, path, "main")) ?? "";

          const [vaultTs, skillReg, actionReg, mainSkillReg, mainActionReg] = await Promise.all([
            getSubmittedOrRef(VAULT_TS_PATH),
            getSubmittedOrRef(SKILL_REGISTRY_PATH),
            getSubmittedOrRef(ACTION_REGISTRY_PATH),
            getMain(SKILL_REGISTRY_PATH),
            getMain(ACTION_REGISTRY_PATH),
          ]);
          const vaultKeysContent = generateVaultKeysContent(vaultTs, skillReg, actionReg, mainSkillReg, mainActionReg);
          const existing = files.findIndex((f) => f.path === VAULT_KEYS_PATH);
          if (existing >= 0) {
            files[existing].content = vaultKeysContent;
          } else {
            files.push({ path: VAULT_KEYS_PATH, content: vaultKeysContent });
          }
        }

        const result = await gh.pushFix({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          branch,
          commitMessage,
          files,
          deletedFiles,
        });

        const response: Record<string, unknown> = {
          success: true,
          branch: result.branch,
          commitSha: result.commitSha,
          message: `Fix pushed to ${result.branch} (${result.commitSha.slice(0, 7)})`,
        };
        if (result.mergedBase) {
          response.mergedBase = true;
          response.mergeMessage = "Automatically merged main into branch before pushing fix.";
        }
        if (result.resolvedFiles?.length) {
          response.resolvedFiles = result.resolvedFiles;
          response.resolveMessage = "Resolved merge conflicts in these files.";
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to push fix: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "create_github_issue",
    `Create an issue in the ai-hub repository — a bug report or an enhancement/proposal.

Set issueType:
- "bug" (default) — something failed or is broken. Requires userGoal + errorDetails.
- "enhancement" — a proposal for a new feature or improvement. Requires title + problem + proposedSolution.

In Cowork, ask the user which type first (AskUserQuestion: 🐛 Bug vs ✨ Enhancement), then collect the matching fields. Claude provides the context — the tool formats it into a structured issue and creates it via the bot account.

Reporter identity is resolved automatically from OAuth (Authentik). If it shows "unknown", the OAuth flow may not be working.`,
    {
      issueType: z
        .enum(["bug", "enhancement"])
        .default("bug")
        .describe('Issue type: "bug" (default) or "enhancement". Determines required fields + label.'),
      // Bug fields (required when issueType = "bug")
      userGoal: z.string().optional().describe('[bug] What the user was trying to do when it broke'),
      failedStep: z
        .string()
        .optional()
        .describe('[bug] Which Builder step failed, e.g. "Step 5 — Generate code"'),
      errorDetails: z.string().optional().describe("[bug] Error messages, stack traces, tool call failures"),
      contextSummary: z
        .string()
        .optional()
        .describe("[bug] Summary of what was attempted before the failure"),
      affectedFiles: z
        .array(z.string())
        .optional()
        .describe("[bug] Files that were being created or modified"),
      userNotes: z.string().optional().describe("[bug] Any additional notes from the user"),
      // Enhancement fields (required when issueType = "enhancement")
      title: z.string().optional().describe("[enhancement] Short summary of the proposal"),
      problem: z.string().optional().describe("[enhancement] What gap or friction exists today"),
      proposedSolution: z.string().optional().describe("[enhancement] What should be built"),
      expectedOutcome: z
        .string()
        .optional()
        .describe("[enhancement] What changes for the user once shipped"),
    },
    async (input) => {
      if (!configured) {
        return {
          content: [
            {
              type: "text" as const,
              text: "GitHub App credentials are not configured. Cannot create issue.",
            },
          ],
          isError: true,
        };
      }

      try {
        const reporter = userProps?.email ? { email: userProps.email, name: userProps.name ?? "Unknown" } : undefined;

        let report: { title: string; body: string };
        let labels: string[];
        if (input.issueType === "enhancement") {
          if (!input.title || !input.problem || !input.proposedSolution) {
            return {
              content: [{ type: "text" as const, text: 'Enhancement issues require "title", "problem", and "proposedSolution".' }],
              isError: true,
            };
          }
          report = await formatEnhancementReport.execute({
            title: input.title,
            problem: input.problem,
            proposedSolution: input.proposedSolution,
            expectedOutcome: input.expectedOutcome,
            reporter,
          });
          labels = ["enhancement", "auto-reported"];
        } else {
          if (!input.userGoal || !input.errorDetails) {
            return {
              content: [{ type: "text" as const, text: 'Bug issues require "userGoal" and "errorDetails".' }],
              isError: true,
            };
          }
          report = await formatBugReport.execute({
            userGoal: input.userGoal,
            errorDetails: input.errorDetails,
            failedStep: input.failedStep,
            contextSummary: input.contextSummary,
            affectedFiles: input.affectedFiles,
            userNotes: input.userNotes,
            reporter,
          });
          labels = ["bug", "auto-reported"];
        }

        const gh = createGitHubClient({ appId, installationId, privateKey });
        const result = await gh.createIssue({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          title: report.title,
          body: report.body,
          labels,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  issueUrl: result.issueUrl,
                  issueNumber: result.issueNumber,
                  message: `Issue #${result.issueNumber} created successfully!`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to create issue: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Confirm and merge (the run's own PR, and only that one) ─────
  server.tool(
    "confirm_merge",
    `Merge THIS run's pull request, after the user confirms it in words.

Call this as the last step, once get_pr_review reports CI green and a standing ReviewBot approval.

Two calls:
1. WITHOUT "confirm" — returns what the merge will do: files, line counts, and which services it deploys to PRODUCTION. Show that to the user verbatim and ask whether to merge. Then STOP and wait.
2. WITH "confirm" set to the PR number the user typed back — performs the merge.

It refuses unless every one of these holds: the PR was opened by THIS run, the caller owns the run, all pipeline gates passed, the PR is open and builder-authored, CI is green on the current head, ReviewBot's latest review is APPROVED, and the diff stays inside what you wrote (${SELF_MERGE_ALLOWED_PREFIXES.join(", ")}, plus the registry and generated files) — never the code that decides whether a merge is allowed.

It cannot merge a PR this run did not create — there is deliberately no PR-number parameter. A PR from someone else, or from another run, needs a human.`,
    {
      runId: z.string().describe(RUN_ID_DESCRIPTION + " Required here — it identifies which PR may be merged."),
      confirm: z
        .string()
        .optional()
        .describe(
          "The PR number, exactly as the user typed it back (e.g. \"451\"). Omit on the first call to get the preview. " +
            "Never fill this in on the user's behalf — merging deploys to production.",
        ),
    },
    async ({ runId, confirm }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      if (!configured) return fail("GitHub App credentials are not configured.");

      const resolved = await resolveRunStrict({ runId, runs, user: userProps?.email });
      if (!resolved.ok) return fail(`⛔ ${resolved.message}`);
      const record = resolved.record;

      if (!record.pr) {
        return fail(
          "⛔ This run has not created a pull request, so there is nothing to merge. Call create_pull_request first.",
        );
      }

      try {
        const gh = createGitHubClient({ appId, installationId, privateKey });
        // Read fresh rather than trusting an earlier get_pr_review: the head can move
        // between the preview and the confirmation, and a stale read is exactly how an
        // unreviewed commit would reach production.
        const [review, fileList] = await Promise.all([
          gh.getPullRequestReview(REPO_OWNER, REPO_NAME, record.pr.number),
          gh.getPullRequestFiles(REPO_OWNER, REPO_NAME, record.pr.number),
        ]);

        const readiness = evaluateMergeReadiness({
          runPr: { number: record.pr.number, branch: record.pr.branch },
          runOwnerEmail: record.user || undefined,
          callerEmail: userProps?.email,
          missingGates: checkGates(
            { scope: `run:${runId}`, gates: record.gates, mark: async () => {} },
            "listSkills", "listAgents", "calledBmad", "confirmPlan", "submitForReview", "submitFinal",
          ),
          pr: {
            state: review.state,
            authorLogin: review.authorLogin,
            headSha: review.headSha,
            checksAllPassed: review.checks.allPassed,
            checksStillRunning: review.checks.stillRunning,
            checksFailed: review.checks.failed,
            checkCount: review.checks.runs.length,
            latestReviewBotReviewState: review.latestReviewBotReviewState,
            latestReviewBotReviewAt: review.latestReviewBotReviewAt,
          },
          files: fileList.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
          filesTruncated: fileList.truncated,
          confirmation: confirm,
        });

        if (readiness.status === "refused") {
          return fail(`⛔ Cannot merge — ${readiness.reason}`);
        }

        if (readiness.status === "needs_confirmation") {
          const typed = confirm?.trim();
          const mismatch = typed
            ? `\n\n"${typed}" is not the PR number. Ask again.`
            : "";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    awaitingConfirmation: true,
                    prUrl: record.pr.url,
                    summary: formatMergePlan(readiness.plan),
                    nextStep:
                      "Show the summary to the user word for word, including what deploys. " +
                      `Ask them to type ${readiness.plan.prNumber} to merge. Then STOP — do not call confirm_merge again ` +
                      "until they have answered, and never type the number for them." + mismatch,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const { plan } = readiness;
        const merged = await gh.mergePullRequest({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          prNumber: plan.prNumber,
          sha: plan.headSha,
          commitTitle: `Merge PR #${plan.prNumber} (confirmed by ${record.user || "unknown"})`,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: merged.merged,
                  prNumber: plan.prNumber,
                  prUrl: record.pr.url,
                  mergeSha: merged.sha,
                  deployed: plan.deploys,
                  message: merged.message,
                  nextStep:
                    plan.deploys.length > 0
                      ? `Merged. deploy.yml is now deploying ${plan.deploys.join(", ")} to production — tell the user, and that it takes a few minutes.`
                      : "Merged. Nothing deploys from this change.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 409 is GitHub refusing because the head moved since we read it — the guard working.
        if (message.includes("(409)")) {
          return fail(
            `⛔ The PR changed while you were confirming, so nothing was merged. ` +
              `Call get_pr_review to see the new head, then start confirm_merge again.`,
          );
        }
        return fail(`Failed to merge: ${message}`);
      }
    },
  );
}
