import { DurableObject } from "cloudflare:workers";

/** Pipeline gates for ONE builder run — one skill/agent/action being built. */
export interface RunGates {
  listSkills: boolean;
  listAgents: boolean;
  calledBmad: boolean;
  confirmPlan: boolean;
  submitForReview: boolean;
  submitFinal: boolean;
}

/** The pull request a run opened, recorded so confirm_merge cannot be pointed at any other PR. */
export interface RunPullRequest {
  number: number;
  branch: string;
  url: string;
  createdAt: number;
}

export interface RunRecord {
  runId: string;
  /** Email of the user who called start_building. Empty string for anonymous sessions. */
  user: string;
  startedAt: number;
  gates: RunGates;
  /** Set by create_pull_request. Absent until this run has opened a PR. */
  pr?: RunPullRequest;
}

const RUN_KEY = "run";

export const EMPTY_GATES: RunGates = {
  listSkills: false,
  listAgents: false,
  calledBmad: false,
  confirmPlan: false,
  submitForReview: false,
  submitFinal: false,
};

/**
 * Storage for a single builder run, addressed by idFromName("builder-run:" + runId).
 *
 * WHY this is a separate Durable Object: the MCP agent DO is addressed by
 * `mcp-session-id` (agents/mcp → getAgentByName → partyserver getServerByName →
 * idFromName), so anything kept in its storage is scoped to one transport session.
 * That breaks both ways:
 *   - a client that opens a fresh MCP session per tool call (claude.ai web) never
 *     accumulates gates, so the pipeline can never be completed;
 *   - gates that live as long as a session leak across unrelated builds.
 * A run is the correct scope: it starts at start_building and travels with the
 * conversation via the returned runId.
 */
export class BuilderRunState extends DurableObject {
  async createRun(runId: string, user: string): Promise<RunRecord> {
    const record: RunRecord = { runId, user, startedAt: Date.now(), gates: { ...EMPTY_GATES } };
    await this.ctx.storage.put(RUN_KEY, record);
    return record;
  }

  async getRun(): Promise<RunRecord | null> {
    return (await this.ctx.storage.get<RunRecord>(RUN_KEY)) ?? null;
  }

  /**
   * Records the PR this run opened. Returns null when the run does not exist.
   *
   * Write-once: a run opens one PR, and letting a later call overwrite it would
   * hand confirm_merge a different target than the one the pipeline validated.
   */
  async setPullRequest(pr: RunPullRequest): Promise<RunRecord | null> {
    const record = await this.getRun();
    if (!record) return null;
    if (record.pr) return record;
    record.pr = pr;
    await this.ctx.storage.put(RUN_KEY, record);
    return record;
  }

  /** Marks one gate as passed. Returns null when the run does not exist. */
  async setGate(gate: keyof RunGates): Promise<RunRecord | null> {
    const record = await this.getRun();
    if (!record) return null;
    record.gates = { ...record.gates, [gate]: true };
    await this.ctx.storage.put(RUN_KEY, record);
    return record;
  }
}
