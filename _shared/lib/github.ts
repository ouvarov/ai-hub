/**
 * GitHub App authentication and PR creation for Cloudflare Workers.
 *
 * Uses Web Crypto API (no external dependencies) to:
 * 1. Sign a JWT with the App's RSA private key
 * 2. Exchange it for an installation access token
 * 3. Create branches, commits, and pull requests via GitHub REST API
 *
 * Usage:
 *   const gh = createGitHubClient({
 *     appId: env.GITHUB_APP_ID,
 *     installationId: env.GITHUB_APP_INSTALLATION_ID,
 *     privateKey: env.GITHUB_APP_PRIVATE_KEY,
 *   });
 *   const result = await gh.createPullRequest({ ... });
 */

const GITHUB_API = "https://api.github.com";


/**
 * Check-run conclusions that count as a real CI failure
 * (vs. neutral / skipped / success / null).
 */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

class GHError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKey: string; // PEM-encoded RSA private key
}

export interface FileEntry {
  path: string;
  content: string;
}

export interface CreatePRInput {
  owner: string;
  repo: string;
  /** Branch name to create (e.g. "feat/design-checker-agent") */
  branch: string;
  /** Base branch to branch from and PR into (default: "main") */
  base?: string;
  title: string;
  body: string;
  files: FileEntry[];
}

export interface CreatePRResult {
  prUrl: string;
  prNumber: number;
  branch: string;
}

export interface CreateIssueInput {
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreateIssueResult {
  issueUrl: string;
  issueNumber: number;
}

export interface PushFixInput {
  owner: string;
  repo: string;
  /** Existing branch to push to (e.g. from an open PR) */
  branch: string;
  commitMessage: string;
  files: FileEntry[];
  /** Files to delete from the branch */
  deletedFiles?: string[];
  /** Base branch to merge from before pushing (default: "main") */
  base?: string;
}

export interface PushFixResult {
  branch: string;
  commitSha: string;
  /** Whether a merge with base was performed before the fix */
  mergedBase: boolean;
  /** Files that were auto-resolved during merge */
  resolvedFiles?: string[];
}

/** One review comment on a PR — a review summary, an inline code comment, or a general issue comment. */
export interface PullRequestComment {
  /** Where the comment came from: a submitted review, an inline code comment, or a general PR comment. */
  kind: "review" | "review_comment" | "issue_comment";
  author: string;
  /** GitHub account type — "Bot" for app/bot accounts, "User" otherwise. */
  authorType: string;
  /** True when authored by the ReviewBot review bot. */
  isReviewBot: boolean;
  body: string;
  /** Review state (APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED) — only for kind "review". */
  state?: string;
  /** File path — only for inline "review_comment". */
  path?: string;
  /** Line number — only for inline "review_comment". */
  line?: number | null;
  htmlUrl: string;
  createdAt: string;
}

/** One CI check run (a GitHub Actions job, or any app-posted check) on the PR head. */
export interface CheckRun {
  /** The check run's id (used to fetch its Actions job log). */
  id: number;
  name: string;
  /** "queued" | "in_progress" | "completed". */
  status: string;
  /** When completed: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "neutral" | "skipped" | null. */
  conclusion: string | null;
  detailsUrl: string;
}

export interface PullRequestChecks {
  /** All check runs on the PR head commit. */
  runs: CheckRun[];
  /** True while any check is still queued/in_progress — the build has NOT finished. */
  stillRunning: boolean;
  /** Number of completed checks whose conclusion is a real failure. */
  failed: number;
  /** True when every check completed with a passing/neutral conclusion. */
  allPassed: boolean;
}

export interface PullRequestReviewResult {
  prNumber: number;
  /** PR state: "open" | "closed". */
  state: string;
  /** Login of the account that opened the PR (e.g. "ai-hub-acme[bot]"). */
  authorLogin: string;
  /** Head branch of the PR — pass this to pushFix to push fixes. */
  branch: string;
  /** Head commit SHA of the PR. */
  headSha: string;

