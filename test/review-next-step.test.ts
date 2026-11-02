import { describe, it, expect } from "vitest";
import { reviewNextStep, type ReviewNextStepInput } from "../skill-runner/src/tools/review-next-step";

const NOW = Date.parse("2026-09-24T12:00:00Z");

/** CI green, ReviewBot approved — each test changes one thing. */
function green(overrides: Partial<ReviewNextStepInput> = {}): ReviewNextStepInput {
  return {
    branch: "feat/x",
    checks: { runs: [{}], stillRunning: false, failed: 0 },
    reviewBotCommentCount: 1,
    latestReviewBotReviewState: "APPROVED",
    latestReviewBotReviewAt: "2026-09-24T11:50:00Z",
    now: NOW,
    ...overrides,
  };
}

describe("reviewNextStep — CI comes first", () => {
  it("running CI says wait, whatever ReviewBot said", () => {
    const step = reviewNextStep(green({ checks: { runs: [{}], stillRunning: true, failed: 0 } }));
    expect(step).toContain("still running");
    expect(step).not.toContain("confirm_merge");
  });

  it("failed CI says fix, whatever ReviewBot said", () => {
    const step = reviewNextStep(green({ checks: { runs: [{}, {}], stillRunning: false, failed: 1 } }));
    expect(step).toContain("CI FAILED (1 of 2");
    expect(step).toContain('branch "feat/x"');
    expect(step).not.toContain("confirm_merge");
  });

  it("no checks is not a green build", () => {
    const step = reviewNextStep(green({ checks: { runs: [], stillRunning: false, failed: 0 } }));
    expect(step).toContain("NOT a green build");
    expect(step).not.toContain("confirm_merge");
  });
});

describe("reviewNextStep — the ReviewBot verdict decides the rest", () => {
  // The gap this exists to close: an approved PR used to be told to STOP.
  it("APPROVED offers the merge from the chat", () => {
    const step = reviewNextStep(green());
    expect(step).toContain("APPROVED");
    expect(step).toContain("confirm_merge");
    expect(step).not.toContain("STOP");
  });

  // Observed: a DISMISSED review still counts as a comment, so the old
  // count-based branch said "address comments" while no review was coming.
  it("DISMISSED inside the cooldown says no re-review is coming and points at request_pr_review", () => {
    const step = reviewNextStep(green({ latestReviewBotReviewState: "DISMISSED", latestReviewBotReviewAt: "2026-09-24T11:57:00Z" }));
    expect(step).toContain("DISMISSED");
    expect(step).toContain("3 minute(s) ago");
    expect(step).toContain("no re-review is coming");
    expect(step).toContain("request_pr_review");
    expect(step).not.toContain("confirm_merge with");
  });

  it("DISMISSED outside the cooldown still points at request_pr_review, without claiming a skip", () => {
    const step = reviewNextStep(green({ latestReviewBotReviewState: "DISMISSED", latestReviewBotReviewAt: "2026-09-24T10:00:00Z" }));
    expect(step).toContain("request_pr_review");
    expect(step).not.toContain("minute(s) ago");
  });

  it.each(["COMMENTED", "CHANGES_REQUESTED"])("%s asks for fixes and says approval is still needed", (state) => {
    const step = reviewNextStep(green({ latestReviewBotReviewState: state }));
    expect(step).toContain(`latest verdict ${state}`);
    expect(step).toContain("push_fix_to_pr");
    expect(step).toContain("needs an APPROVED review");
    expect(step).toContain("request_pr_review");
  });

  it("comments without any review decision are treated as feedback to address", () => {
    const step = reviewNextStep(green({ latestReviewBotReviewState: undefined, reviewBotCommentCount: 2 }));
    expect(step).toContain("2 comment(s)");
    expect(step).toContain("push_fix_to_pr");
  });

  it("no review yet says wait, with the cooldown fallback", () => {
    const step = reviewNextStep(green({ latestReviewBotReviewState: undefined, latestReviewBotReviewAt: undefined, reviewBotCommentCount: 0 }));
    expect(step).toContain("No ReviewBot review yet");
    expect(step).toContain("request_pr_review");
  });
});
