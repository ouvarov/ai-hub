import { describe, it, expect } from "vitest";
import {
  deriveRegistry,
  arrayEntries,
  importPaths,
  sameSemantics,
  type NewRegistryEntry,
} from "../skill-runner/src/tools/derive-registry";

const MAIN = `import type { Skill, Agent } from "@shared/types";

import { alpha } from "@shared/skills/x/alpha";
import { beta } from "@shared/skills/x/beta";

// domain: core skills — keep this comment
export const skills: Skill<any, any>[] = [
  alpha,
  beta,
];

export const agents: Agent<any, any>[] = [
  gammaAgent,
];
`;

const NEW: NewRegistryEntry[] = [
  { exportName: "delta", importPath: "@shared/skills/x/delta", arrayName: "skills" },
];

describe("deriveRegistry", () => {
  it("adds a new import and array entry", () => {
    const out = deriveRegistry(MAIN, NEW);
    expect(out).toContain('import { delta } from "@shared/skills/x/delta";');
    expect(arrayEntries(out, "skills")).toEqual(["alpha", "beta", "delta"]);
  });

  it("preserves existing comments byte-for-byte", () => {
    const out = deriveRegistry(MAIN, NEW);
    expect(out).toContain("// domain: core skills — keep this comment");
  });

  it("is idempotent — re-running adds nothing", () => {
    const once = deriveRegistry(MAIN, NEW);
    expect(deriveRegistry(once, NEW)).toBe(once);
  });

  it("is a no-op (byte-identical) when there is nothing to add", () => {
    expect(deriveRegistry(MAIN, [])).toBe(MAIN);
  });

  it("does not touch a sibling array", () => {
    const out = deriveRegistry(MAIN, NEW);
    expect(arrayEntries(out, "agents")).toEqual(arrayEntries(MAIN, "agents"));
  });

  it("targets the correct array (agents vs skills)", () => {
    const out = deriveRegistry(MAIN, [
      { exportName: "deltaAgent", importPath: "@shared/agents/delta", arrayName: "agents" },
    ]);
    expect(arrayEntries(out, "agents")).toContain("deltaAgent");
    expect(arrayEntries(out, "skills")).not.toContain("deltaAgent");
  });
});

describe("sameSemantics / importPaths", () => {
  it("treats a pure add as a semantic difference", () => {
    expect(sameSemantics(MAIN, deriveRegistry(MAIN, NEW))).toBe(false);
  });

  it("is order-insensitive on entries", () => {
    const reordered = MAIN.replace("  alpha,\n  beta,", "  beta,\n  alpha,");
    expect(sameSemantics(MAIN, reordered)).toBe(true);
  });

  it("extracts @shared import specifiers", () => {
    expect(importPaths(MAIN)).toContain("@shared/skills/x/alpha");
    expect(importPaths(MAIN)).toContain("@shared/types");
  });
});
