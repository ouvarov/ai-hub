import {
  EMPTY_GATES,
  type BuilderRunState,
  type RunGates,
  type RunPullRequest,
  type RunRecord,
} from "./builder-run-state";

export type BuilderRunsNamespace = DurableObjectNamespace<BuilderRunState>;

export const GATE_LABELS: Record<keyof RunGates, string> = {
  listSkills: "list_skills (check existing skills)",
  listAgents: "list_agents (check existing agents)",
  calledBmad: "run_bmad (discovery or elicitation — ask user clarifying questions)",
  confirmPlan: "confirm_plan (show plan to user)",
  submitForReview: "submit_for_review (validate registry + ADR)",
  submitFinal: "submit_final (BMAD review findings)",
};

const SESSION_GATES_KEY = "builder_gates";

/** Gate storage for one scope — a builder run (preferred) or the transport session (fallback). */
export interface GateStore {
  /** Scope description, surfaced in telemetry and error text. */
  scope: string;
  gates: RunGates;
  mark(gate: keyof RunGates): Promise<void>;
}

export type GateResolution =
  | { ok: true; store?: GateStore }
  | { ok: false; message: string };

export function newRunId(): string {
  return `bld_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/**
 * Session-scoped gates — the pre-runId behaviour, kept so conversations that are
 * mid-pipeline when this ships keep working. Writes are awaited: the previous
 * implementation put() from inside a Proxy setter without awaiting, so a gate
 * could be lost if the DO was evicted before the write flushed.
 */
export async function createSessionGateStore(storage: DurableObjectStorage): Promise<GateStore> {
  const saved = await storage.get<RunGates>(SESSION_GATES_KEY);
  const gates: RunGates = { ...EMPTY_GATES, ...(saved ?? {}) };
  return {
    scope: "session",
    gates,
    async mark(gate) {
      if (gates[gate]) return;
      gates[gate] = true;
      await storage.put(SESSION_GATES_KEY, { ...gates });
    },
  };
}

/** Opens a fresh run and returns its record. Returns null when the binding is unavailable. */
export async function openRun(
  runs: BuilderRunsNamespace | undefined,
  runId: string,
  user: string,
): Promise<RunRecord | null> {
  if (!runs) return null;
  try {
    const stub = runs.get(runs.idFromName(`builder-run:${runId}`));
    return await stub.createRun(runId, user);
  } catch {
    return null;
  }
}

/**
 * Picks the gate store for a tool call: the run named by runId when it resolves,
 * the transport session otherwise.
 *
 * Every infrastructure failure degrades to session gates instead of blocking —
 * a missing binding or an unreachable DO must not take the builder down. Only a
 * runId that is genuinely wrong (unknown, or owned by someone else) fails closed,
 * because there the caller can act on the message.
 */
export async function resolveGateStore(opts: {
  runId?: string;
  runs?: BuilderRunsNamespace;
  session?: GateStore;
  user?: string;
}): Promise<GateResolution> {
  const { runId, runs, session, user } = opts;
  if (!runId || !runs) return { ok: true, store: session };

  let stub: DurableObjectStub<BuilderRunState>;
  let record: RunRecord | null;
  try {
    stub = runs.get(runs.idFromName(`builder-run:${runId}`));
    record = await stub.getRun();
  } catch {
    return { ok: true, store: session };
  }

  if (!record) {
    return {
      ok: false,
      message:
        `Unknown runId "${runId}" — there is no builder run with that id. ` +
        `Call start_building and pass the runId it returns to every builder tool.`,
    };
  }
  if (record.user && user && record.user !== user) {
    return {
      ok: false,
      message: `runId "${runId}" was opened by another user. Call start_building to open your own run.`,
    };
  }

  return {
    ok: true,
    store: {
      scope: `run:${runId}`,
      gates: record.gates,
      async mark(gate) {
        await stub.setGate(gate);
      },
    },
  };
}

export type RunResolution =
  | { ok: true; record: RunRecord }
  | { ok: false; message: string };

/**
 * Resolves a run record, failing closed.
 *
 * Deliberately NOT resolveGateStore: that one degrades to session-scoped gates
 * whenever the binding or the Durable Object is unavailable, which is right for
 * a validation step and wrong for merging. A merge reaches production, so an
 * infrastructure failure here must refuse rather than fall back to a weaker
 * scope that cannot tell us which PR this run opened.
 */
export async function resolveRunStrict(opts: {
  runId?: string;
  runs?: BuilderRunsNamespace;
  user?: string;
}): Promise<RunResolution> {
  const { runId, runs, user } = opts;
  if (!runId) {
    return {
      ok: false,
      message:
        "No runId. This tool acts on the PR a specific builder run opened, so it needs the runId " +
        "returned by start_building.",
    };
  }
  if (!runs) {
    return { ok: false, message: "Builder run storage is unavailable, so the run cannot be verified." };
  }

  let record: RunRecord | null;
  try {
    record = await runs.get(runs.idFromName(`builder-run:${runId}`)).getRun();
  } catch (err) {
    return {
      ok: false,
      message: `Could not read builder run "${runId}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!record) {
    return { ok: false, message: `Unknown runId "${runId}" — there is no builder run with that id.` };
  }
  // Same fail-closed rule as evaluateMergeReadiness: an absent caller identity
  // must not skip the ownership check. resolveGateStore keeps the permissive
  // form on purpose — it guards validation steps, where blocking an
  // unidentified caller would break the builder for no safety gain.
  if (record.user && record.user !== (user ?? "")) {
    return { ok: false, message: `runId "${runId}" was opened by another user.` };
  }
  return { ok: true, record };
}

/**
 * Records the PR a run opened. Best-effort: a failure here must not fail the PR
 * creation that already succeeded — it only means confirm_merge will later
 * refuse, which is the safe direction.
 */
export async function recordRunPullRequest(
  runs: BuilderRunsNamespace | undefined,
  runId: string | undefined,
  pr: RunPullRequest,
): Promise<void> {
  if (!runId || !runs) return;
  try {
    await runs.get(runs.idFromName(`builder-run:${runId}`)).setPullRequest(pr);
  } catch {
    // Intentionally swallowed — see the doc comment.
  }
}

/** Missing gate labels for the required steps. Empty array = all passed. */
export function checkGates(store: GateStore | undefined, ...required: (keyof RunGates)[]): string[] {
  if (!store) return [];
  return required.filter((k) => !store.gates[k]).map((k) => GATE_LABELS[k]);
}

/** Shared param description so every gated tool advertises runId identically. */
export const RUN_ID_DESCRIPTION =
  "Pipeline run id returned by start_building. Pass it to EVERY builder call — it is what keeps " +
  "the pipeline together when the MCP transport opens a new session per call (claude.ai web). " +
  "Omit only if you never received one.";
