import { describe, it, expect } from "vitest";
import { validateSubmission } from "../skill-runner/src/tools/validate-submission";

const KNOWN_REGISTRY = {
  skillEntries: ["alpha"],
  agentEntries: [],
  actionEntries: [],
  skillRunnerImportPaths: ["@shared/skills/x/alpha"],
  actionRunnerImportPaths: [],
} as const;

const baseOpts = {
  liveSkillsCount: 1,
  liveAgentsCount: 0,
  liveActionsCount: 0,
  knownVaultKeys: [] as string[],
  knownRegistry: KNOWN_REGISTRY,
};

describe("validateSubmission", () => {
  it("rejects fetch() inside a skill (skills are pure)", async () => {
    const { errors } = await validateSubmission(
      [{ path: "_shared/skills/x/beta.ts", content: "export const beta = defineSkill({}, async () => { await fetch('http://x'); });" }],
      baseOpts,
    );
    expect(errors.some((e) => e.includes("uses fetch()"))).toBe(true);
  });

  it("requires a registry update when a new skill is added", async () => {
    const { errors } = await validateSubmission(
      [{ path: "_shared/skills/x/beta.ts", content: "export const beta = defineSkill({}, async () => {});" }],
      baseOpts,
    );
    expect(errors.some((e) => e.includes("Missing: skill-runner/src/registry.ts"))).toBe(true);
  });

  it("flags removal of an existing registry entry", async () => {
    const registry = {
      path: "skill-runner/src/registry.ts",
      content: `export const skills = [ gamma ];\nexport const agents = [];`,
    };
    const { errors } = await validateSubmission([registry], baseOpts);
    expect(errors.some((e) => e.includes('"alpha" was REMOVED'))).toBe(true);
  });

  it("passes a well-formed registry that keeps existing entries", async () => {
    const registry = {
      path: "skill-runner/src/registry.ts",
      content: `export const skills = [ alpha, beta ];\nexport const agents = [];`,
    };
    const { errors } = await validateSubmission([registry], baseOpts);
    expect(errors.some((e) => e.includes("REMOVED"))).toBe(false);
  });

  describe("fix mode — entries introduced by the same PR", () => {
    // A new-in-PR skill: absent from KNOWN_REGISTRY (a snapshot of main), present on
    // the PR branch. Long enough that an edit of similar size clears the shrink floor.
    const BRANCH_BETA =
      `export const beta = defineSkill({ name: "x_beta" }, async (input) => {\n` +
      `  let value = 0;\n`.repeat(12) +
      `  return { value };\n});\n`;

    const fixOpts = {
      ...baseOpts,
      mode: "fix" as const,
      fetchMainFile: async () => null,
      fetchBranchFile: async (path: string) =>
        path === "_shared/skills/x/beta.ts" ? BRANCH_BETA : null,
    };

    it("allows fixing a skill that this PR introduced", async () => {
      const { errors } = await validateSubmission(
        [{ path: "_shared/skills/x/beta.ts", content: BRANCH_BETA.replace("let value = 0;", "const value = 0;") }],
        fixOpts,
      );
      expect(errors).toEqual([]);
    });

    it("still blocks adding a second define* export to a file on the branch", async () => {
      const { errors } = await validateSubmission(
        [{ path: "_shared/skills/x/beta.ts", content: `${BRANCH_BETA}\nexport const sneaky = defineSkill({}, async () => ({}));\n` }],
        fixOpts,
      );
      expect(errors.some((e) => e.includes("cannot introduce new skills") && e.includes("`sneaky`"))).toBe(true);
    });

    it("still blocks a brand-new skill file that is on neither main nor the branch", async () => {
      const { errors } = await validateSubmission(
        [{ path: "_shared/skills/x/gamma.ts", content: "export const gamma = defineSkill({}, async () => ({}));" }],
        fixOpts,
      );
      expect(errors.some((e) => e.includes("cannot introduce new skills") && e.includes("`gamma`"))).toBe(true);
    });

    it("applies the shrink floor to a new-in-PR file, baselined on the branch", async () => {
      const { errors } = await validateSubmission(
        [{ path: "_shared/skills/x/beta.ts", content: "export const beta = defineSkill({}, async () => ({}));" }],
        fixOpts,
      );
      expect(errors.some((e) => e.includes("the size of the PR branch"))).toBe(true);
    });

    it("flags a removed export on a new-in-PR file, baselined on the branch", async () => {
      const twoExports = `${BRANCH_BETA}\nexport const delta = defineSkill({ name: "x_delta" }, async () => ({}));\n`;
      const { errors } = await validateSubmission(
        [{ path: "_shared/skills/x/beta.ts", content: twoExports }],
        {
          ...fixOpts,
          fetchBranchFile: async (path: string) =>
            path === "_shared/skills/x/beta.ts" ? `${twoExports}\n${"// filler\n".repeat(20)}` : null,
        },
      );
      // Both exports are on the branch, so nothing is "introduced"...
      expect(errors.some((e) => e.includes("cannot introduce new skills"))).toBe(false);
      // ...and dropping one would be reported against the branch baseline.
      const dropped = await validateSubmission(
        [{ path: "_shared/skills/x/beta.ts", content: `${BRANCH_BETA}${"// filler\n".repeat(20)}` }],
        {
          ...fixOpts,
          fetchBranchFile: async (path: string) =>
            path === "_shared/skills/x/beta.ts" ? `${twoExports}\n${"// filler\n".repeat(20)}` : null,
        },
      );
      expect(dropped.errors.some((e) => e.includes("export const delta") && e.includes('"delta" already exists on the PR branch'))).toBe(true);
    });
  });
});
