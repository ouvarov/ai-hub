/**
 * What get_pr_review tells the caller to do next, kept pure so every branch is testable.
 *
 * The caller follows nextStep more closely than any doc, so this is where the path from
 * "PR open" to "merged" has to live. It used to branch on the ReviewBot comment count alone,
 * which broke in both directions: an APPROVED PR was told to STOP without a word about
 * confirm_merge, and a PR whose approval had just been dismissed — a DISMISSED review still
 * counts as a comment — was told to address comments while no new review was coming.
 */
import { REVIEW_BOT_COOLDOWN_HINT, REVIEW_BOT_COOLDOWN_MINUTES, minutesSince } from "./merge-readiness";

export interface ReviewNextStepInput {
  branch: string;
  checks: { runs: unknown[]; stillRunning: boolean; failed: number };
  reviewBotCommentCount: number;
  latestReviewBotReviewState?: string;
  latestReviewBotReviewAt?: string;
  /** Clock, injectable for tests. */
  now?: number;
}

export function reviewNextStep(input: ReviewNextStepInput): string {
  const { checks: c, branch } = input;
  const total = c.runs.length;

  if (c.stillRunning) {
    return `CI is still running (${total} check(s), not yet complete). Wait ~30s and call get_pr_review again — do NOT merge or declare success yet.`;
  }
  if (c.failed > 0) {
    return `CI FAILED (${c.failed} of ${total} check(s)). Read the returned failureLogs, fix the cause, then push_fix_to_pr on branch "${branch}" — the new commit re-runs CI. Re-poll get_pr_review until checks.allPassed before merging.`;
  }
  if (total === 0) {
    return `No CI checks have run on the head commit yet — this is NOT a green build. Wait ~30s and call get_pr_review again; if checks never appear, verify in the PR UI whether CI is expected to run before merging.`;
  }

  const green = `CI is green (${total} check(s) passed)`;
  const state = input.latestReviewBotReviewState;

  if (state === "APPROVED") {
    return (
      `${green} and ReviewBot's latest review is APPROVED. The PR is ready to merge from this chat — no maintainer needed. ` +
      `Tell the user, and if they want it merged call confirm_merge with this run's runId and no "confirm" to get the preview. ` +
      `It may still refuse (for example when the PR touches AI Hub's core); if it does, relay the reason — a maintainer merges that one.`
    );
  }

  if (state === "DISMISSED") {
    const since = minutesSince(input.latestReviewBotReviewAt, input.now);
    const when =
      since !== undefined && since < REVIEW_BOT_COOLDOWN_MINUTES
        ? `Its last review was ${since} minute(s) ago, inside the ${REVIEW_BOT_COOLDOWN_MINUTES}-minute cooldown, so no re-review is coming on its own. `
        : "";
    return (
      `${green}, but ReviewBot's approval was DISMISSED — a later commit invalidated it, and without a fresh approval the PR cannot be merged. ` +
      `${when}Do not keep polling.\n${REVIEW_BOT_COOLDOWN_HINT}`
    );
  }

  if (input.reviewBotCommentCount === 0 && !state) {
    return (
      `${green}. No ReviewBot review yet — the bot is event-driven; wait ~30s and call get_pr_review again (up to a ~5-minute cap). ` +
      `If the cap passes with nothing, do NOT assume the review is merely slow: ${REVIEW_BOT_COOLDOWN_HINT}`
    );
  }

  // COMMENTED, CHANGES_REQUESTED, or comments with no review decision.
  return (
    `${green} and ReviewBot has reviewed (${input.reviewBotCommentCount} comment(s))${state ? `, latest verdict ${state}` : ""}. ` +
    `Address each actionable comment: fix and push with push_fix_to_pr on branch "${branch}" (skip nits/false positives with a brief reason). ` +
    `The PR needs an APPROVED review before it can be merged. A fix pushed within ${REVIEW_BOT_COOLDOWN_MINUTES} minutes of the last review will not be re-reviewed automatically — ` +
    `if get_pr_review after your push still shows no new review, use ReviewBot's request_pr_review as described here:\n${REVIEW_BOT_COOLDOWN_HINT}`
  );
}
