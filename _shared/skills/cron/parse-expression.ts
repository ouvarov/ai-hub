import { defineSkill } from "@shared/types";

export interface CronParseInput {
  /** Standard 5-field cron expression. */
  expression: string;
  /** IANA timezone. Default "UTC". */
  timezone?: string;
  /** ISO instant to evaluate against. Default = now. */
  at?: string;
}

export interface CronCheck {
  valid: boolean;
  error?: string;
  /** True when the expression matches `at` to the minute, in `timezone`. */
  isDue: boolean;
  /** Stable per-minute key in the target tz (e.g. "2026-07-13T09:03") — idempotency key, not a true ISO instant. */
  matchedMinuteIso: string;
}

export interface CronParseOutput extends CronCheck {
  /** Next instant (UTC ISO) the expression fires after `at`, or null if none within the scan horizon. */
  nextRunIso: string | null;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 and 7 = Sunday)
];

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Largest possible day-of-month per month (1-indexed). February uses 29 to
// keep leap-year schedules (0 0 29 2 *) reachable.
const MAX_DAY_IN_MONTH: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Forward-scan horizon for next-run: a hair over a year so yearly schedules
// (and Feb 29) resolve, while impossible dates (e.g. Feb 30) terminate.
const NEXT_RUN_SCAN_CAP_MINUTES = 367 * 24 * 60;
const DECIMAL = /^\d+$/;

// Intl.DateTimeFormat construction is expensive; the next-run scan calls
// tzParts up to NEXT_RUN_SCAN_CAP_MINUTES times, so cache one formatter per tz.
// An invalid timezone still throws on first construction (caught by resolveNow).
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    FORMATTER_CACHE.set(timeZone, fmt);
  }
  return fmt;
}

function parseField(field: string, range: FieldRange): Set<number> | string {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") return `empty term in "${field}"`;
    let base = part;
    let step = 1;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      base = part.slice(0, slashIdx);
      const stepRaw = part.slice(slashIdx + 1);
      if (!DECIMAL.test(stepRaw) || Number(stepRaw) <= 0) {
        return `invalid step "${stepRaw}" in "${field}"`;
      }
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = range.min;
      hi = range.max;
    } else {
      const dashIdx = base.indexOf("-");
      const loRaw = dashIdx !== -1 ? base.slice(0, dashIdx) : base;
      const hiRaw = dashIdx !== -1 ? base.slice(dashIdx + 1) : base;
      // Strict decimal only — Number() would otherwise accept 0x1f, 1e1, etc.
      if (!DECIMAL.test(loRaw) || !DECIMAL.test(hiRaw)) {
        return `invalid number in "${part}"`;
      }
      lo = Number(loRaw);
      hi = Number(hiRaw);
      if (lo < range.min || hi > range.max || lo > hi) {
        return `"${part}" out of range ${range.min}-${range.max}`;
      }
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseExpression(expression: string): ParsedCron | string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return `expected 5 fields, got ${fields.length}`;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const result = parseField(fields[i], FIELD_RANGES[i]);
    if (typeof result === "string") return `field ${i + 1}: ${result}`;
    sets.push(result);
  }
  const dow = sets[4];
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
  };
}

interface TzParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dow: number;
  year: number;
}

function tzParts(date: Date, timeZone: string): TzParts {
  const fmt = formatterFor(timeZone);
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return {
    minute: Number(map.minute),
    hour: Number(map.hour) % 24, // h23 yields 0–23; % 24 folds any midnight "24"
    day: Number(map.day),
    month: Number(map.month),
    dow: WEEKDAY_INDEX[map.weekday] ?? 0,
    year: Number(map.year),
  };
}

function matches(parsed: ParsedCron, parts: TzParts): boolean {
  if (!parsed.minute.has(parts.minute)) return false;
  if (!parsed.hour.has(parts.hour)) return false;
  if (!parsed.month.has(parts.month)) return false;
  // Standard cron: when both day-of-month and day-of-week are restricted, match on EITHER.
  if (parsed.domRestricted && parsed.dowRestricted) {
    return parsed.dom.has(parts.day) || parsed.dow.has(parts.dow);
  }
  return parsed.dom.has(parts.day) && parsed.dow.has(parts.dow);
}

