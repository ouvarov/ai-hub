import { defineSkill } from "@shared/types";
import { checkCron } from "./parse-expression";

export interface CronJobState {
  name: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  /** Per-minute key of the last dispatch (idempotency). null/undefined = never run. */
  lastRunMinuteIso?: string | null;
}

export interface SelectDueInput {
  jobs: CronJobState[];
  /** ISO instant to evaluate against. Default = now. */
  at?: string;
}

export interface SelectDueOutput {
  /** Names of jobs to dispatch now. */
  due: string[];
  /** Every non-due job with the reason it was skipped. */
  skipped: { name: string; reason: string }[];
}

export const selectDueJobs = defineSkill<SelectDueInput, SelectDueOutput>(
  {
    name: "cron_select_due_jobs",
    description:
      "Given the cron jobs registry snapshot and the current instant, return which jobs are due to dispatch now. Skips disabled jobs, invalid schedules, duplicate names, jobs not due this minute, and jobs already dispatched this minute (idempotency). Pure logic.",
    service: "cron",
    adr: "cron-jobs-entity",
  },
  async ({ jobs, at }) => {
    const due: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (seen.has(job.name)) {
        skipped.push({ name: job.name, reason: "duplicate job name" });
        continue;
      }
      seen.add(job.name);
      if (job.enabled === false) {
        skipped.push({ name: job.name, reason: "disabled" });
        continue;
      }
      const c = checkCron(job.schedule, job.timezone ?? "UTC", at);
      if (!c.valid) {
        skipped.push({ name: job.name, reason: `invalid schedule: ${c.error ?? "unknown"}` });
        continue;
      }
      if (!c.isDue) {
        skipped.push({ name: job.name, reason: "not due" });
        continue;
      }
      if (job.lastRunMinuteIso && job.lastRunMinuteIso === c.matchedMinuteIso) {
        skipped.push({ name: job.name, reason: "already ran this minute" });
        continue;
      }
      due.push(job.name);
    }
    return { due, skipped };
  },
);
