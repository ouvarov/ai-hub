import { describe, it, expect } from "vitest";
import { applyEdit, resolveFiles, type FetchBase } from "../skill-runner/src/tools/resolve-files";

const BASE = "line1\nANCHOR\nline3\nEND";

describe("applyEdit", () => {
  it("insertAfter places text right after a unique anchor", () => {
    expect(applyEdit(BASE, { op: "insertAfter", target: "ANCHOR", text: "NEW" }, "f")).toBe(
      "line1\nANCHOR\nNEW\nline3\nEND",
    );
  });

  it("insertBefore places text right before a unique anchor", () => {
    expect(applyEdit(BASE, { op: "insertBefore", target: "line3", text: "NEW" }, "f")).toBe(
      "line1\nANCHOR\nNEW\nline3\nEND",
    );
  });

  it("replace swaps a unique anchor and preserves everything else", () => {
    const out = applyEdit(BASE, { op: "replace", target: "ANCHOR", text: "X" }, "f");
    expect(out).toBe("line1\nX\nline3\nEND");
  });

  it("append/prepend need no target", () => {
    expect(applyEdit(BASE, { op: "append", text: "TAIL" }, "f")).toBe(BASE + "\nTAIL");
    expect(applyEdit(BASE, { op: "prepend", text: "HEAD" }, "f")).toBe("HEAD\n" + BASE);
  });

  it("append/prepend on an empty file do not add a stray newline", () => {
    expect(applyEdit("", { op: "append", text: "A" }, "f")).toBe("A");
    expect(applyEdit("", { op: "prepend", text: "A" }, "f")).toBe("A");
  });

  it("replaceAll changes every occurrence", () => {
    expect(applyEdit("dup X dup", { op: "replaceAll", target: "dup", text: "Y" }, "f")).toBe("Y X Y");
  });

  it("rejects an ambiguous anchor (count > 1) for single-target ops", () => {
    expect(() => applyEdit("dup X dup", { op: "replace", target: "dup", text: "Y" }, "f")).toThrow(
      /appears 2 times/,
    );
    expect(() => applyEdit("dup X dup", { op: "insertAfter", target: "dup", text: "Y" }, "f")).toThrow(
      /must be unique/,
    );
  });

  it("rejects a missing anchor (count === 0)", () => {
    expect(() => applyEdit(BASE, { op: "replace", target: "NOPE", text: "Y" }, "f")).toThrow(
      /not found/,
    );
  });

  it("rejects a single-target op with no target", () => {
    expect(() => applyEdit(BASE, { op: "replace", text: "Y" }, "f")).toThrow(/requires a "target"/);
  });
});

describe("resolveFiles", () => {
  const fetchBase: FetchBase = async (p) => (p === "exists.ts" ? BASE : null);

  it("passes content-mode entries through unchanged", async () => {
    const out = await resolveFiles([{ path: "new.ts", content: "C" }], fetchBase);
    expect(out).toEqual([{ path: "new.ts", content: "C" }]);
  });

  it("resolves edit-mode against the fetched base and preserves the rest of the file", async () => {
    const out = await resolveFiles(
      [{ path: "exists.ts", edits: [{ op: "replace", target: "ANCHOR", text: "Z" }] }],
      fetchBase,
    );
    expect(out[0].content).toBe("line1\nZ\nline3\nEND");
  });

  it("applies multiple edits to one file sequentially", async () => {
    const out = await resolveFiles(
      [{
        path: "exists.ts",
        edits: [
          { op: "replace", target: "ANCHOR", text: "A1" },
          { op: "insertAfter", target: "END", text: "A2" },
        ],
      }],
      fetchBase,
    );
    expect(out[0].content).toBe("line1\nA1\nline3\nEND\nA2");
  });

  it("preserves input order across mixed content + edit entries", async () => {
    const out = await resolveFiles(
      [
        { path: "a.ts", content: "AA" },
        { path: "exists.ts", edits: [{ op: "append", text: "TAIL" }] },
        { path: "b.ts", content: "BB" },
      ],
      fetchBase,
    );
    expect(out.map((f) => f.path)).toEqual(["a.ts", "exists.ts", "b.ts"]);
    expect(out[1].content).toBe(BASE + "\nTAIL");
  });

  it("rejects an entry with both content and edits", async () => {
    await expect(
      resolveFiles([{ path: "x", content: "a", edits: [{ op: "append", text: "b" }] }], fetchBase),
    ).rejects.toThrow(/not both/);
  });

  it("rejects an entry with neither content nor edits", async () => {
    await expect(resolveFiles([{ path: "x" }], fetchBase)).rejects.toThrow(/provide "content"/);
  });

  it("rejects edits against a file that does not exist on the base", async () => {
    await expect(
      resolveFiles([{ path: "missing.ts", edits: [{ op: "append", text: "b" }] }], fetchBase),
    ).rejects.toThrow(/does not exist yet/);
  });

  it("aggregates every problem into one error, not just the first", async () => {
    const err = await resolveFiles(
      [
        { path: "missing.ts", edits: [{ op: "append", text: "b" }] },
        { path: "bad.ts", edits: [{ op: "replace", target: "NOPE", text: "y" }], /* base missing */ }],
      // both paths are unknown to fetchBase → both fail
      fetchBase,
    ).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain("missing.ts");
    expect(err).toContain("bad.ts");
  });

  it("reports a fetchBase throw without aborting the whole resolve", async () => {
    const throwing: FetchBase = async () => {
      throw new Error("boom");
    };
    await expect(
      resolveFiles([{ path: "exists.ts", edits: [{ op: "append", text: "b" }] }], throwing),
    ).rejects.toThrow(/could not read the current file/);
  });
});
