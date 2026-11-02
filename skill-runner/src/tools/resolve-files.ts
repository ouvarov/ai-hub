import { z } from "zod";
import type { SubmissionFile } from "./validate-submission";

/**
 * Anchored edits for the Builder pipeline.
 *
 * WHY: every file-taking Builder tool (submit_for_review, submit_final,
 * create_pull_request, push_fix_to_pr) used to require the FULL file content in
 * its arguments. For a large file the model has to reproduce every line verbatim
 * inside a tool call on every step — and it silently truncates, drops sections,
 * or inserts placeholders.
 *
 * FIX: a file entry may carry `edits` (a small delta) instead of `content`. The
 * server fetches the current file and applies the edits, so the model only sends
 * the changed lines plus an anchor — never the whole file. The resolved content
 * then flows through the exact same validateSubmission + PR path as before.
 *
 * The op semantics mirror an earlier in-place article update action
 * (applyContentOperation), tightened for source files: anchored ops require a
 * UNIQUE target (Claude Code Edit semantics) so an edit can't silently land on
 * the wrong occurrence.
 */

export type EditOp =
  | "insertAfter"
  | "insertBefore"
  | "replace"
  | "replaceAll"
  | "append"
  | "prepend";

export interface FileEdit {
  op: EditOp;
  /** Existing snippet to anchor on. Required for insertAfter/insertBefore/replace/replaceAll. */
  target?: string;
  /** Text to insert or the replacement text. */
  text: string;
}

/** A file entry in a Builder submission: full content OR a set of anchored edits. */
export interface SubmissionFileInput {
  path: string;
  content?: string;
  edits?: FileEdit[];
}

/** Fetches the current content of a file to edit against, or null if it does not exist. */
export type FetchBase = (path: string) => Promise<string | null>;

/**
 * Zod schema for one file entry in a Builder submission — shared by
 * submit_for_review, submit_final, create_pull_request and push_fix_to_pr so the
 * model sees identical guidance everywhere.
 */
