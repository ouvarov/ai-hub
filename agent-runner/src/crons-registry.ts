import type { Cron } from "@shared/types";

/**
 * Cron jobs registry — declarative scheduled jobs dispatched by the
 * agent-runner `scheduled()` handler on each master tick.
 *
 * Add one `defineCron()` file at a time under `_shared/crons/<job>.ts`,
 * import it here, and list it below — same flow as skills/actions.
 */
export const crons: Cron[] = [];
