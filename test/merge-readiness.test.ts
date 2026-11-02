import { describe, it, expect } from "vitest";
import {
  deployImpact,
  evaluateMergeReadiness,
  formatMergePlan,
  isSelfMergeable,
  minutesSince,
  pathsOutsideLane,
  BUILDER_BOT_LOGIN,
  type MergeReadinessInput,
} from "../skill-runner/src/tools/merge-readiness";

/** A run that has done everything right — each test breaks exactly one thing. */
function ready(overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput {
  return {
    runPr: { number: 451, branch: "fix/reading-reference-schema" },
    runOwnerEmail: "author@example.com",
    callerEmail: "author@example.com",
    missingGates: [],
    pr: {
      state: "open",
      authorLogin: BUILDER_BOT_LOGIN,
      headSha: "abc1234def5678",
      checksAllPassed: true,
      checksStillRunning: false,
      checksFailed: 0,
      checkCount: 1,
      latestReviewBotReviewState: "APPROVED",
    },
    files: [{ path: "_shared/skills/reading/parse-reference.ts", additions: 12, deletions: 3 }],
    confirmation: "451",
    ...overrides,
  };
}

describe("evaluateMergeReadiness — the happy path", () => {
  it("merges a confirmed, green, approved content-lane PR", () => {
    const result = evaluateMergeReadiness(ready());
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.prNumber).toBe(451);
    expect(result.plan.additions).toBe(12);
    expect(result.plan.deletions).toBe(3);
  });

  it("asks for confirmation when none was given", () => {
    const result = evaluateMergeReadiness(ready({ confirmation: undefined }));
    expect(result.status).toBe("needs_confirmation");
  });

  it("tolerates whitespace around the typed number", () => {
    expect(evaluateMergeReadiness(ready({ confirmation: " 451 " })).status).toBe("ready");
  });
});

describe("evaluateMergeReadiness — a wrong confirmation is not a merge", () => {
  it("does not accept a different number", () => {
    expect(evaluateMergeReadiness(ready({ confirmation: "450" })).status).toBe("needs_confirmation");
  });

  it("does not accept 'yes'", () => {
    expect(evaluateMergeReadiness(ready({ confirmation: "yes" })).status).toBe("needs_confirmation");
  });

  it("does not accept an empty string", () => {
    expect(evaluateMergeReadiness(ready({ confirmation: "" })).status).toBe("needs_confirmation");
  });
});