export const submissionFileSchema = z.object({
  path: z.string().describe("File path relative to repo root"),
  content: z
    .string()
    .optional()
    .describe("Full file content. Use ONLY for new files or a deliberate full rewrite."),
  edits: z
    .array(
      z.object({
        op: z
          .enum(["insertAfter", "insertBefore", "replace", "replaceAll", "append", "prepend"])
          .describe("insertAfter/insertBefore/replace need a unique `target`; replaceAll changes every match; append/prepend need no target"),
        target: z
          .string()
          .optional()
          .describe("An exact, existing snippet to anchor on (must be unique for insert*/replace). Copy it verbatim from read_repo_file."),
        text: z.string().describe("Text to insert, or the replacement text"),
      }),
    )
    .optional()
    .describe(
      "Anchored edits applied to the CURRENT file on the server — send ONLY the changed lines, never the whole file. " +
        "Strongly preferred for editing existing large files: it avoids re-transmitting the file and dropping sections.",
    ),
}).superRefine((val, ctx) => {
  // Reject malformed tool calls at parse time (before any network fetch), so the
  // model gets fast feedback. resolveFiles/applyEdit keep the same runtime checks
  // as defense-in-depth (they are also called directly from tests).
  const hasContent = typeof val.content === "string";
  const hasEdits = Array.isArray(val.edits) && val.edits.length > 0;
  if (hasContent && hasEdits) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${val.path}: provide either "content" (full file) or "edits" (delta), not both.` });
  }
  if (!hasContent && !hasEdits) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${val.path}: provide "content" for a new file / full rewrite, or "edits" to change an existing file.` });
  }
  for (const e of val.edits ?? []) {
    const needsTarget = e.op !== "append" && e.op !== "prepend";
    if (needsTarget && !e.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${val.path}: edit op "${e.op}" requires a non-empty "target" anchor.` });
    }
  }
});

/**
 * Schema for a `files` argument, accepting both a real array and a JSON-encoded
 * string of that array.
 *
 * WHY the string branch: some MCP clients serialise array-valued tool
 * arguments as strings, so zod rejected the call before any handler ran — every
 * builder tool with an array parameter was unreachable from those clients while
 * string-only tools worked. Accepting the encoded form costs one JSON.parse, and
 * the decoded value is validated against the same schema.
 */
export function filesParam(description: string, opts: { allowEmpty?: boolean } = {}) {
  const array = opts.allowEmpty ? z.array(submissionFileSchema) : z.array(submissionFileSchema).min(1);
  return z
    .union([array, z.string().min(1)])
    .describe(
      `${description} Pass a JSON array. A JSON-encoded string of the same array is also accepted, ` +
        `for clients that serialise array arguments as strings.`,
    );
}

/** Same string tolerance for a plain array-of-strings argument (e.g. deletedFiles). */
export function stringArrayParam(description: string) {
  return z
    .union([z.array(z.string()), z.string()])
    .optional()
    .describe(`${description} A JSON-encoded string of the same array is also accepted.`);
}

/** Normalises an array-of-strings argument, parsing the JSON-string form. */
export function normalizeStringArray(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // A bare path is a reasonable thing for a client to send instead of ["path"].
    return [value];
  }
  if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) return parsed as string[];
  throw new Error(`Expected an array of file paths, got ${typeof parsed}.`);
}

/** Normalises a `files` argument into entries, parsing the JSON-string form. */
export function normalizeFiles(
  value: SubmissionFileInput[] | string,
  opts: { allowEmpty?: boolean } = {},
): SubmissionFileInput[] {
  if (Array.isArray(value)) return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `"files" was sent as a string but is not valid JSON. Pass a JSON array of file entries, ` +
        `each with "path" plus "content" or "edits".`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`"files" was sent as a string but decoded to ${typeof parsed}, not an array of file entries.`);
  }

  const schema = opts.allowEmpty ? z.array(submissionFileSchema) : z.array(submissionFileSchema).min(1);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `- ${i.path.join(".") || "files"}: ${i.message}`).join("\n");
    throw new Error(`"files" decoded from the string form but did not validate:\n${issues}`);
  }
  return result.data as SubmissionFileInput[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/** Apply a single anchored edit. Throws a descriptive Error the model can act on. */
export function applyEdit(existing: string, edit: FileEdit, path: string): string {
  const { op, target } = edit;
  const text = edit.text;

  if (op === "append") return existing.length ? `${existing}\n${text}` : text;
  if (op === "prepend") return existing.length ? `${text}\n${existing}` : text;

  if (!target) {
    throw new Error(`${path}: edit op "${op}" requires a "target" anchor.`);
  }
  const count = countOccurrences(existing, target);
  if (count === 0) {
    throw new Error(
      `${path}: target for "${op}" not found in the current file: "${target.slice(0, 120)}". ` +
        `Read the file (read_repo_file) and copy an exact, existing snippet as the anchor.`,
    );
  }
  if (op !== "replaceAll" && count > 1) {
    throw new Error(
      `${path}: target for "${op}" appears ${count} times — it must be unique so the edit lands in one place. ` +
        `Extend the anchor with surrounding lines to make it unique, or use "replaceAll" to change every occurrence.`,
    );
  }

  const idx = existing.indexOf(target);
  switch (op) {
    case "insertBefore":
      return existing.slice(0, idx) + text + "\n" + existing.slice(idx);
    case "insertAfter": {
      const at = idx + target.length;
      return existing.slice(0, at) + "\n" + text + existing.slice(at);
    }
    case "replace":
      return existing.slice(0, idx) + text + existing.slice(idx + target.length);
    case "replaceAll":
      return existing.split(target).join(text);
    default:
      throw new Error(`${path}: unknown edit op "${String(op)}".`);
  }
}

/**
 * Resolve a mixed list of submission inputs into concrete { path, content } files.
 * Content-mode entries pass through unchanged; edit-mode entries are applied
 * server-side against the base file fetched via `fetchBase`.
 *
 * Throws a single aggregated Error (one line per problem) so the tool can return
 * it verbatim to the model.
 */
export async function resolveFiles(
  inputs: SubmissionFileInput[],
  fetchBase: FetchBase,
): Promise<SubmissionFile[]> {
  const mode = (input: SubmissionFileInput) => ({
    hasContent: typeof input.content === "string",
    hasEdits: Array.isArray(input.edits) && input.edits.length > 0,
  });

  // Fetch base files for all edit-mode entries in parallel (settled, so one bad
  // read doesn't abort the rest and we can still aggregate every problem).
  const bases = await Promise.all(
    inputs.map((input) => {
      const { hasContent, hasEdits } = mode(input);
      if (hasContent || !hasEdits) return Promise.resolve<null>(null); // no fetch needed
      return fetchBase(input.path).then(
        (v) => ({ ok: true as const, value: v }),
        (err) => ({ ok: false as const, err }),
      );
    }),
  );

  const resolved: SubmissionFile[] = [];
  const errors: string[] = [];

  inputs.forEach((input, i) => {
    const { hasContent, hasEdits } = mode(input);

    if (hasContent && hasEdits) {
      errors.push(`${input.path}: provide either "content" (full file) or "edits" (delta), not both.`);
      return;
    }
    if (!hasContent && !hasEdits) {
      errors.push(`${input.path}: provide "content" for a new file / full rewrite, or "edits" to change an existing file.`);
      return;
    }
    if (hasContent) {
      resolved.push({ path: input.path, content: input.content as string });
      return;
    }

    // Edit mode — apply the delta to the base fetched above.
    const base = bases[i];
    if (base && !base.ok) {
      errors.push(`${input.path}: could not read the current file to edit: ${base.err instanceof Error ? base.err.message : String(base.err)}`);
      return;
    }
    if (!base || base.value === null) {
      errors.push(`${input.path}: "edits" target an existing file, but this path does not exist yet. Use "content" to create a new file.`);
      return;
    }

    try {
      let next = base.value;
      for (const edit of input.edits as FileEdit[]) {
        next = applyEdit(next, edit, input.path);
      }
      resolved.push({ path: input.path, content: next });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  });

  if (errors.length > 0) {
    throw new Error(
      `Could not resolve file edits:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  return resolved;
}