  /** CI check status on the PR head commit. */
  checks: PullRequestChecks;
  /** All comments (reviews + inline + general), oldest first. */
  comments: PullRequestComment[];
  /** Count of comments authored by the ReviewBot review bot. */
  reviewBotCommentCount: number;
  /**
   * State of ReviewBot's most recent review: "APPROVED" | "CHANGES_REQUESTED" |
   * "COMMENTED" | "DISMISSED", or undefined when it has never reviewed.
   *
   * Computed from the raw reviews list rather than from `comments`, which drops
   * empty review shells — a DISMISSED review usually has no body, so reading
   * `comments` would leave a stale APPROVED looking like the latest word.
   */
  latestReviewBotReviewState?: string;
  /**
   * When ReviewBot's most recent review was submitted (ISO 8601), or undefined
   * when it has never reviewed. Read with the state: ReviewBot refuses to
   * re-review a PR within 30 minutes of its last one, so "no approval" a few
   * minutes after a review means the re-review was skipped, not that it is
   * still running.
   */
  latestReviewBotReviewAt?: string;
}

/** Tail of a failed CI job's log, so the builder can see what to fix. */
export interface FailedCheckLog {
  jobName: string;
  conclusion: string | null;
  /** Last lines of the job log (the actual tsc/eslint/vitest error output). */
  logTail: string;
}

/** One file in a PR diff. */
export interface PullRequestFile {
  path: string;
  /** "added" | "modified" | "removed" | "renamed" | ... */
  status: string;
  additions: number;
  deletions: number;
}

/** A PR's file list, and whether it is the whole of it. */
export interface PullRequestFileList {
  files: PullRequestFile[];
  /**
   * True when the listing stopped before the end of the diff. A caller deciding
   * whether a merge is allowed MUST refuse on this rather than judge a partial
   * list — GitHub's files endpoint caps at 3000 entries, so a large enough PR
   * can hide a file past the end.
   */
  truncated: boolean;
}

export interface MergePRInput {
  owner: string;
  repo: string;
  prNumber: number;
  /**
   * Head SHA the PR must still be at for the merge to go through. GitHub rejects
   * the call with 409 when the head has moved, which is what stops a commit
   * landing between the user confirming and the merge happening.
   */
  sha: string;
  commitTitle?: string;
  commitMessage?: string;
}

export interface MergePRResult {
  merged: boolean;
  /** SHA of the resulting commit on the base branch. */
  sha: string;
  message: string;
}

export interface GitHubClient {
  createPullRequest(input: CreatePRInput): Promise<CreatePRResult>;
  createIssue(input: CreateIssueInput): Promise<CreateIssueResult>;
  /** Fetch a file's text content from a repo. Returns null if not found. */
  getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null>;
  /** Push fix commits to an existing branch (e.g. after code review on a PR) */
  pushFix(input: PushFixInput): Promise<PushFixResult>;
  /** Read reviews + inline + general comments + CI check status on a PR. */
  getPullRequestReview(owner: string, repo: string, prNumber: number): Promise<PullRequestReviewResult>;
  /** Fetch the tail of each failed check run's log, so the builder can see what to fix. */
  getFailedCheckLogs(owner: string, repo: string, runs: CheckRun[]): Promise<FailedCheckLog[]>;
  /** List the files a PR changes, with per-file line counts, flagging an incomplete listing. */
  getPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFileList>;
  /** Squash-merge a PR, but only while its head is still at `sha`. */
  mergePullRequest(input: MergePRInput): Promise<MergePRResult>;
}

/** The ReviewBot review bot appears as "review-bot" or "review-bot[bot]". */
function isReviewBotLogin(login: string | undefined): boolean {
  return !!login && login.toLowerCase().includes("review-bot");
}

// ── JWT helpers (Web Crypto, no dependencies) ───────────────────

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64Url(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

/** Parse PEM private key → CryptoKey for RS256 signing */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryString = atob(pemBody);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Try PKCS#8 first, fall back to PKCS#1
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // PKCS#1 (RSA PRIVATE KEY) — wrap in PKCS#8 envelope
    return await crypto.subtle.importKey(
      "pkcs8",
      wrapPkcs1InPkcs8(bytes),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
}

/** Wrap a PKCS#1 RSA key in a PKCS#8 envelope for Web Crypto */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): ArrayBuffer {
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  const octetString = asn1Wrap(0x04, pkcs1);
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  const totalLen = version.length + rsaOid.length + octetString.length;
  const result = new Uint8Array(2 + lengthBytes(totalLen).length + totalLen);
  let offset = 0;
  result[offset++] = 0x30;
  const lenBytes = lengthBytes(totalLen);
  result.set(lenBytes, offset);
  offset += lenBytes.length;
  result.set(version, offset);
  offset += version.length;
  result.set(rsaOid, offset);
  offset += rsaOid.length;
  result.set(octetString, offset);

  return result.buffer;
}

function asn1Wrap(tag: number, data: Uint8Array): Uint8Array {
  const len = lengthBytes(data.length);
  const result = new Uint8Array(1 + len.length + data.length);
  result[0] = tag;
  result.set(len, 1);
  result.set(data, 1 + len.length);
  return result;
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  if (length < 0x100) return new Uint8Array([0x81, length]);
  return new Uint8Array([0x82, (length >> 8) & 0xff, length & 0xff]);
}

async function createAppJWT(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = textToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = textToBase64Url(
    JSON.stringify({ iss: appId, iat: now - 60, exp: now + 600 }),
  );

  const key = await importPrivateKey(privateKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );

  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ── GitHub API helpers ──────────────────────────────────────────

export async function getInstallationToken(
  appId: string,
  installationId: string,
  privateKey: string,
): Promise<string> {
  const jwt = await createAppJWT(appId, privateKey);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "acme-ai-hub",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub: failed to get installation token (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

type GHHeaders = Record<string, string>;

function ghHeaders(token: string): GHHeaders {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "acme-ai-hub",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: ghHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new GHError(res.status, `GitHub API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}

/** Per-hop timeout, so one stuck log host cannot stall the whole get_pr_review call. */
const LOG_FETCH_TIMEOUT_MS = 15_000;
/** Max characters of an upstream error body echoed into an error message. */
const ERROR_BODY_MAX_CHARS = 500;

/**
 * Download a GitHub resource that is served via a redirect to a pre-signed
 * storage URL — e.g. `GET /actions/jobs/{id}/logs`, which answers 302 with a
 * SAS-signed Azure Blob URL.
 *
 * The redirect is followed MANUALLY on purpose. With `redirect: "follow"` the
 * Workers runtime re-sends the original headers — including the GitHub
 * `Authorization: token …` header — to the storage host. Azure then tries to
 * validate that header as its own signature and rejects the request with
 * `403 AuthenticationFailed`, even though the SAS signature in the URL is
 * valid. So: the first hop carries the GitHub token, the second hop carries
 * NO Authorization header at all (the URL itself is the credential).
 *
 * Exported for unit tests only.
 */
export async function fetchRedirectedLogText(
  token: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const apiUrl = `${GITHUB_API}${path}`;
  const first = await fetch(apiUrl, {
    method: "GET",
    headers: ghHeaders(token),
    redirect: "manual",
    signal: AbortSignal.timeout(LOG_FETCH_TIMEOUT_MS),
  });

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("Location");
    if (!location) {
      throw new GHError(
        first.status,
        `GitHub API GET ${path} redirected (${first.status}) without a Location header`,
      );
    }
    const target = new URL(location, apiUrl).toString();
    // Release the redirect's (empty) body so the Workers runtime can reuse the connection.
    await first.body?.cancel().catch(() => {});

    // Second hop: no Authorization, no GitHub headers — only what the caller
    // asked for (e.g. Range). The pre-signed URL is the credential.
    const downloadFromStorage = (headers: Record<string, string>) =>
      fetch(target, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(LOG_FETCH_TIMEOUT_MS),
      });
    let res = await downloadFromStorage({ ...extraHeaders });

    // Some storage hosts reject a suffix Range on small blobs. The caller trims the
    // tail client-side anyway, so retry once with the full body.
    const rangeKey = Object.keys(extraHeaders).find((k) => k.toLowerCase() === "range");
    if (res.status === 416 && rangeKey) {
      await res.body?.cancel().catch(() => {});
      const withoutRange = Object.fromEntries(
        Object.entries(extraHeaders).filter(([k]) => k !== rangeKey),
      );
      res = await downloadFromStorage(withoutRange);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GHError(res.status, `Log download for ${path} failed (${res.status}): ${text.slice(0, ERROR_BODY_MAX_CHARS)}`);
    }
    return res.text();
  }

  if (!first.ok) {
    const text = await first.text().catch(() => "");
    throw new GHError(first.status, `GitHub API GET ${path} failed (${first.status}): ${text.slice(0, ERROR_BODY_MAX_CHARS)}`);
  }
  // No redirect — GitHub served the body inline.
  return first.text();
}


// ── Public client ───────────────────────────────────────────────

export function createGitHubClient(config: GitHubAppConfig): GitHubClient {
  let cachedToken: { token: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.token;
    }
    const token = await getInstallationToken(
      config.appId,
      config.installationId,
      config.privateKey,
    );
    cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
    return token;
  }

  return {
    async getFileContent(
      owner: string,
      repo: string,
      path: string,
      ref = "main",
    ): Promise<string | null> {
      const token = await getToken();
      const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
      const res = await fetch(url, {
        headers: {
          ...ghHeaders(token),
          Accept: "application/vnd.github.raw+json",
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`GitHub: failed to fetch ${path} (${res.status})`);
      }
      return res.text();
    },

    async getPullRequestReview(
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestReviewResult> {
      const token = await getToken();
      const base = `/repos/${owner}/${repo}`;

      type GHUser = { login?: string; type?: string } | null;
      type GHReview = { user: GHUser; body: string; state: string; html_url: string; submitted_at: string | null };
      type GHReviewComment = { user: GHUser; body: string; path: string; line: number | null; html_url: string; created_at: string };
      type GHIssueComment = { user: GHUser; body: string; html_url: string; created_at: string };

      const [pr, reviews, reviewComments, issueComments] = await Promise.all([
        ghFetch<{ state: string; user: GHUser; head: { ref: string; sha: string } }>(token, "GET", `${base}/pulls/${prNumber}`),
        ghFetch<GHReview[]>(token, "GET", `${base}/pulls/${prNumber}/reviews?per_page=100`),
        ghFetch<GHReviewComment[]>(token, "GET", `${base}/pulls/${prNumber}/comments?per_page=100`),
        ghFetch<GHIssueComment[]>(token, "GET", `${base}/issues/${prNumber}/comments?per_page=100`),
      ]);

      // Read CI check runs on the PR head commit. The GitHub App now has the
      // "Checks: Read" scope, so this is a direct read — if it ever 403s again that is a
      // real permission regression and MUST fail loudly: a silently-empty result would be
      // indistinguishable from a genuine zero-checks commit and would defeat the CI-wait
      // gate.
      type GHCheckRun = {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        details_url?: string;
        html_url?: string;
      };
      const checkData = await ghFetch<{ check_runs?: GHCheckRun[] }>(
        token,
        "GET",
        `${base}/commits/${pr.head.sha}/check-runs?per_page=100`,
      );
      const runs: CheckRun[] = (checkData.check_runs ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        detailsUrl: c.details_url ?? c.html_url ?? "",
      }));
      const stillRunning = runs.some((r) => r.status !== "completed");
      const failed = runs.filter((r) => r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion)).length;
      const checks: PullRequestChecks = {
        runs,
        stillRunning,
        failed,
        allPassed: runs.length > 0 && !stillRunning && failed === 0,
      };

      // Latest ReviewBot verdict, from the RAW reviews — see the field's doc comment
      // for why this cannot be derived from `comments`.
      let latestReviewBotReviewState: string | undefined;
      let latestReviewBotAt = "";

      for (const r of reviews) {
        if (!isReviewBotLogin(r.user?.login)) continue;
        const at = r.submitted_at ?? "";
        if (at >= latestReviewBotAt) {
          latestReviewBotAt = at;
          latestReviewBotReviewState = r.state;
        }
      }

      const comments: PullRequestComment[] = [];

      for (const r of reviews) {
        // Skip empty review shells (state without a body and not a decision are noise).
        if (!r.body && r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
        comments.push({
          kind: "review",
          author: r.user?.login ?? "unknown",
          authorType: r.user?.type ?? "unknown",
          isReviewBot: isReviewBotLogin(r.user?.login),
          body: r.body ?? "",
          state: r.state,
          htmlUrl: r.html_url,
          createdAt: r.submitted_at ?? "",
        });
      }
      for (const c of reviewComments) {
        comments.push({
          kind: "review_comment",
          author: c.user?.login ?? "unknown",
          authorType: c.user?.type ?? "unknown",
          isReviewBot: isReviewBotLogin(c.user?.login),
          body: c.body ?? "",
          path: c.path,
          line: c.line,
          htmlUrl: c.html_url,
          createdAt: c.created_at,
        });
      }
      for (const c of issueComments) {
        comments.push({
          kind: "issue_comment",
          author: c.user?.login ?? "unknown",
          authorType: c.user?.type ?? "unknown",
          isReviewBot: isReviewBotLogin(c.user?.login),
          body: c.body ?? "",
          htmlUrl: c.html_url,
          createdAt: c.created_at,
        });
      }

      comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      return {
        prNumber,
        state: pr.state,
        authorLogin: pr.user?.login ?? "",
        branch: pr.head.ref,
        headSha: pr.head.sha,

        checks,
        comments,
        reviewBotCommentCount: comments.filter((c) => c.isReviewBot).length,
        latestReviewBotReviewState,
        latestReviewBotReviewAt: latestReviewBotAt || undefined,
      };
    },

    async getFailedCheckLogs(
      owner: string,
      repo: string,
      runs: CheckRun[],
    ): Promise<FailedCheckLog[]> {
      const token = await getToken();
      const base = `/repos/${owner}/${repo}`;

      // Reuse the check runs already read by getPullRequestReview — no second /pulls or
      // /check-runs round-trip, and no TOCTOU gap against the caller's checks counts.
      const failedRuns = runs.filter(
        (r) => r.status === "completed" && r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion),
      );

      const logs = await Promise.all(
        failedRuns.map(async (run) => {
          let logTail: string;
          try {
            // Range: keep only the tail — a verbose/looping job can emit MBs and we want
            // the last lines. Falls back to the full body if the log host ignores Range.
            const raw = await fetchRedirectedLogText(token, `${base}/actions/jobs/${run.id}/logs`, {
              Range: "bytes=-131072",
            });
            logTail = raw.split("\n").slice(-120).join("\n");
          } catch (err) {
            logTail = `(could not fetch logs: ${err instanceof Error ? err.message : String(err)})`;
          }
          return { jobName: run.name, conclusion: run.conclusion, logTail };
        }),
      );

      return logs;
    },

    async getPullRequestFiles(
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestFileList> {
      const token = await getToken();
      type GHFile = { filename: string; status: string; additions: number; deletions: number };
      const files: PullRequestFile[] = [];
      // GitHub's files endpoint returns at most 3000 entries, so 30 pages is the
      // real end of the diff rather than an arbitrary stop.
      const MAX_PAGES = 30;
      let truncated = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const batch = await ghFetch<GHFile[]>(
          token,
          "GET",
          `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        );
        for (const f of batch) {
          files.push({
            path: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          });
        }
        if (batch.length < 100) break;
        // A full last page means there may be more. Say so instead of stopping
        // quietly: a caller that judges a partial diff would miss a denied file
        // sitting past the cut, which is the whole point of reading the list.
        if (page === MAX_PAGES) truncated = true;
      }
      return { files, truncated };
    },

    async mergePullRequest(input: MergePRInput): Promise<MergePRResult> {
      const token = await getToken();
      const res = await ghFetch<{ merged: boolean; sha: string; message: string }>(
        token,
        "PUT",
        `/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/merge`,
        {
          sha: input.sha,
          merge_method: "squash",
          ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
          ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
        },
      );
      return { merged: res.merged, sha: res.sha, message: res.message };
    },


    async createIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
      const { owner, repo, title, body, labels } = input;
      const token = await getToken();

      const payload: Record<string, unknown> = { title, body };
      if (labels?.length) payload.labels = labels;

      const issue = await ghFetch<{ html_url: string; number: number }>(
        token,
        "POST",
        `/repos/${owner}/${repo}/issues`,
        payload,
      );

      return {
        issueUrl: issue.html_url,
        issueNumber: issue.number,
      };
    },

    async pushFix(input: PushFixInput): Promise<PushFixResult> {
      const { owner, repo, branch, commitMessage, files, deletedFiles = [] } = input;
      const base = input.base ?? "main";
      const token = await getToken();
      const fixFilePaths = new Set([...files.map((f) => f.path), ...deletedFiles]);

      let mergedBase = false;
      const resolvedFiles: string[] = [];

      const branchRef = await ghFetch<{ object: { sha: string } }>(
        token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      );
      let headSha = branchRef.object.sha;

      const baseRef = await ghFetch<{ object: { sha: string } }>(
        token, "GET", `/repos/${owner}/${repo}/git/ref/heads/${base}`,
      );
      const baseSha = baseRef.object.sha;

      const comparison = await ghFetch<{ behind_by: number; status: string }>(
        token, "GET", `/repos/${owner}/${repo}/compare/${branch}...${base}`,
      );

      if (comparison.behind_by > 0) {
        const mergeRes = await fetch(
          `${GITHUB_API}/repos/${owner}/${repo}/merges`,
          {
            method: "POST",
            headers: ghHeaders(token),
            body: JSON.stringify({ base: branch, head: base, commit_message: `merge: ${base} into ${branch}` }),
          },
        );

        if (mergeRes.status === 201) {
          const mergeData = (await mergeRes.json()) as { sha: string };
          headSha = mergeData.sha;
          mergedBase = true;
        } else if (mergeRes.status === 204) {
          // Branch already up-to-date, nothing to merge
          mergedBase = false;
        } else if (mergeRes.status === 409) {
          const branchDiff = await ghFetch<{ files?: { filename: string; status: string }[] }>(
            token, "GET", `/repos/${owner}/${repo}/compare/${base}...${branch}`,
          );
          const branchChangedFiles = branchDiff.files ?? [];

          const baseCommit = await ghFetch<{ tree: { sha: string } }>(
            token, "GET", `/repos/${owner}/${repo}/git/commits/${baseSha}`,
          );

          const branchOnlyBlobs = await Promise.all(
            branchChangedFiles
              .filter((f) => !fixFilePaths.has(f.filename))
              .map(async (file) => {
                if (file.status === "removed") {
                  resolvedFiles.push(file.filename);
                  return { path: file.filename, sha: null as unknown as string, mode: "100644" as const, type: "blob" as const };
                }
                const res = await fetch(
                  `${GITHUB_API}/repos/${owner}/${repo}/contents/${file.filename}?ref=${branch}`,
                  { headers: { ...ghHeaders(token), Accept: "application/vnd.github.raw+json" } },
                );
                if (!res.ok) return null;
                const content = await res.text();
                const blob = await ghFetch<{ sha: string }>(
                  token, "POST", `/repos/${owner}/${repo}/git/blobs`,
                  { content, encoding: "utf-8" },
                );
                resolvedFiles.push(file.filename);
                return { path: file.filename, sha: blob.sha, mode: "100644" as const, type: "blob" as const };
              }),
          );

          const fixBlobs = await Promise.all(
            files.map(async (file) => {
              const blob = await ghFetch<{ sha: string }>(
                token, "POST", `/repos/${owner}/${repo}/git/blobs`,
                { content: file.content, encoding: "utf-8" },
              );
              return { path: file.path, sha: blob.sha, mode: "100644" as const, type: "blob" as const };
            }),
          );

          const allBlobs = [...branchOnlyBlobs.filter(Boolean), ...fixBlobs];

          const mergeTree = await ghFetch<{ sha: string }>(
            token, "POST", `/repos/${owner}/${repo}/git/trees`,
            { base_tree: baseCommit.tree.sha, tree: allBlobs },
          );

          const mergeCommit = await ghFetch<{ sha: string }>(
            token, "POST", `/repos/${owner}/${repo}/git/commits`,
            {
              message: `merge: resolve conflicts between ${base} and ${branch}\n\n${commitMessage}`,
              tree: mergeTree.sha,
              parents: [headSha, baseSha],
            },
          );

          await ghFetch(
            token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
            { sha: mergeCommit.sha },
          );

          return { branch, commitSha: mergeCommit.sha, mergedBase: true, resolvedFiles };
        } else {
          const errText = await mergeRes.text().catch(() => "");
          throw new GHError(mergeRes.status, `GitHub merge ${base} into ${branch} failed (${mergeRes.status}): ${errText}`);
        }
      }

      const headCommit = await ghFetch<{ tree: { sha: string } }>(
        token, "GET", `/repos/${owner}/${repo}/git/commits/${headSha}`,
      );

      const blobs = await Promise.all(
        files.map(async (file) => {
          const blob = await ghFetch<{ sha: string }>(
            token, "POST", `/repos/${owner}/${repo}/git/blobs`,
            { content: file.content, encoding: "utf-8" },
          );
          return { path: file.path, sha: blob.sha, mode: "100644" as const, type: "blob" as const };
        }),
      );

      // Deletions: sha=null tells GitHub to remove the file from the tree
      const deleteEntries = deletedFiles.map((path) => ({
        path,
        sha: null as unknown as string,
        mode: "100644" as const,
        type: "blob" as const,
      }));

      const tree = await ghFetch<{ sha: string }>(
        token, "POST", `/repos/${owner}/${repo}/git/trees`,
        { base_tree: headCommit.tree.sha, tree: [...blobs, ...deleteEntries] },
      );

      const commit = await ghFetch<{ sha: string }>(
        token, "POST", `/repos/${owner}/${repo}/git/commits`,
        { message: commitMessage, tree: tree.sha, parents: [headSha] },
      );

      await ghFetch(
        token, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { sha: commit.sha },
      );

      return { branch, commitSha: commit.sha, mergedBase, resolvedFiles: resolvedFiles.length > 0 ? resolvedFiles : undefined };
    },

    async createPullRequest(input: CreatePRInput): Promise<CreatePRResult> {
      const { owner, repo, branch, title, body, files } = input;
      const base = input.base ?? "main";

      const token = await getToken();

      let parentSha: string;
      let branchExists = false;
      try {
        const branchRef = await ghFetch<{ object: { sha: string } }>(
          token,
          "GET",
          `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
        );
        parentSha = branchRef.object.sha;
        branchExists = true;
      } catch (err) {
        if (!(err instanceof GHError) || err.status !== 404) {
          throw err;
        }
        const baseRef = await ghFetch<{ object: { sha: string } }>(
          token,
          "GET",
          `/repos/${owner}/${repo}/git/ref/heads/${base}`,
        );
        parentSha = baseRef.object.sha;

        await ghFetch(token, "POST", `/repos/${owner}/${repo}/git/refs`, {
          ref: `refs/heads/${branch}`,
          sha: parentSha,
        });
      }

      const parentCommit = await ghFetch<{ tree: { sha: string } }>(
        token,
        "GET",
        `/repos/${owner}/${repo}/git/commits/${parentSha}`,
      );

      const blobs = await Promise.all(
        files.map(async (file) => {
          const blob = await ghFetch<{ sha: string }>(
            token,
            "POST",
            `/repos/${owner}/${repo}/git/blobs`,
            { content: file.content, encoding: "utf-8" },
          );
          return { path: file.path, sha: blob.sha, mode: "100644" as const, type: "blob" as const };
        }),
      );

      const tree = await ghFetch<{ sha: string }>(
        token,
        "POST",
        `/repos/${owner}/${repo}/git/trees`,
        { base_tree: parentCommit.tree.sha, tree: blobs },
      );

      const commitMessage = branchExists ? `update: ${title}` : title;
      const commit = await ghFetch<{ sha: string }>(
        token,
        "POST",
        `/repos/${owner}/${repo}/git/commits`,
        {
          message: commitMessage,
          tree: tree.sha,
          parents: [parentSha],
        },
      );

      await ghFetch(
        token,
        "PATCH",
        `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
        { sha: commit.sha },
      );

      const existingPRs = await ghFetch<{ html_url: string; number: number }[]>(
        token,
        "GET",
        `/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&base=${base}&state=open`,
      );

      if (existingPRs.length > 0) {
        const existingPR = existingPRs[0];
        await ghFetch(
          token,
          "PATCH",
          `/repos/${owner}/${repo}/pulls/${existingPR.number}`,
          { title, body },
        );
        return {
          prUrl: existingPR.html_url,
          prNumber: existingPR.number,
          branch,
        };
      }

      const pr = await ghFetch<{ html_url: string; number: number }>(
        token,
        "POST",
        `/repos/${owner}/${repo}/pulls`,
        { title, body, head: branch, base },
      );

      return {
        prUrl: pr.html_url,
        prNumber: pr.number,
        branch,
      };
    },
  };
}