describe("evaluateMergeReadiness — it cannot merge other people's work", () => {
  it("refuses when the run never opened a PR", () => {
    const result = evaluateMergeReadiness(ready({ runPr: undefined }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("has not created a pull request");
  });

  it("refuses when the caller is not the run owner", () => {
    const result = evaluateMergeReadiness(ready({ callerEmail: "someone.else@example.com" }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("author@example.com");
  });

  it("refuses an unidentified caller instead of skipping the ownership check", () => {
    const result = evaluateMergeReadiness(ready({ callerEmail: undefined }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("no identity");
  });

  it("refuses when the run has no recorded owner", () => {
    const result = evaluateMergeReadiness(ready({ runOwnerEmail: undefined }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("no recorded owner");
  });

  it("refuses when neither side has an identity — two blanks are not a match", () => {
    expect(
      evaluateMergeReadiness(ready({ callerEmail: undefined, runOwnerEmail: undefined })).status,
    ).toBe("refused");
  });

  it("refuses an empty-string caller, not just a missing one", () => {
    expect(evaluateMergeReadiness(ready({ callerEmail: "" })).status).toBe("refused");
  });

  it("refuses a PR that a human opened, even when everything else is green", () => {
    const result = evaluateMergeReadiness(ready({ pr: { ...ready().pr, authorLogin: "some-user" } }));
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("some-user");
  });
});

describe("evaluateMergeReadiness — the pipeline must have run", () => {
  it("refuses when a gate is outstanding, naming it", () => {
    const result = evaluateMergeReadiness(
      ready({ missingGates: ["run_bmad (discovery or elicitation)", "submit_final (BMAD review findings)"] }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("run_bmad");
    expect(result.reason).toContain("submit_final");
  });

  it("ranks the missing gate above a missing confirmation", () => {
    const result = evaluateMergeReadiness(ready({ missingGates: ["submit_final"], confirmation: undefined }));
    expect(result.status).toBe("refused");
  });
});

describe("evaluateMergeReadiness — CI", () => {
  it("refuses while checks are still running", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, checksStillRunning: true, checksAllPassed: false } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("still running");
  });

  it("treats zero checks as not green", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, checkCount: 0, checksAllPassed: false } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("No CI checks");
  });

  it("refuses a failed build", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, checksFailed: 1, checksAllPassed: false } }),
    );
    expect(result.status).toBe("refused");
  });
});

describe("evaluateMergeReadiness — the review must be standing", () => {
  it("refuses when ReviewBot never reviewed", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: undefined } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("not reviewed this PR");
  });

  it("refuses a DISMISSED approval — a real race", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: "DISMISSED" } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("DISMISSED");
  });

  it("explains the cooldown, so a stalled PR is not mistaken for a slow review", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: "DISMISSED" } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("30 minutes");
    expect(result.reason).toContain("review-bot");
  });

  it("points at request_pr_review as the way to get a review", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: "DISMISSED" } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("request_pr_review");
  });

  it("tells the builder not to post the mention itself — ReviewBot ignores bot comments", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: "DISMISSED" } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("Never post that comment from this tool");
  });

  it("says waiting is pointless when the last review is inside the cooldown", () => {
    const now = Date.parse("2026-09-24T08:10:00Z");
    const result = evaluateMergeReadiness(
      ready({
        now,
        pr: {
          ...ready().pr,
          latestReviewBotReviewState: "DISMISSED",
          latestReviewBotReviewAt: "2026-09-24T07:51:00Z",
        },
      }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("19 minute(s) ago");
    expect(result.reason).toContain("Waiting will not produce one");
  });

  it("does not claim a skip once the cooldown has passed", () => {
    const now = Date.parse("2026-09-24T09:00:00Z");
    const result = evaluateMergeReadiness(
      ready({
        now,
        pr: {
          ...ready().pr,
          latestReviewBotReviewState: "DISMISSED",
          latestReviewBotReviewAt: "2026-09-24T07:51:00Z",
        },
      }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).not.toContain("Waiting will not produce one");
  });

  it("stays silent about timing when the review timestamp is unknown", () => {
    const result = evaluateMergeReadiness(
      ready({ pr: { ...ready().pr, latestReviewBotReviewState: "DISMISSED", latestReviewBotReviewAt: undefined } }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("do not wait indefinitely");
  });

  it("refuses CHANGES_REQUESTED", () => {
    expect(
      evaluateMergeReadiness(ready({ pr: { ...ready().pr, latestReviewBotReviewState: "CHANGES_REQUESTED" } })).status,
    ).toBe("refused");
  });

  it("refuses a closed PR", () => {
    expect(evaluateMergeReadiness(ready({ pr: { ...ready().pr, state: "closed" } })).status).toBe("refused");
  });
});

describe("evaluateMergeReadiness — what a run may merge itself", () => {
  it("allows an action — the author writes it and owns it", () => {
    expect(
      evaluateMergeReadiness(
        ready({ files: [{ path: "_shared/actions/reading/reference-describe.ts", additions: 20, deletions: 2 }] }),
      ).status,
    ).toBe("ready");
  });

  it("allows the registry files — a new skill cannot be wired up without them", () => {
    const result = evaluateMergeReadiness(
      ready({
        files: [
          { path: "_shared/skills/l10n/glossary.ts", additions: 30, deletions: 0 },
          { path: "skill-runner/src/registry.ts", additions: 2, deletions: 0 },
          { path: "agent-runner/src/registry.ts", additions: 2, deletions: 0 },
          { path: "skill-runner/src/vault-keys.generated.ts", additions: 1, deletions: 1 },
        ],
      }),
    );
    expect(result.status).toBe("ready");
  });

  it("allows vault.ts — adding a key is ordinary work on the way to a new action", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "_shared/lib/vault.ts", additions: 4, deletions: 0 }] })).status,
    ).toBe("ready");
  });

  it("allows an ordinary shared helper", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "_shared/lib/geo/sheets.ts", additions: 8, deletions: 1 }] }))
        .status,
    ).toBe("ready");
  });

  it("allows docs and tests alongside shared code", () => {
    const result = evaluateMergeReadiness(
      ready({
        files: [
          { path: "_shared/skills/l10n/glossary.ts", additions: 9, deletions: 1 },
          { path: "docs/adr/l10n-glossary.md", additions: 30, deletions: 0 },
          { path: "test/l10n/shared-knowledge.test.ts", additions: 12, deletions: 0 },
        ],
      }),
    );
    expect(result.status).toBe("ready");
  });
});

describe("evaluateMergeReadiness — it may not rewrite the rules", () => {
  it("refuses _shared/lib/github.ts — the file the guard itself reads", () => {
    const result = evaluateMergeReadiness(
      ready({
        files: [
          { path: "_shared/skills/reading/parse-brief.ts", additions: 4, deletions: 0 },
          { path: "_shared/lib/github.ts", additions: 3, deletions: 3 },
        ],
      }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("_shared/lib/github.ts");
  });

  it("refuses the builder's own merge logic", () => {
    expect(
      evaluateMergeReadiness(
        ready({ files: [{ path: "skill-runner/src/tools/merge-readiness.ts", additions: 1, deletions: 1 }] }),
      ).status,
    ).toBe("refused");
  });

  it("refuses the builder's instructions — policy, not content", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "CLAUDE.md", additions: 5, deletions: 5 }] })).status,
    ).toBe("refused");
  });

  it("refuses CI and deploy config", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: ".github/workflows/deploy.yml", additions: 1, deletions: 1 }] }))
        .status,
    ).toBe("refused");
  });

  it("refuses the gateway", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "gateway/src/index.ts", additions: 2, deletions: 1 }] })).status,
    ).toBe("refused");
  });

  it("refuses a lockfile change", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "pnpm-lock.yaml", additions: 40, deletions: 2 }] })).status,
    ).toBe("refused");
  });

  it("refuses a runner file that is not one of the three named exceptions", () => {
    expect(
      evaluateMergeReadiness(ready({ files: [{ path: "skill-runner/src/index.ts", additions: 1, deletions: 0 }] }))
        .status,
    ).toBe("refused");
  });
});