/**
 * Cheap reachability guard for the next-run scan. Returns false only when the
 * schedule can provably never fire on a calendar date — a day-of-month that
 * exceeds every restricted month's max (e.g. Feb 30, Apr 31). When day-of-week
 * is also restricted the OR-rule can still match, so we don't prune that case.
 */
function scheduleCanOccur(parsed: ParsedCron): boolean {
  if (!parsed.domRestricted) return true;
  // domRestricted is necessarily true here (guarded above). If day-of-week is
  // also restricted, the OR-rule can still match, so we can't prune — bail out.
  if (parsed.dowRestricted) return true;
  for (const m of parsed.month) {
    for (const d of parsed.dom) {
      if (d <= MAX_DAY_IN_MONTH[m - 1]) return true;
    }
  }
  return false;
}

function minuteKey(parts: TzParts): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${p2(parts.month)}-${p2(parts.day)}T${p2(parts.hour)}:${p2(parts.minute)}`;
}

/**
 * Resolve `at` into a Date and validate the timezone, returning an error string
 * on bad input. Shared by checkCron and evaluateCron.
 */
function resolveNow(timezone: string, at?: string): Date | string {
  const now = at ? new Date(at) : new Date();
  if (Number.isNaN(now.getTime())) return `invalid "at" datetime "${at}"`;
  try {
    tzParts(now, timezone); // throws RangeError on an invalid timezone
  } catch {
    return `invalid timezone "${timezone}"`;
  }
  return now;
}

/** Pure, allocation-light check: validity + is-due + idempotency key. No next-run scan. */
export function checkCron(expression: string, timezone = "UTC", at?: string): CronCheck {
  const parsed = parseExpression(expression);
  if (typeof parsed === "string") {
    return { valid: false, error: parsed, isDue: false, matchedMinuteIso: "" };
  }
  const now = resolveNow(timezone, at);
  if (typeof now === "string") {
    return { valid: false, error: now, isDue: false, matchedMinuteIso: "" };
  }
  const nowParts = tzParts(now, timezone);
  return { valid: true, isDue: matches(parsed, nowParts), matchedMinuteIso: minuteKey(nowParts) };
}

/** Full evaluation: checkCron + the next-run instant. Parses the expression once. */
export function evaluateCron(expression: string, timezone = "UTC", at?: string): CronParseOutput {
  const parsed = parseExpression(expression);
  if (typeof parsed === "string") {
    return { valid: false, error: parsed, isDue: false, matchedMinuteIso: "", nextRunIso: null };
  }
  const now = resolveNow(timezone, at);
  if (typeof now === "string") {
    return { valid: false, error: now, isDue: false, matchedMinuteIso: "", nextRunIso: null };
  }
  const nowParts = tzParts(now, timezone);
  const isDue = matches(parsed, nowParts);
  const matchedMinuteIso = minuteKey(nowParts);

  // Skip the forward scan entirely when the schedule can never land on a real date.
  if (!scheduleCanOccur(parsed)) {
    return { valid: true, isDue, matchedMinuteIso, nextRunIso: null };
  }

  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  let nextRunIso: string | null = null;
  for (let i = 0; i < NEXT_RUN_SCAN_CAP_MINUTES; i++) {
    const candidate = new Date(start + i * 60000);
    if (matches(parsed, tzParts(candidate, timezone))) {
      nextRunIso = candidate.toISOString();
      break;
    }
  }
  return { valid: true, isDue, matchedMinuteIso, nextRunIso };
}

export const parseCronExpression = defineSkill<CronParseInput, CronParseOutput>(
  {
    name: "cron_parse_expression",
    description:
      "Parse a standard 5-field cron expression and, for a given instant + IANA timezone, report whether it is due this minute and when it next runs. Pure logic used by the cron-jobs scheduler to decide which jobs fire.",
    service: "cron",
    adr: "cron-jobs-entity",
  },
  async ({ expression, timezone = "UTC", at }) => evaluateCron(expression, timezone, at),
);
