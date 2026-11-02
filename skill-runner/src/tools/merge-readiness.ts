/**
 * Merge-readiness decision for `confirm_merge`, kept pure.
 *
 * Merging to main deploys to production (`.github/workflows/deploy.yml` runs on
 * push to main), so this is the one builder action with no undo. Every refusal
 * path therefore lives here, free of network and Durable Object access, and is
 * unit-tested — "it probably would have refused" is not good enough for a tool
 * that ships code.
 */

/**
 * What a builder run may merge on its own: the things the author wrote and owns
 * — skills, agents, actions, shared helpers, docs, tests.
 */
export const SELF_MERGE_ALLOWED_PREFIXES = ["_shared/", "docs/", "test/"] as const;

/**
 * Individual files outside those trees that a run may still merge, because a PR
 * adding a skill or action cannot avoid them:
 * - the two registries — a new entry MUST be registered (CLAUDE.md requires it,
 *   submit_for_review enforces it), and create_pull_request re-derives the file
 *   from main additively, so the model's version is not taken on trust;
 * - vault-keys.generated.ts — not written by the model at all. The server
 *   regenerates it during create_pull_request from vault.ts plus both registries.
 *
 * Without these, a typical builder PR would fall out of the lane and the whole
 * feature would do nothing.
 */
export const SELF_MERGE_ALLOWED_FILES = [
  "skill-runner/src/registry.ts",
  "agent-runner/src/registry.ts",
  "skill-runner/src/vault-keys.generated.ts",
] as const;

/**
 * Files inside the allowed trees that a run may NOT merge, whatever else is in
 * the diff.
 *
 * `_shared/lib/github.ts` is the one that matters and the reason is circular:
 * it mints the App installation token, performs the merge, and — through
 * getPullRequestReview — produces the approval state and CI status that
 * evaluateMergeReadiness trusts. A PR that makes that function always report
 * APPROVED would merge itself under the current rules and then unlock
 * everything after it. A file that decides whether you may self-merge cannot
 * live where you can self-merge.
 *
 * `_shared/lib/vault.ts` is deliberately NOT here. Blocking it would look
 * prudent and protect nothing: loadAIHubSecrets collects every Vault path into
 * one flat object and run-action.ts hands that whole object to every action as
 * ctx.env, so any action already holds every platform secret. Adding a key is
 * ordinary work on the way to a new action. The real boundary is per-action
 * secret scoping, which is not implemented yet.
 */
export const SELF_MERGE_DENIED_FILES = ["_shared/lib/github.ts"] as const;

/**
 * Services `deploy.yml` can deploy: every top-level dir with a wrangler.jsonc,
 * minus `gateway` (handled separately) and `_template`. Keep in step with
 * `.github/workflows/deploy.yml` — it discovers these at runtime, we cannot.
 */
export const DEPLOYABLE_SERVICES = ["skill-runner", "agent-runner"] as const;

/** The GitHub App account builder PRs are authored by. */
export const BUILDER_BOT_LOGIN = "ai-hub-acme[bot]";

/**
 * Why a missing approval is often not a missing review.
 *
 * ReviewBot skips re-reviewing a PR within 30 minutes of its last review
 * ("Skipping review due to cooldown", review-bot codereview service). Pushing a
 * fix inside that window dismisses the standing approval — branch protection
 * dismisses stale reviews — while the replacement review never runs, and
 * ReviewBot does not review retroactively. The PR then sits with no approval and
 * nothing on GitHub explaining why; the reason is only in ReviewBot's worker log.
 */
export const REVIEW_BOT_COOLDOWN_MINUTES = 30;

/**
 * How to get the missing review, in the order worth trying.
 *
 * ReviewBot's `request_pr_review` MCP tool (, shipped 2026-09-24) is
 * the real answer: the same forced review a "review-bot review" comment
 * triggers, reachable by someone with no access to the repository. It exists
 * because neither party in a builder run can use the comment escape hatch —
 * ReviewBot rejects bot-authored comments before mention detection (its own
 * review footer names the bot and contains "review", so without that guard
 * every review would trigger the next one), and the person driving the run is
 * usually a non-engineer with read access or none.
 *
 * The fallbacks stay, because the tool lives on ReviewBot's MCP server and not
 * every builder session has it connected.
 */
export const REVIEW_BOT_COOLDOWN_HINT =
  `ReviewBot refuses to re-review a PR within ${REVIEW_BOT_COOLDOWN_MINUTES} minutes of its previous review, and never ` +
  "reviews retroactively, so a fix pushed soon after a review dismisses the approval without earning a new one.\n" +
  "To get one: call ReviewBot's request_pr_review tool with this PR (pr_url, or repository plus pr_number). " +
  "It runs the forced review regardless of the cooldown, and refuses while a review of that PR is already " +
  "running — so call it once and wait, do not retry in a loop.\n" +
  "If that tool is not connected in this session, ask the user to comment on the PR mentioning " +
  "review-bot with the word \"review\" in it. Never post that comment from this tool: ReviewBot ignores " +
  "comments written by bots, so it would look like it worked and change nothing. If the user has no access " +
  "to the repository either, the remaining route is asking in #ai-hub.";