describe("evaluateMergeReadiness — an incomplete diff is not a clean diff", () => {
  it("refuses when the file listing was truncated, even though every listed path is allowed", () => {
    const result = evaluateMergeReadiness(
      ready({ files: [{ path: "_shared/skills/x.ts", additions: 1, deletions: 0 }], filesTruncated: true }),
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toContain("incomplete");
  });

  it("refuses a truncated listing before asking for confirmation", () => {
    expect(
      evaluateMergeReadiness(
        ready({
          files: [{ path: "docs/adr/x.md", additions: 1, deletions: 0 }],
          filesTruncated: true,
          confirmation: undefined,
        }),
      ).status,
    ).toBe("refused");
  });

  it("proceeds normally when the listing is complete", () => {
    expect(
      evaluateMergeReadiness(
        ready({ files: [{ path: "_shared/skills/x.ts", additions: 1, deletions: 0 }], filesTruncated: false }),
      ).status,
    ).toBe("ready");
  });
});

describe("isSelfMergeable", () => {
  it("denies github.ts even though _shared/ is allowed — deny wins over prefix", () => {
    expect(isSelfMergeable("_shared/lib/github.ts")).toBe(false);
    expect(isSelfMergeable("_shared/lib/vault.ts")).toBe(true);
  });

  it("does not let a prefix lookalike through", () => {
    expect(isSelfMergeable("_sharedish/evil.ts")).toBe(false);
    expect(isSelfMergeable("docsy/evil.md")).toBe(false);
  });

  it("allows only the exact named runner files", () => {
    expect(isSelfMergeable("skill-runner/src/registry.ts")).toBe(true);
    expect(isSelfMergeable("skill-runner/src/registry.ts.bak")).toBe(false);
    expect(isSelfMergeable("skill-runner/src/tools/github-pr.ts")).toBe(false);
  });
});

describe("pathsOutsideLane", () => {
  it("returns only the offenders, in order", () => {
    expect(
      pathsOutsideLane(["_shared/a.ts", "gateway/b.ts", "docs/c.md", "package.json"]),
    ).toEqual(["gateway/b.ts", "package.json"]);
  });

  it("is empty for a diff a run owns end to end", () => {
    expect(
      pathsOutsideLane(["_shared/actions/x.ts", "skill-runner/src/registry.ts", "docs/adr/x.md"]),
    ).toEqual([]);
  });
});

describe("deployImpact — mirrors deploy.yml", () => {
  it("redeploys BOTH runners for any _shared change", () => {
    expect(deployImpact(["_shared/skills/reading/parse-brief.ts"])).toEqual(["agent-runner", "skill-runner"]);
  });

  it("deploys nothing for docs and tests only", () => {
    expect(deployImpact(["docs/adr/x.md", "test/y.test.ts"])).toEqual([]);
  });

  it("deploys the gateway when the gateway changes", () => {
    expect(deployImpact(["gateway/src/index.ts"])).toEqual(["gateway"]);
  });

  it("deploys just the service that changed", () => {
    expect(deployImpact(["skill-runner/src/registry.ts"])).toEqual(["skill-runner"]);
  });

  it("does not duplicate a service hit by both rules", () => {
    expect(deployImpact(["_shared/a.ts", "skill-runner/src/registry.ts"])).toEqual([
      "agent-runner",
      "skill-runner",
    ]);
  });
});

describe("minutesSince", () => {
  it("floors to whole minutes", () => {
    expect(minutesSince("2026-09-24T07:51:00Z", Date.parse("2026-09-24T08:10:59Z"))).toBe(19);
  });

  it("returns undefined for a missing or unparseable timestamp", () => {
    expect(minutesSince(undefined)).toBeUndefined();
    expect(minutesSince("not a date")).toBeUndefined();
  });

  it("never goes negative on a clock skew", () => {
    expect(minutesSince("2026-09-24T08:10:00Z", Date.parse("2026-09-24T08:00:00Z"))).toBe(0);
  });
});

describe("formatMergePlan", () => {
  it("spells out the production deploy", () => {
    const result = evaluateMergeReadiness(ready({ confirmation: undefined }));
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    const text = formatMergePlan(result.plan);
    expect(text).toContain("PRODUCTION");
    expect(text).toContain("skill-runner");
    expect(text).toContain("_shared/skills/reading/parse-reference.ts");
  });

  it("says plainly when nothing deploys", () => {
    const result = evaluateMergeReadiness(
      ready({ confirmation: undefined, files: [{ path: "docs/adr/x.md", additions: 5, deletions: 0 }] }),
    );
    expect(result.status).toBe("needs_confirmation");
    if (result.status !== "needs_confirmation") return;
    expect(formatMergePlan(result.plan)).toContain("No service deploys");
  });
});
