#!/usr/bin/env node
/**
 * Bundles architecture docs and BMAD workflows into a TypeScript module.
 * Run from repo root: node skill-runner/scripts/bundle-docs.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");

const commandDirs = {
  "bmad-brainstorming": "_bmad/core/workflows/bmad-brainstorming",
  "bmad-advanced-elicitation": "_bmad/core/workflows/advanced-elicitation",
  "bmad-create-product-brief":
    "_bmad/bmm/workflows/1-analysis/create-product-brief",
  "bmad-review-adversarial-general":
    "_bmad/core/tasks/bmad-review-adversarial-general",
  "bmad-review-edge-case-hunter":
    "_bmad/core/tasks/bmad-review-edge-case-hunter",
  "bmad-review-code-quality":
    "_bmad/core/tasks/bmad-review-code-quality",
  "bmad-domain-research": "_bmad/bmm/workflows/1-analysis/research",
  "bmad-technical-research": "_bmad/bmm/workflows/1-analysis/research",
  "bmad-market-research": "_bmad/bmm/workflows/1-analysis/research",
  "bmad-help": "_bmad/core/tasks/bmad-help",
};

function readDirRecursive(dir) {
  const files = {};
  function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else {
        const rel = path.relative(dir, full);
        files[rel] = fs.readFileSync(full, "utf-8");
      }
    }
  }
  walk(dir);
  return files;
}

// Collect unique directories
const data = {};
const seen = new Set();
for (const [, relDir] of Object.entries(commandDirs)) {
  if (seen.has(relDir)) continue;
  seen.add(relDir);
  data[relDir] = readDirRecursive(path.join(root, relDir));
}

// Configs
const configPaths = [
  "_bmad/_config/bmad-help.csv",
  "_bmad/core/config.yaml",
  "_bmad/bmm/config.yaml",
];
const configFiles = {};
for (const p of configPaths) {
  const full = path.join(root, p);
  if (fs.existsSync(full)) {
    configFiles[p] = fs.readFileSync(full, "utf-8");
  }
}

// Docs
const docs = {
  "CLAUDE.md": fs.readFileSync(path.join(root, "CLAUDE.md"), "utf-8"),
  "TEMPLATE.md": fs.readFileSync(
    path.join(root, "_template/TEMPLATE.md"),
    "utf-8",
  ),
};

// ADRs
const adrDir = path.join(root, "docs/adr");
const adrs = {};
if (fs.existsSync(adrDir)) {
  for (const f of fs.readdirSync(adrDir)) {
    if (f.endsWith(".md") || f.endsWith(".json")) {
      adrs[f] = fs.readFileSync(path.join(adrDir, f), "utf-8");
    }
  }
}

// Vault keys — parse return object from loadAIHubSecrets() in vault.ts
const vaultTs = fs.readFileSync(path.join(root, "_shared/lib/vault.ts"), "utf-8");
const vaultReturnMatch = vaultTs.match(/return\s*\{([^}]+)\}\s*;\s*\n\}/s);
const vaultKeys = [];
if (vaultReturnMatch) {
  for (const m of vaultReturnMatch[1].matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*:/gm)) {
    vaultKeys.push(m[1]);
  }
}

// ── Registry metadata — parse imports and array entries from both registries ──

function parseRegistryFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");
  const imports = [];
  const importPaths = [];

  // Parse: import { name } from "path" and import { name1, name2 } from "path"
  for (const m of content.matchAll(/import\s*\{\s*([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type ") && n !== "type");
    const importPath = m[2];
    for (const name of names) {
      imports.push(name);
    }
    if (importPath.startsWith("@shared/")) {
      importPaths.push(importPath);
    }
  }

  // Parse array entries: export const X = [a, b, c]
  const arrays = {};
  for (const m of content.matchAll(/export\s+const\s+(\w+)[^=]*=\s*\[([^\]]*)\]/gs)) {
    const arrayName = m[1];
    // Strip comments and extract identifiers
    const items = m[2]
      .replace(/\/\/[^\n]*/g, "")  // remove line comments
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    arrays[arrayName] = items;
  }

  return { imports, importPaths: [...new Set(importPaths)], arrays };
}

const skillRegistryPath = path.join(root, "skill-runner/src/registry.ts");
const actionRegistryPath = path.join(root, "agent-runner/src/registry.ts");

let registryMeta = null;
if (fs.existsSync(skillRegistryPath) && fs.existsSync(actionRegistryPath)) {
  const skillReg = parseRegistryFile(skillRegistryPath);
  const actionReg = parseRegistryFile(actionRegistryPath);
  registryMeta = {
    skillEntries: skillReg.arrays.skills || [],
    agentEntries: skillReg.arrays.agents || [],
    actionEntries: actionReg.arrays.actions || [],
    skillRunnerImportPaths: skillReg.importPaths,
    actionRunnerImportPaths: actionReg.importPaths,
  };
}

