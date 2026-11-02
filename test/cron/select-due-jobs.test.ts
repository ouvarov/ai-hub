import { describe, it, expect } from "vitest";
import { selectDueJobs } from "@shared/skills/cron/select-due-jobs";

const at = "2026-07-13T09:00:00Z"; // Monday 09:00 UTC

describe("selectDueJobs", () => {
  it("selects a due job", async () => {
    const r = await selectDueJobs.execute({ jobs: [{ name: "a", schedule: "0 9 * * *" }], at });
    expect(r.due).toEqual(["a"]);
  });
  it("skips a job that is not due", async () => {
    const r = await selectDueJobs.execute({ jobs: [{ name: "a", schedule: "0 10 * * *" }], at });
    expect(r.due).toEqual([]);
    expect(r.skipped[0].reason).toBe("not due");
  });
  it("skips disabled jobs", async () => {
    const r = await selectDueJobs.execute({ jobs: [{ name: "a", schedule: "0 9 * * *", enabled: false }], at });
    expect(r.due).toEqual([]);
    expect(r.skipped[0].reason).toBe("disabled");
  });
  it("skips invalid schedules with a reason", async () => {
    const r = await selectDueJobs.execute({ jobs: [{ name: "a", schedule: "nonsense" }], at });
    expect(r.due).toEqual([]);
    expect(r.skipped[0].reason).toContain("invalid schedule");
  });
  it("dedupes duplicate job names", async () => {
    const r = await selectDueJobs.execute({
      jobs: [
        { name: "a", schedule: "0 9 * * *" },
        { name: "a", schedule: "0 9 * * *" },
      ],
      at,
    });
    expect(r.due).toEqual(["a"]);
    expect(r.skipped.some((s) => s.reason === "duplicate job name")).toBe(true);
  });
  it("idempotency: skips a job already run this minute", async () => {
    const jobs = [{ name: "a", schedule: "0 9 * * *", timezone: "UTC", lastRunMinuteIso: "2026-07-13T09:00" }];
    const r = await selectDueJobs.execute({ jobs, at });
    expect(r.due).toEqual([]);
    expect(r.skipped[0].reason).toBe("already ran this minute");
  });
  it("respects timezone (Kyiv 09:00 = 06:00 UTC in July)", async () => {
    const r = await selectDueJobs.execute({ jobs: [{ name: "a", schedule: "0 9 * * *", timezone: "Europe/Kyiv" }], at: "2026-07-13T06:00:00Z" });
    expect(r.due).toEqual(["a"]);
  });
  it("handles multiple jobs and an empty registry", async () => {
    expect((await selectDueJobs.execute({ jobs: [], at })).due).toEqual([]);
    const r = await selectDueJobs.execute({
      jobs: [
        { name: "due", schedule: "0 9 * * *" },
        { name: "notdue", schedule: "0 8 * * *" },
      ],
      at,
    });
    expect(r.due).toEqual(["due"]);
  });
});
