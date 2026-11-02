import { describe, it, expect } from "vitest";
import { checkCron, evaluateCron, parseCronExpression } from "@shared/skills/cron/parse-expression";

describe("checkCron — validity", () => {
  it("accepts a valid 5-field expression", () => {
    expect(checkCron("0 9 * * *", "UTC", "2026-07-13T09:00:00Z").valid).toBe(true);
  });
  it("rejects the wrong field count", () => {
    const r = checkCron("0 9 * *", "UTC");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("5 fields");
  });
  it("rejects out-of-range values", () => {
    expect(checkCron("99 9 * * *", "UTC").valid).toBe(false);
  });
  it("rejects an invalid step", () => {
    expect(checkCron("*/0 * * * *", "UTC").valid).toBe(false);
  });
  it("rejects non-decimal tokens (hex / exponent)", () => {
    expect(checkCron("0x1f 9 * * *", "UTC").valid).toBe(false);
    expect(checkCron("1e1 9 * * *", "UTC").valid).toBe(false);
  });
  it("rejects an invalid timezone", () => {
    const r = checkCron("0 9 * * *", "Mars/Phobos");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("timezone");
  });
});

describe("checkCron — matching", () => {
  it("matches an exact minute in UTC", () => {
    expect(checkCron("3 9 * * *", "UTC", "2026-07-13T09:03:00Z").isDue).toBe(true);
    expect(checkCron("3 9 * * *", "UTC", "2026-07-13T09:04:00Z").isDue).toBe(false);
  });
  it("handles the */5 step operator", () => {
    expect(checkCron("*/5 * * * *", "UTC", "2026-07-13T09:10:00Z").isDue).toBe(true);
    expect(checkCron("*/5 * * * *", "UTC", "2026-07-13T09:11:00Z").isDue).toBe(false);
  });
  it("handles lists and ranges", () => {
    expect(checkCron("0,30 9-17 * * *", "UTC", "2026-07-13T14:30:00Z").isDue).toBe(true);
    expect(checkCron("0,30 9-17 * * *", "UTC", "2026-07-13T18:30:00Z").isDue).toBe(false);
  });
});

describe("checkCron — timezone", () => {
  it("evaluates 09:00 Europe/Kyiv as 06:00 UTC in summer (EEST, +3)", () => {
    expect(checkCron("0 9 * * *", "Europe/Kyiv", "2026-07-13T06:00:00Z").isDue).toBe(true);
    expect(checkCron("0 9 * * *", "Europe/Kyiv", "2026-07-13T09:00:00Z").isDue).toBe(false);
  });
  it("evaluates 09:00 Europe/Kyiv as 07:00 UTC in winter (EET, +2)", () => {
    expect(checkCron("0 9 * * *", "Europe/Kyiv", "2026-01-13T07:00:00Z").isDue).toBe(true);
  });
});

describe("checkCron — day of week", () => {
  it("matches a weekday (Mon=1); 2026-07-13 is a Monday", () => {
    expect(checkCron("0 9 * * 1", "UTC", "2026-07-13T09:00:00Z").isDue).toBe(true);
    expect(checkCron("0 9 * * 2", "UTC", "2026-07-13T09:00:00Z").isDue).toBe(false);
  });
  it("treats 7 and 0 as Sunday; 2026-07-12 is a Sunday", () => {
    expect(checkCron("0 9 * * 7", "UTC", "2026-07-12T09:00:00Z").isDue).toBe(true);
    expect(checkCron("0 9 * * 0", "UTC", "2026-07-12T09:00:00Z").isDue).toBe(true);
  });
});

describe("evaluateCron — next run", () => {
  it("computes the next run instant", () => {
    const r = evaluateCron("0 9 * * *", "UTC", "2026-07-13T10:00:00Z");
    expect(r.valid).toBe(true);
    expect(r.nextRunIso).toBe("2026-07-14T09:00:00.000Z");
  });
  it("returns null for an impossible date (Feb 30)", () => {
    const r = evaluateCron("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z");
    expect(r.valid).toBe(true);
    expect(r.nextRunIso).toBeNull();
  });
});

describe("parseCronExpression skill", () => {
  it("exposes cron_parse_expression and returns due", async () => {
    expect(parseCronExpression.meta.name).toBe("cron_parse_expression");
    const out = await parseCronExpression.execute({ expression: "0 9 * * *", timezone: "UTC", at: "2026-07-13T09:00:00Z" });
    expect(out.isDue).toBe(true);
  });
});
