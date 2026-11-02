export interface SubmissionFile {
  path: string;
  content: string;
}

/** Structural shape of the registry metadata the validator needs. The generated
 *  KNOWN_REGISTRY (a readonly literal tuple) satisfies this structurally, and it
 *  keeps the validator decoupled from the generated file's exact literal type. */
export interface KnownRegistry {
  skillEntries: readonly string[];
  agentEntries: readonly string[];
  actionEntries: readonly string[];
  skillRunnerImportPaths: readonly string[];
  actionRunnerImportPaths: readonly string[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export interface ValidateOptions {
  liveSkillsCount: number;
  liveAgentsCount: number;
  liveActionsCount: number;
  knownVaultKeys: readonly string[];
  knownRegistry: KnownRegistry;
  /** When provided, validator fetches main-HEAD of existing files to detect gutting.
   *  Return null if the file does not exist on main. */
  fetchMainFile?: (path: string) => Promise<string | null>;
  /** Fix-mode only. Fetches the file from the PR branch, so the validator can tell an
   *  edit of an entry already pending in THIS PR from the introduction of a new one.
   *  Return null if the file does not exist on the branch. */
  fetchBranchFile?: (path: string) => Promise<string | null>;
  /**
   * "full" (default): whole-submission validation used at submit_for_review,
   *   submit_final, and create_pull_request. Requires registry.ts + ADR when
   *   new skills/agents/actions are included.
   * "fix": partial validation used at push_fix_to_pr. Skips "missing X" errors
   *   because fix-pushes intentionally touch a subset of files. Still enforces
   *   overwrite detection, type-decision rules, conventions, and refuses to
   *   introduce NEW define* exports (fix-pushes must not add new skills/agents).
   */
  mode?: "full" | "fix";
}

const SKILL_REGISTRY_PATH = "skill-runner/src/registry.ts";
const ACTION_REGISTRY_PATH = "agent-runner/src/registry.ts";
const VAULT_TS_PATH = "_shared/lib/vault.ts";

const FILE_SHRINK_FLOOR = 0.4;

function isRegistered(content: string, name: string): boolean {
  const importPattern = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b`);
  const usagePattern = new RegExp(`\\b${name}\\b`, "g");
  const matches = content.match(usagePattern);
  return importPattern.test(content) && matches !== null && matches.length >= 2;
}

function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(/from\s*["']([^"']+)["']/g)) {
    const p = m[1];
    if (p.startsWith("@shared/") && p !== "@shared/types") paths.push(p);
  }
  return paths;
}

function extractArrayEntries(content: string, arrayName: string): string[] {
  const match = content.match(new RegExp(`export\\s+const\\s+${arrayName}[^=]*=\\s*\\[([^\\]]*)\\]`, "s"));
  if (!match) return [];
  return match[1].replace(/\/\/[^\n]*/g, "").split(",").map((e) => e.trim()).filter(Boolean);
}

function hasExportedArray(content: string, arrayName: string): boolean {
  return new RegExp(`export\\s+const\\s+${arrayName}\\b`).test(content);
}

export function extractDefineExports(content: string, kind: "Skill" | "Agent" | "Action"): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*define${kind}`, "g"))) {
    names.push(m[1]);
  }
  return names;
}