// Generate TypeScript
let ts = `/**
 * Auto-generated bundle of architecture docs and BMAD workflows.
 * Re-generate with: node skill-runner/scripts/bundle-docs.js
 */

`;

// Docs
ts += "// ── Architecture docs (bundled at build time) ──\n\n";
for (const [name, content] of Object.entries(docs)) {
  const varName = name.replace(/[^a-zA-Z]/g, "_").toUpperCase();
  ts += `export const ${varName} = ${JSON.stringify(content)};\n\n`;
}

// Command → dir mapping
ts += "// ── BMAD command → directory mapping ──\n\n";
ts += `const BMAD_COMMAND_DIRS: Record<string, string> = ${JSON.stringify(commandDirs, null, 2)};\n\n`;

// File bundles
ts += "// ── BMAD workflow files (keyed by directory) ──\n\n";
ts += `const BMAD_FILES: Record<string, Record<string, string>> = ${JSON.stringify(data)};\n\n`;

// Configs
ts += "// ── BMAD config files ──\n\n";
ts += `const BMAD_CONFIGS: Record<string, string> = ${JSON.stringify(configFiles)};\n\n`;

// ADRs
ts += "// ── ADRs (bundled at build time) ──\n\n";
ts += `const ADR_FILES: Record<string, string> = ${JSON.stringify(adrs)};\n\n`;

// Public API
ts += `// ── Public API ──

export type BmadCommand =
  | 'bmad-brainstorming'
  | 'bmad-advanced-elicitation'
  | 'bmad-create-product-brief'
  | 'bmad-review-adversarial-general'
  | 'bmad-review-edge-case-hunter'
  | 'bmad-review-code-quality'
  | 'bmad-domain-research'
  | 'bmad-technical-research'
  | 'bmad-market-research'
  | 'bmad-help';

export const BMAD_COMMANDS = Object.keys(BMAD_COMMAND_DIRS) as BmadCommand[];

/** Get all files for a BMAD command as { relativePath: content } */
export function getBmadWorkflow(command: BmadCommand): Record<string, string> | null {
  const dir = BMAD_COMMAND_DIRS[command];
  if (!dir) return null;
  return BMAD_FILES[dir] ?? null;
}

/** Get a specific BMAD config file */
export function getBmadConfig(path: string): string | null {
  return BMAD_CONFIGS[path] ?? null;
}

/** Get ADR index.json content */
export function getAdrIndex(): string | null {
  return ADR_FILES["index.json"] ?? null;
}

/** Get a specific ADR by name (without .md extension) */
export function getAdr(name: string): string | null {
  return ADR_FILES[name + ".md"] ?? null;
}
`;

const outPath = path.join(root, "skill-runner/src/bundled-docs.ts");
fs.writeFileSync(outPath, ts);
console.log(
  `Generated ${outPath} (${(ts.length / 1024).toFixed(1)}KB, ${Object.keys(data).length} workflow dirs)`,
);

// Vault keys — small separate file so it can be included in PRs without the 400KB+ bundled-docs
let vaultKeysTsContent = `/**
 * Known Vault secret keys and registry metadata, parsed at build time.
 * Re-generate with: node skill-runner/scripts/bundle-docs.js
 */
export const KNOWN_VAULT_KEYS: string[] = ${JSON.stringify(vaultKeys)};
`;

if (registryMeta) {
  vaultKeysTsContent += `
/**
 * Registry metadata — known entry names and import paths from both registries.
 * Used by submit_for_review to detect removed entries and invalid imports.
 */
export const KNOWN_REGISTRY = ${JSON.stringify(registryMeta)} as const;
`;
} else {
  console.warn("WARNING: Could not parse registry files — KNOWN_REGISTRY will not be generated");
  vaultKeysTsContent += `
export const KNOWN_REGISTRY = {
  skillEntries: [] as string[],
  agentEntries: [] as string[],
  actionEntries: [] as string[],
  skillRunnerImportPaths: [] as string[],
  actionRunnerImportPaths: [] as string[],
} as const;
`;
}

const vaultKeysPath = path.join(root, "skill-runner/src/vault-keys.generated.ts");
fs.writeFileSync(vaultKeysPath, vaultKeysTsContent);
if (vaultKeys.length === 0) {
  console.warn("WARNING: No vault keys found — check that _shared/lib/vault.ts has a return { ... } block with UPPER_SNAKE_CASE keys");
}
console.log(`Generated ${vaultKeysPath} (${vaultKeys.length} vault keys, ${registryMeta ? registryMeta.skillEntries.length + registryMeta.agentEntries.length + registryMeta.actionEntries.length : 0} registry entries)`);
