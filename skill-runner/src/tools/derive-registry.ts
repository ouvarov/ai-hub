/**
 * Comment-preserving registry editing for the builder pipeline.
 *
 * The builder used to submit a fully LLM-regenerated `registry.ts`, which let the
 * model silently drop section-header comments and doc notes. Instead of trusting the
 * regenerated file, we re-derive the registry from main HEAD by ADDING only the new import lines
 * and array entries — every existing line (comments, blank lines, grouping) is kept
 * byte-for-byte.
 *
 * Pure functions only. The caller decides whether to trust the derived output
 * (see the "derive + verify" guard in github-pr.ts): the derived file replaces the
 * submitted one ONLY when the two are semantically identical (a pure add). Renames,
 * removals, or reorders fall back to the submitted file untouched.
 */

export interface NewRegistryEntry {
  /** Exported binding name, e.g. "weeklyReportCheck". */
  exportName: string;
  /** Import specifier, e.g. "@shared/skills/reports/weekly-report-check". */
  importPath: string;
  /** Target array: "skills" | "agents" | "actions". */
  arrayName: string;
}

const ENTRY_INDENT = "  ";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the array literal of `export const <arrayName> ... = [ ... ]` with a
 * string-literal-aware bracket scan. Returns the indices of the opening and
 * closing brackets, or null when the array is not found.
 */
function findArraySpan(content: string, arrayName: string): { open: number; close: number } | null {
  const decl = new RegExp(`export\\s+const\\s+${escapeRegExp(arrayName)}\\b[^=]*=\\s*\\[`);
  const m = content.match(decl);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1; // index of the '['
  let i = open + 1;
  let depth = 1;
  let inString: '"' | "'" | "`" | null = null;
  while (i < content.length && depth > 0) {
    const ch = content[i];
    const prev = content[i - 1];
    if (inString) {
      if (ch === inString && prev !== "\\") inString = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return { open, close: i };
    }
    i++;
  }
  return null;
}

/** Identifier entries currently in an array (comment-stripped). */
export function arrayEntries(content: string, arrayName: string): string[] {
  const span = findArraySpan(content, arrayName);
  if (!span) return [];
  return content
    .slice(span.open + 1, span.close)
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** All `@shared/...` import specifiers referenced in the file. */
export function importPaths(content: string): string[] {
  const paths: string[] = [];
  for (const m of content.matchAll(/from\s*["'](@shared\/[^"']+)["']/g)) {
    paths.push(m[1]);
  }
  return [...new Set(paths)];
}

function importPresent(content: string, exportName: string, importPath: string): boolean {
  const re = new RegExp(
    `import\\s*\\{[^}]*\\b${escapeRegExp(exportName)}\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(importPath)}["']`,
  );
  return re.test(content);
}

/** Insert new `@shared` import lines right after the last existing `@shared` import. */
function insertImports(content: string, entries: NewRegistryEntry[]): string {
  if (entries.length === 0) return content;
  const importRe = /^import\s.*from\s*["']@shared\/[^"']+["'];?[ \t]*$/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) last = m;
  if (!last) return content; // fail safe: no @shared import block found — leave untouched
  const insertAt = last.index + last[0].length;
  const lines = entries
    .map((e) => `\nimport { ${e.exportName} } from "${e.importPath}";`)
    .join("");
  return content.slice(0, insertAt) + lines + content.slice(insertAt);
}

/** Append one entry on its own line before the array's closing bracket. */
function insertArrayEntry(content: string, arrayName: string, exportName: string): string {
  const span = findArraySpan(content, arrayName);
  if (!span) return content; // fail safe
  const body = content.slice(span.open + 1, span.close);
  const trimmed = body.replace(/\s+$/, "");
  const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
  const newBody = `${trimmed}${needsComma ? "," : ""}\n${ENTRY_INDENT}${exportName},\n`;
  return content.slice(0, span.open + 1) + newBody + content.slice(span.close);
}

/**
 * Derive a new registry by additively inserting the given entries into `mainContent`.
 * Idempotent: entries already present (by array membership) are skipped; imports
 * already present are not duplicated.
 */
export function deriveRegistry(mainContent: string, entries: NewRegistryEntry[]): string {
  let content = mainContent;
  const pending = entries.filter((e) => !arrayEntries(content, e.arrayName).includes(e.exportName));
  if (pending.length === 0) return content;

  const importsToAdd = pending.filter((e) => !importPresent(content, e.exportName, e.importPath));
  content = insertImports(content, importsToAdd);
  for (const e of pending) {
    content = insertArrayEntry(content, e.arrayName, e.exportName);
  }
  return content;
}

/** Semantic fingerprint used to verify a derived registry equals the submitted one. */
export function registrySemantics(content: string): string {
  return JSON.stringify({
    imports: importPaths(content).sort(),
    skills: arrayEntries(content, "skills").sort(),
    agents: arrayEntries(content, "agents").sort(),
    actions: arrayEntries(content, "actions").sort(),
  });
}

export function sameSemantics(a: string, b: string): boolean {
  return registrySemantics(a) === registrySemantics(b);
}
