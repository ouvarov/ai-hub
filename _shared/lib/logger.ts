/**
 * Logger that pushes logs to Grafana Loki.
 *
 * Collects log entries during an action lifecycle, then flushes
 * them as a batch to Loki's push API.
 *
 * Usage:
 *   const logger = createActionLogger(secrets, { action: "ticket_reviewer", trigger: "mcp" });
 *   logger.info("Starting execution");
 *   logger.error("Something failed", { ticketKey: "PGS-123" });
 *   await logger.flush();  // or ctx.waitUntil(logger.flush())
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: number; // nanosecond timestamp
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

interface LokiConfig {
  url: string; // e.g. https://logs.example.com
  tenantId: string; // X-Scope-OrgID
  serviceName: string; // label: service_name
  job: string; // label: job
}

interface LokiStream {
  stream: Record<string, string>;
  values: [string, string][]; // [nanosecond_ts, line]
}

export class Logger {
  private config: LokiConfig;
  private entries: LogEntry[] = [];
  private requestMeta: Record<string, unknown> = {};

  constructor(config: LokiConfig) {
    this.config = config;
  }

  /** Set request-level metadata (added to all log entries in this batch). */
  setRequestMeta(meta: Record<string, unknown>): void {
    this.requestMeta = { ...this.requestMeta, ...meta };
  }

  debug(message: string, meta?: Record<string, string>): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, string>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, string>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, string>): void {
    this.log("error", message, meta);
  }

  /** Flush all collected logs to Loki. */
  async flush(): Promise<void> {
    if (this.entries.length === 0) return;

    // Group entries by level for separate streams (better Loki querying)
    const streamMap = new Map<string, LokiStream>();

    for (const entry of this.entries) {
      const streamKey = entry.level;

      if (!streamMap.has(streamKey)) {
        streamMap.set(streamKey, {
          stream: {
            service_name: this.config.serviceName,
            job: this.config.job,
            level: entry.level,
          },
          values: [],
        });
      }

      const logLine = JSON.stringify({
        msg: entry.message,
        level: entry.level,
        ...this.requestMeta,
        ...entry.meta,
      });

      streamMap.get(streamKey)!.values.push([String(entry.ts), logLine]);
    }

    const payload = { streams: Array.from(streamMap.values()) };

    try {
      const response = await fetch(`${this.config.url}/loki/api/v1/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Scope-OrgID": this.config.tenantId,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[LOKI] Push failed ${response.status}: ${errText}`);
      }
    } catch (error) {
      console.error("[LOKI] Push error:", error);
    }
  }

  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, string>,
  ): void {
    // Also write to console for wrangler tail / CF dashboard
    const prefix = `[${level.toUpperCase()}]`;
    if (level === "error") {
      console.error(prefix, message);
    } else if (level === "warn") {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }

    this.entries.push({
      ts: Date.now() * 1_000_000,
      level,
      message,
      meta: { ...this.requestMeta, ...meta },
    });
  }
}

/** Noop logger — used when Loki is not configured (local dev). */
class NoopLogger extends Logger {
  constructor() {
    super({ url: "", tenantId: "", serviceName: "", job: "" });
  }
  async flush(): Promise<void> {
    // no-op: logs still go to console via parent .log()
  }
}

/**
 * Create a Logger for action execution.
 * Falls back to NoopLogger if LOKI_URL is not set (local dev).
 */
export function createActionLogger(
  secrets: Record<string, string>,
  meta: { action: string; trigger: "mcp" | "webhook" },
): Logger {
  const url = secrets.LOKI_URL;
  const tenantId = secrets.LOKI_TENANT_ID;

  if (!url || !tenantId) {
    const logger = new NoopLogger();
    logger.setRequestMeta(meta);
    return logger;
  }

  const logger = new Logger({
    url,
    tenantId,
    serviceName: "ai-hub-agent-runner",
    job: "actions",
  });

  logger.setRequestMeta(meta);
  return logger;
}

/**
 * Create a Logger for skill/agent execution in the skill-runner.
 * Mirrors createActionLogger so skill and agent invocations land in Loki
 * the same way actions do. Falls back to NoopLogger if LOKI_URL is not set.
 */
export function createSkillLogger(
  secrets: Record<string, string>,
  meta: { name: string; kind: "skill" | "agent"; user?: string },
): Logger {
  const url = secrets.LOKI_URL;
  const tenantId = secrets.LOKI_TENANT_ID;

  const requestMeta: Record<string, string> = {
    name: meta.name,
    kind: meta.kind,
    ...(meta.user ? { user: meta.user } : {}),
  };

  if (!url || !tenantId) {
    const logger = new NoopLogger();
    logger.setRequestMeta(requestMeta);
    return logger;
  }

  const logger = new Logger({
    url,
    tenantId,
    serviceName: "ai-hub-skill-runner",
    job: "skills",
  });

  logger.setRequestMeta(requestMeta);
  return logger;
}

/**
 * Create a Logger for a Builder pipeline tool call.
 *
 * Separate `job` label from skills/agents: builder traffic is pipeline
 * instrumentation, not skill execution, and mixing them would make both
 * harder to query. Query with {service_name="ai-hub-skill-runner", job="builder"}.
 */
export function createBuilderLogger(
  secrets: Record<string, string>,
  meta: { tool: string; user?: string },
): Logger {
  const url = secrets.LOKI_URL;
  const tenantId = secrets.LOKI_TENANT_ID;

  const requestMeta: Record<string, string> = {
    tool: meta.tool,
    ...(meta.user ? { user: meta.user } : {}),
  };

  if (!url || !tenantId) {
    const logger = new NoopLogger();
    logger.setRequestMeta(requestMeta);
    return logger;
  }

  const logger = new Logger({
    url,
    tenantId,
    serviceName: "ai-hub-skill-runner",
    job: "builder",
  });

  logger.setRequestMeta(requestMeta);
  return logger;
}