export interface MergeCandidateFile {
  path: string;
  additions: number;
  deletions: number;
}

/** PR facts read fresh from GitHub at decision time. */
export interface MergePrFacts {
  /** "open" | "closed". */
  state: string;
  authorLogin: string;
  headSha: string;
  checksAllPassed: boolean;
  checksStillRunning: boolean;
  checksFailed: number;
  checkCount: number;
  /**
   * State of ReviewBot's most recent review, or undefined when it never reviewed.
   * DISMISSED means a new commit invalidated the approval — not an approval.
   */
  latestReviewBotReviewState?: string;
  /** When that review was submitted (ISO 8601), used to tell a skip from a wait. */
  latestReviewBotReviewAt?: string;
}

export interface MergeReadinessInput {
  /** The PR this run opened, from the run record. Absent when the run never created one. */
  runPr?: { number: number; branch: string };
  runOwnerEmail?: string;
  callerEmail?: string;
  /** Gate labels still outstanding, from checkGates(). */
  missingGates: string[];
  pr: MergePrFacts;
  /** Clock, injectable so the cooldown arithmetic is testable. Defaults to Date.now(). */
  now?: number;
  files: MergeCandidateFile[];
  /**
   * True when the file listing was cut short. The path check can only be
   * trusted on a complete diff, so this is a refusal, never a warning.
   */
  filesTruncated?: boolean;
  /** What the user typed. Absent on the preview call. */
  confirmation?: string;
}

export interface MergePlan {
  prNumber: number;
  branch: string;
  headSha: string;
  fileCount: number;
  additions: number;
  deletions: number;
  files: MergeCandidateFile[];
  /** Services this merge will deploy to production. Empty = docs/tests only. */
  deploys: string[];
}

export type MergeReadiness =
  | { status: "refused"; reason: string }
  | { status: "needs_confirmation"; plan: MergePlan }
  | { status: "ready"; plan: MergePlan };

/**
 * Which services a merge deploys, mirroring the detection in deploy.yml.
 *
 * The `_shared/` rule is the one that surprises people: a change to a single
 * skill file redeploys BOTH runners, because every runner bundles `_shared`.
 */
export function deployImpact(paths: readonly string[]): string[] {
  const deploys = new Set<string>();
  if (paths.some((p) => p.startsWith("gateway/"))) deploys.add("gateway");
  if (paths.some((p) => p.startsWith("_shared/"))) {
    for (const service of DEPLOYABLE_SERVICES) deploys.add(service);
  }
  for (const service of DEPLOYABLE_SERVICES) {
    if (paths.some((p) => p.startsWith(`${service}/`))) deploys.add(service);
  }
  return [...deploys].sort();
}

/** Whole minutes since an ISO timestamp, or undefined when it is missing or unparseable. */
export function minutesSince(iso: string | undefined, now?: number): number | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.floor(((now ?? Date.now()) - then) / 60000));
}