function pathToImportPath(filePath: string): string | null {
  if (!filePath.startsWith("_shared/") || !filePath.endsWith(".ts")) return null;
  return filePath.replace(/^_shared\//, "@shared/").replace(/\.ts$/, "");
}

/** Bracket-balanced extraction of a `key: [...]` literal. Tolerates nested arrays
 *  and closing-bracket characters inside string literals (rough — does not parse
 *  escape sequences, but TS source rarely has unescaped `]` in agent metadata). */
function extractArrayLiteral(content: string, key: string): string | null {
  const startRe = new RegExp(`\\b${key}\\s*:\\s*\\[`);
  const start = content.match(startRe);
  if (!start || start.index === undefined) return null;
  let i = start.index + start[0].length;
  let depth = 1;
  let inString: '"' | "'" | "`" | null = null;
  let body = "";
  while (i < content.length && depth > 0) {
    const ch = content[i];
    const prev = i > 0 ? content[i - 1] : "";
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
    body += ch;
    i++;
  }
  return depth === 0 ? body : null;
}

/** Count quoted string entries inside an array body, ignoring empty strings. */
function countArrayStringEntries(body: string): number {
  const strings = body.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  return strings.filter((s) => s.length > 2).length;
}

/** Whether any field on an interface ending with `Input` has a name starting with `raw`. */
function hasRawInputField(content: string): boolean {
  const ifaceRe = /interface\s+\w*Input\s*(?:extends\s+[^{]+)?\{([^}]*)\}/g;
  for (const m of content.matchAll(ifaceRe)) {
    if (/^\s*raw[A-Z]\w*\s*[?:]/m.test(m[1])) return true;
  }
  return false;
}

/**
 * Pure content validator. All structural checks live here so the same rules run
 * at submit_for_review, submit_final, and create_pull_request (defense in depth
 * against TOCTOU between gates and files).
 */
export async function validateSubmission(
  files: SubmissionFile[],
  opts: ValidateOptions,
): Promise<ValidationResult> {
  const { liveSkillsCount, liveAgentsCount, liveActionsCount, knownVaultKeys, knownRegistry, fetchMainFile, fetchBranchFile } = opts;
  const mode = opts.mode ?? "full";
  const errors: string[] = [];
  const warnings: string[] = [];

  const submittedAsImportPaths = new Set(
    files.map((f) => f.path.replace(/^_shared\//, "@shared/").replace(/\.ts$/, "")),
  );

  // ── Skill-runner registry ──────────────────────────────────────
  const skillRegistryFile = files.find((f) => f.path === SKILL_REGISTRY_PATH);
  const hasNewSkills = files.some((f) => f.path.startsWith("_shared/skills/") && f.path.endsWith(".ts"));
  const hasNewAgents = files.some((f) => f.path.startsWith("_shared/agents/") && f.path.endsWith(".ts"));
  if (mode === "full" && !skillRegistryFile && (hasNewSkills || hasNewAgents)) {
    errors.push("Missing: skill-runner/src/registry.ts — include the full updated registry with all existing + new skills/agents.");
  }

  if (skillRegistryFile) {
    const rc = skillRegistryFile.content;

    if (!hasExportedArray(rc, "skills")) {
      errors.push(
        `skill-runner/src/registry.ts: export "skills" array is missing. The registry MUST export \`export const skills: Skill<any, any>[] = [...]\`. Do NOT rename this export — it is imported by the runtime. If you introduced a new array name, rename it back to \`skills\`.`,
      );
    }
    if (!hasExportedArray(rc, "agents")) {
      errors.push(
        `skill-runner/src/registry.ts: export "agents" array is missing. The registry MUST export \`export const agents: Agent<any, any>[] = [...]\`. Do NOT rename this export — it is imported by the runtime.`,
      );
    }

    for (const f of files) {
      if (!f.path.startsWith("_shared/skills/") || !f.path.endsWith(".ts")) continue;
      for (const name of extractDefineExports(f.content, "Skill")) {
        if (!isRegistered(rc, name)) {
          errors.push(`Skill "${name}" (${f.path}) is NOT imported+registered in skill-runner/src/registry.ts.`);
        }
      }
    }
    for (const f of files) {
      if (!f.path.startsWith("_shared/agents/") || !f.path.endsWith(".ts")) continue;
      for (const name of extractDefineExports(f.content, "Agent")) {
        if (!isRegistered(rc, name)) {
          errors.push(`Agent "${name}" (${f.path}) is NOT imported+registered in skill-runner/src/registry.ts.`);
        }
      }
    }

    const submittedSkillEntries = extractArrayEntries(rc, "skills");
    const submittedAgentEntries = extractArrayEntries(rc, "agents");

    if (submittedSkillEntries.length < liveSkillsCount) {
      errors.push(`skill-runner/src/registry.ts: skills array has ${submittedSkillEntries.length} entries but current registry has ${liveSkillsCount}. You MUST preserve all existing entries. Never remove skills from the registry.`);
    }
    if (submittedAgentEntries.length < liveAgentsCount) {
      errors.push(`skill-runner/src/registry.ts: agents array has ${submittedAgentEntries.length} entries but current registry has ${liveAgentsCount}. You MUST preserve all existing entries. Never remove agents from the registry.`);
    }

    for (const name of knownRegistry.skillEntries) {
      if (!submittedSkillEntries.includes(name)) {
        errors.push(`skill-runner/src/registry.ts: existing skill "${name}" was REMOVED from skills array. Existing entries must NEVER be removed.`);
      }
    }
    for (const name of knownRegistry.agentEntries) {
      if (!submittedAgentEntries.includes(name)) {
        errors.push(`skill-runner/src/registry.ts: existing agent "${name}" was REMOVED from agents array. Existing entries must NEVER be removed.`);
      }
    }

    const knownSkillPaths = new Set<string>(knownRegistry.skillRunnerImportPaths);
    for (const importPath of extractImportPaths(rc)) {
      if (!knownSkillPaths.has(importPath) && !submittedAsImportPaths.has(importPath)) {
        errors.push(`skill-runner/src/registry.ts: import from "${importPath}" — this file does not exist in the repo and is not included in submitted files. Check the path or include the file.`);
      }
    }
  }

  // ── Agent-runner registry ──────────────────────────────────────
  const actionRegistryFile = files.find((f) => f.path === ACTION_REGISTRY_PATH);
  const hasNewActions = files.some((f) => f.path.startsWith("_shared/actions/") && f.path.endsWith(".ts"));
  if (mode === "full" && !actionRegistryFile && hasNewActions) {
    errors.push("Missing: agent-runner/src/registry.ts — include the full updated registry with all existing + new actions.");
  }
  if (actionRegistryFile) {
    const rc = actionRegistryFile.content;

    if (!hasExportedArray(rc, "actions")) {
      errors.push(
        `agent-runner/src/registry.ts: export "actions" array is missing. The registry MUST export \`export const actions = [...]\`. Do NOT rename this export — it is imported by the runtime.`,
      );
    }

    for (const f of files) {
      if (!f.path.startsWith("_shared/actions/") || !f.path.endsWith(".ts")) continue;
      for (const name of extractDefineExports(f.content, "Action")) {
        if (!isRegistered(rc, name)) {
          errors.push(`Action "${name}" (${f.path}) is NOT imported+registered in agent-runner/src/registry.ts.`);
        }
      }
    }

    const submittedActionEntries = extractArrayEntries(rc, "actions");
    if (submittedActionEntries.length < liveActionsCount) {
      errors.push(`agent-runner/src/registry.ts: actions array has ${submittedActionEntries.length} entries but current registry has ${liveActionsCount}. You MUST preserve all existing entries. Never remove actions from the registry.`);
    }
    for (const name of knownRegistry.actionEntries) {
      if (!submittedActionEntries.includes(name)) {
        errors.push(`agent-runner/src/registry.ts: existing action "${name}" was REMOVED from actions array. Existing entries must NEVER be removed.`);
      }
    }

    const knownActionPaths = new Set<string>(knownRegistry.actionRunnerImportPaths);
    for (const importPath of extractImportPaths(rc)) {
      if (!knownActionPaths.has(importPath) && !submittedAsImportPaths.has(importPath)) {
        errors.push(`agent-runner/src/registry.ts: import from "${importPath}" — this file does not exist in the repo and is not included in submitted files. Check the path or include the file.`);
      }
    }
  }

  // ── ADR required (full-submission only; fix-pushes are scoped edits) ──
  if (mode === "full" && !files.some((f) => f.path.startsWith("docs/adr/") && f.path.endsWith(".md"))) {
    errors.push("Missing ADR file — include docs/adr/{NNN}-{name}.md.");
  }

  // ── Fix mode: push_fix_to_pr must NOT introduce new skills/agents/actions ──
  // Adding new entries goes through the full builder flow (submit_for_review →
  // run_bmad → submit_final → create_pull_request), not a fix push.
  if (mode === "fix") {
    const knownPaths = new Set<string>([
      ...knownRegistry.skillRunnerImportPaths,
      ...knownRegistry.actionRunnerImportPaths,
    ]);
    const kinds: Array<{ kind: "Skill" | "Agent" | "Action"; prefix: string }> = [
      { kind: "Skill", prefix: "_shared/skills/" },
      { kind: "Agent", prefix: "_shared/agents/" },
      { kind: "Action", prefix: "_shared/actions/" },
    ];
    for (const f of files) {
      if (!f.path.endsWith(".ts")) continue;
      const match = kinds.find((k) => f.path.startsWith(k.prefix));
      if (!match) continue;
      const imp = pathToImportPath(f.path);
      if (imp && knownPaths.has(imp)) continue;
      const exports = extractDefineExports(f.content, match.kind);
      if (exports.length === 0) continue;

      // The entry may be new to main but ALREADY PENDING IN THIS PR — that is an edit,
      // not an introduction. Compare export NAMES rather than file existence, so a fix
      // push still cannot append an additional define* to a file already on the branch.
      const onBranch = fetchBranchFile ? await fetchBranchFile(f.path) : null;
      const alreadyOnBranch = new Set(onBranch ? extractDefineExports(onBranch, match.kind) : []);
      const introduced = exports.filter((name) => !alreadyOnBranch.has(name));
      if (introduced.length === 0) continue;

      errors.push(
        `${f.path}: push_fix_to_pr cannot introduce new ${match.kind.toLowerCase()}s — ` +
        `${introduced.map((n) => `\`${n}\``).join(", ")} ${introduced.length === 1 ? "is" : "are"} ` +
        `neither registered on main nor already exported on this branch. ` +
        `Use the full builder flow for new entries: start_building → confirm_plan → submit_for_review → run_bmad → submit_final → create_pull_request. ` +
        `If this is a rename of an existing file, delete the old path via \`deletedFiles\` AND run the full flow.`,
      );
    }
  }

  // ── Vault key usage in actions ────────────────────────────────
  for (const f of files) {
    if (!f.path.startsWith("_shared/actions/") || !f.path.endsWith(".ts")) continue;
    for (const m of f.content.matchAll(/ctx\.env\.([A-Z][A-Z0-9_]+)/g)) {
      const key = m[1];
      if (!knownVaultKeys.includes(key)) {
        warnings.push(`Action "${f.path}" uses ctx.env.${key} which is NOT in loadAIHubSecrets() (_shared/lib/vault.ts). Add it to vault.ts or the action will get an empty string at runtime.`);
      }
    }
  }

  // ── vault.ts integrity ───────────────────────────────────────
  const vaultFile = files.find((f) => f.path === VAULT_TS_PATH);
  if (vaultFile) {
    if (!/export\s+function\s+createVaultClient/.test(vaultFile.content)) {
      errors.push("_shared/lib/vault.ts: createVaultClient() function was REMOVED. Do NOT rewrite vault.ts — only add new secret mappings to loadAIHubSecrets().");
    }
    if (!/export\s+(async\s+)?function\s+loadAIHubSecrets/.test(vaultFile.content)) {
      errors.push("_shared/lib/vault.ts: loadAIHubSecrets() function was REMOVED. Do NOT rewrite vault.ts — only add new secret mappings.");
    }
    for (const key of knownVaultKeys) {
      if (!vaultFile.content.includes(key)) {
        errors.push(`_shared/lib/vault.ts: existing secret key "${key}" was REMOVED. Do NOT remove existing vault key mappings — other actions depend on them.`);
      }
    }
  }

  // ── Type-decision sanity ─────────────────────────────────────
  for (const f of files) {
    if (!f.path.startsWith("_shared/skills/") || !f.path.endsWith(".ts")) continue;
    if (/\bfetch\s*\(/.test(f.content)) {
      errors.push(`Skill "${f.path}" uses fetch() — skills are pure functions and must NEVER call external APIs. Move this to _shared/actions/{domain}/ and use defineAction instead of defineSkill.`);
    }
  }
  for (const f of files) {
    if (!f.path.startsWith("_shared/actions/") || !f.path.endsWith(".ts")) continue;
    if (/api\.anthropic\.com/.test(f.content) || /x-api-key.*CLAUDE_API_KEY/.test(f.content)) {
      warnings.push(`Action "${f.path}" calls the Claude API directly. If this action is ONLY used from Claude Desktop (not webhooks), this duplicates Claude — the user already has Claude. Consider: (1) a skill that returns the prompt/rules and lets Claude Desktop do the generation, or (2) an action that only fetches data (e.g. tone rules from Vault) and returns it for Claude Desktop to use. Direct Claude API calls are justified when the action is triggered via webhook (no Claude available).`);
    }
  }

  // ── Conventions ─────────────────────────────────────────────
  for (const f of files) {
    const isAction = f.path.startsWith("_shared/actions/") && f.path.endsWith(".ts");
    const isSkill = f.path.startsWith("_shared/skills/") && f.path.endsWith(".ts");
    const isAgent = f.path.startsWith("_shared/agents/") && f.path.endsWith(".ts");
    if (!isAction && !isSkill && !isAgent) continue;

    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(f.content)) {
      if (isAction) {
        errors.push(`Action "${f.path}" uses console.log/warn/error — use ctx.logger instead for Loki observability.`);
      } else {
        warnings.push(`${isSkill ? "Skill" : "Agent"} "${f.path}" uses console.log/warn/error — skills and agents should not log directly. Remove or convert to a return value.`);
      }
    }

    const unicodeEscapes = f.content.match(/\\u[0-9a-fA-F]{4}/g);
    if (unicodeEscapes) {
      warnings.push(`${isAction ? "Action" : isSkill ? "Skill" : "Agent"} "${f.path}" contains unicode escape sequences (${[...new Set(unicodeEscapes)].slice(0, 3).join(", ")}). Use actual characters instead (e.g. — not \\u2014).`);
    }

    if (isAction) {
      const hasCtxUsage = /\bctx\.(logger|env|metrics)\b/.test(f.content);
      if (!hasCtxUsage) {
        warnings.push(`Action "${f.path}" never references ctx.logger, ctx.env, or ctx.metrics — actions should use ctx.logger for observability. If the action has no secrets, ctx.logger is still required.`);
      }
      if (!/\bctx\.logger\b/.test(f.content)) {
        errors.push(`Action "${f.path}" does not use ctx.logger — every action must log key events (start, success, error paths) for Loki observability.`);
      }
    }
  }

  // ── Agent monolith detection (Rule #7 — gather steps must have raw* inputs) ──
  // The report_export shipped with skills:[] + 9-step gather + no
  // raw* inputs, so Claude had to carry videoUrl/newCardId/s3FileName across
  // MCP calls in working memory. Catch that shape before it ships again.
  const MONOLITH_GATHER_THRESHOLD = 4;
  for (const f of files) {
    if (!f.path.startsWith("_shared/agents/") || !f.path.endsWith(".ts")) continue;

    const skillsBody = extractArrayLiteral(f.content, "skills");
    if (skillsBody === null) continue;
    const skillsCount = countArrayStringEntries(skillsBody);

    const gatherBody = extractArrayLiteral(f.content, "gather");
    const gatherCount = gatherBody !== null ? countArrayStringEntries(gatherBody) : 0;
    if (gatherCount < MONOLITH_GATHER_THRESHOLD) continue;

    if (hasRawInputField(f.content)) continue;

    const baseMessage =
      `${f.path}: agent has ${gatherCount} gather steps and no raw* fields on its Input interface. ` +
      `This is the monolith pattern that causes state loss across MCP calls: Claude has to carry ` +
      `intermediate values in working memory. ` +
      `Decompose: turn each gather step that produces data into a parsing skill, add a matching rawXxxJson field ` +
      `to the Input interface. ` +
      `If the workflow waits on an external job mid-flow, split into two agents (prepare and finalize).`;

    if (skillsCount === 0) {
      errors.push(`${baseMessage} (skills: [])`);
    } else if (skillsCount === 1) {
      // Pre-mortem A: a single stub skill is the easiest way to bypass the
      // skills:[] check while still keeping the monolith shape. Surface as a
      // warning so the reviewer at least sees it.
      warnings.push(`${baseMessage} (skills.length === 1 — verify the skill is doing real work, not a stub to bypass the lint)`);
    }
  }

  // ── Overwrite detection for existing skill/agent/action files ──
  // Catches the "phantom imports workaround" pattern where the builder replaces
  // a real file with a plausible-looking stub. Requires a main-HEAD fetcher.
  if (fetchMainFile) {
    const knownPaths = new Set<string>([
      ...knownRegistry.skillRunnerImportPaths,
      ...knownRegistry.actionRunnerImportPaths,
    ]);

    const candidates = files.filter((f) => {
      if (!f.path.endsWith(".ts")) return false;
      if (!(f.path.startsWith("_shared/skills/") || f.path.startsWith("_shared/agents/") || f.path.startsWith("_shared/actions/"))) return false;
      const imp = pathToImportPath(f.path);
      if (imp === null) return false;
      // In fix mode a file may be new to main but already pending in the PR. It still
      // needs shrink / removed-export protection — baselined against the branch.
      return knownPaths.has(imp) || (mode === "fix" && fetchBranchFile !== undefined);
    });

    await Promise.all(
      candidates.map(async (f) => {
        const imp = pathToImportPath(f.path);
        const onMain = imp !== null && knownPaths.has(imp);
        const baselineLabel = onMain ? "main HEAD" : "the PR branch";
        const main = onMain
          ? await fetchMainFile(f.path)
          : fetchBranchFile
            ? await fetchBranchFile(f.path)
            : null;
        if (main === null) return;

        const ratio = f.content.length / Math.max(main.length, 1);
        if (ratio < FILE_SHRINK_FLOOR) {
          errors.push(
            `${f.path}: submitted content is ${(ratio * 100).toFixed(0)}% the size of ${baselineLabel} (${f.content.length} vs ${main.length} chars). ` +
            `Do NOT replace existing files with stubs or "passthrough copies". If this is an intentional rewrite, call read_repo_file first to read the real contents, then state the rewrite in your plan and ADR before regenerating.`,
          );
          return;
        }

        const kinds: Array<"Skill" | "Agent" | "Action"> = ["Skill", "Agent", "Action"];
        for (const kind of kinds) {
          const mainExports = new Set(extractDefineExports(main, kind));
          const submittedExports = new Set(extractDefineExports(f.content, kind));
          for (const name of mainExports) {
            if (!submittedExports.has(name)) {
              errors.push(
                `${f.path}: existing export \`export const ${name} = define${kind}(...)\` is missing from the submitted file. The ${kind.toLowerCase()} "${name}" already exists on ${baselineLabel} — do not rename or remove it. If you intended to modify only part of the file, read_repo_file first and preserve all other exports.`,
              );
            }
          }
        }
      }),
    );
  }

  return { errors, warnings };
}

export function formatErrors(result: ValidationResult): string {
  const errText = result.errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
  const warnText = result.warnings.length > 0
    ? `\n\n⚠️ Warnings:\n${result.warnings.map((w, i) => `${i + 1}. ${w}`).join("\n")}`
    : "";
  return `${errText}${warnText}`;
}