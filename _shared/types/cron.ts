/**
 * Cron — a scheduled job. Declarative: maps a cron schedule to a target that
 * the platform invokes on a timer. The scheduler (agent-runner `scheduled()`
 * handler) iterates the crons registry each tick and dispatches the due ones.
 *
 * Rules:
 * - Declarative only. No fetch, no logic in the definition itself.
 * - The target is an existing Action, invoked in-process by the agent-runner.
 * - `schedule` is standard 5-field cron; `timezone` is IANA (evaluated in it).
 */

export interface CronTarget {
  /** v1 supports action targets only (agent targets are a fast-follow). */
  kind: "action";
  /** snake_case action name as registered in agent-runner (e.g. "weekly_report_scan"). */
  name: string;
  /** Input payload passed verbatim to the action. */
  input?: Record<string, unknown>;
}

export interface CronMeta {
  /** snake_case job id, unique across the crons registry. */
  name: string;
  description: string;
  /** Standard 5-field cron expression: minute hour day-of-month month day-of-week. */
  schedule: string;
  /** IANA timezone the schedule is evaluated in (e.g. "Europe/Kyiv"). Defaults to "UTC". */
  timezone?: string;
  /** What runs when the job is due. */
  target: CronTarget;
  /** Set false to pause the job. Omitted/undefined = enabled. */
  enabled?: boolean;
  /** ADR filename (docs/adr/{name}.md). */
  adr?: string;
  /** Reserved for the future management surface; not enforced in v1. */
  allowedGroups?: string[];
}

export type Cron = {
  meta: CronMeta;
};

/** Helper to define a cron job with proper typing. */
export function defineCron(meta: CronMeta): Cron {
  return { meta };
}