/** True when a run may merge this path on its own. A denied file always wins. */
export function isSelfMergeable(path: string): boolean {
  if ((SELF_MERGE_DENIED_FILES as readonly string[]).includes(path)) return false;
  if ((SELF_MERGE_ALLOWED_FILES as readonly string[]).includes(path)) return true;
  return SELF_MERGE_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Paths a run may not merge on its own, in input order. */
export function pathsOutsideLane(paths: readonly string[]): string[] {
  return paths.filter((p) => !isSelfMergeable(p));
}

function buildPlan(runPr: { number: number; branch: string }, input: MergeReadinessInput): MergePlan {
  return {
    prNumber: runPr.number,
    branch: runPr.branch,
    headSha: input.pr.headSha,
    fileCount: input.files.length,
    additions: input.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: input.files.reduce((sum, f) => sum + f.deletions, 0),
    files: input.files,
    deploys: deployImpact(input.files.map((f) => f.path)),
  };
}

/**
 * Decides whether this run may merge its PR.
 *
 * Checks run cheapest-and-most-fundamental first, so the message a caller gets
 * names the real blocker rather than a downstream symptom. Ownership comes
 * before everything: a run can only ever merge the PR it opened itself, which
 * is what stops the builder merging somebody else's work.
 */
export function evaluateMergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const { runPr, pr, files } = input;

  if (!runPr) {
    return {
      status: "refused",
      reason:
        "This run has not created a pull request. confirm_merge can only merge the PR the same run opened — " +
        "call create_pull_request first.",
    };
  }

  // Identity is required, not merely compared. Guarding with
  // `runOwnerEmail && callerEmail && ...` would skip the check entirely whenever
  // the caller arrives without an identity — an anonymous session could then
  // merge a run it does not own. A merge reaches production, so an unknown
  // caller is a refusal, never a pass.
  if (!input.callerEmail) {
    return {
      status: "refused",
      reason:
        "confirm_merge needs to know who is calling, and this session has no identity. " +
        "Reconnect through the authenticated gateway, or ask a maintainer to merge.",
    };
  }
  if (!input.runOwnerEmail) {
    return {
      status: "refused",
      reason:
        `The run that opened PR #${runPr.number} has no recorded owner, so ownership cannot be established. ` +
        "Ask a maintainer to merge this one.",
    };
  }
  if (input.runOwnerEmail !== input.callerEmail) {
    return {
      status: "refused",
      reason: `PR #${runPr.number} belongs to a run opened by ${input.runOwnerEmail}. Only that user can merge it.`,
    };
  }

  if (input.missingGates.length > 0) {
    return {
      status: "refused",
      reason:
        `PR #${runPr.number} did not go through the full builder pipeline. Missing:\n` +
        input.missingGates.map((g) => `- ${g}`).join("\n"),
    };
  }

  if (pr.state !== "open") {
    return { status: "refused", reason: `PR #${runPr.number} is ${pr.state}, not open.` };
  }

  if (pr.authorLogin !== BUILDER_BOT_LOGIN) {
    return {
      status: "refused",
      reason:
        `PR #${runPr.number} was authored by ${pr.authorLogin}, not the builder (${BUILDER_BOT_LOGIN}). ` +
        "confirm_merge only merges builder-authored PRs; ask a maintainer to merge this one.",
    };
  }

  if (pr.checkCount === 0) {
    return {
      status: "refused",
      reason: `No CI checks have run on ${pr.headSha.slice(0, 7)}. An empty check set is not a green build — wait for PR Checks.`,
    };
  }
  if (pr.checksStillRunning) {
    return { status: "refused", reason: `CI is still running on ${pr.headSha.slice(0, 7)}. Poll get_pr_review until it finishes.` };
  }
  if (pr.checksFailed > 0 || !pr.checksAllPassed) {
    return {
      status: "refused",
      reason: `CI is not green on ${pr.headSha.slice(0, 7)} (${pr.checksFailed} of ${pr.checkCount} check(s) failed). Fix and push_fix_to_pr.`,
    };
  }

  if (pr.latestReviewBotReviewState !== "APPROVED") {
    const seen = pr.latestReviewBotReviewState
      ? `its latest review is ${pr.latestReviewBotReviewState}`
      : "it has not reviewed this PR";
    // Waiting and being stuck look identical on GitHub. They are not the same
    // thing, and telling the user to "wait for the re-review" when none is
    // coming is the difference between a minute and a dead end.
    const sinceMinutes = minutesSince(pr.latestReviewBotReviewAt, input.now);
    const diagnosis =
      sinceMinutes !== undefined && sinceMinutes < REVIEW_BOT_COOLDOWN_MINUTES
        ? `Its last review was ${sinceMinutes} minute(s) ago, inside the ${REVIEW_BOT_COOLDOWN_MINUTES}-minute cooldown, ` +
          "so a re-review of the current head was almost certainly skipped. Waiting will not produce one."
        : "Waiting may still produce one, but do not wait indefinitely.";
    return {
      status: "refused",
      reason:
        `ReviewBot has not approved PR #${runPr.number} — ${seen}. ` +
        `A DISMISSED approval means a later commit invalidated it. ${diagnosis}\n\n${REVIEW_BOT_COOLDOWN_HINT}`,
    };
  }

  // Judge the whole diff or none of it. A partial listing could hide a denied
  // file past the cut, and a guard that silently checks 1000 of 1200 files is
  // worse than no guard, because it reports success.
  if (input.filesTruncated) {
    return {
      status: "refused",
      reason:
        `The file list for PR #${runPr.number} came back incomplete (${files.length} entries, more remain), ` +
        "so what it changes cannot be established. A maintainer merges this one.",
    };
  }

  const strays = pathsOutsideLane(files.map((f) => f.path));
  if (strays.length > 0) {
    return {
      status: "refused",
      reason:
        `PR #${runPr.number} changes files a run may not merge on its own, so a maintainer merges this one:\n` +
        strays.map((p) => `- ${p}`).join("\n") +
        `\n\nconfirm_merge covers what you write — ${SELF_MERGE_ALLOWED_PREFIXES.join(", ")} plus the registry ` +
        `and generated files — but not the code that decides whether a merge is allowed.`,
    };
  }

  const plan = buildPlan(runPr, input);
  if (input.confirmation?.trim() !== String(runPr.number)) {
    return { status: "needs_confirmation", plan };
  }
  return { status: "ready", plan };
}

/** Human-readable summary of what a merge will do, shown before asking for confirmation. */
export function formatMergePlan(plan: MergePlan): string {
  const lines = [
    `PR #${plan.prNumber} — ${plan.branch}`,
    `Head: ${plan.headSha.slice(0, 7)}`,
    `Changes: ${plan.fileCount} file(s), +${plan.additions} −${plan.deletions}`,
    "",
    ...plan.files.map((f) => `  ${f.path} (+${f.additions} −${f.deletions})`),
    "",
  ];
  if (plan.deploys.length > 0) {
    lines.push(
      `Merging deploys to PRODUCTION: ${plan.deploys.join(", ")}.`,
      "Merge to main triggers deploy.yml — there is no separate release step.",
    );
  } else {
    lines.push("No service deploys from this change (docs/tests only).");
  }
  return lines.join("\n");
}
