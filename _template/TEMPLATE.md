# Template Reference

Examples for creating skills, actions, and agents.

---

## 1. Skill — `_shared/skills/{domain}/{action}.ts`

Pure function. **No fetch, no tokens, no side effects.**

```typescript
import { defineSkill } from "@shared/types";

// 1. Define input/output interfaces
export interface MyInput {
  text: string;
  options?: { verbose: boolean };
}

export interface MyOutput {
  results: string[];
  count: number;
}

// 2. Export skill with camelCase name
export const extractSomething = defineSkill<MyInput, MyOutput>(
  {
    name: "domain_extract_something",        // snake_case with domain prefix
    description: "What this skill does in one sentence",
    service: "domain",                        // knowledge domain: jira, figma, analysis, formatting, etc.
    gather: ["Description of what Claude should fetch before calling this"],
    adr: "001-extract-something",
    // allowedGroups: ["team-name"],         // restrict to specific Authentik groups (omit for public)
  },
  async ({ text, options }) => {
    // Pure logic here — NO fetch(), NO tokens
    const results = text.split("\n").filter(Boolean);

    return {
      results,
      count: results.length,
    };
  },
);
```

### Example — `_shared/skills/jira/extract-requirements.ts`

```typescript
import { defineSkill } from "@shared/types";

export interface JiraTicketData {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  labels: string[];
  acceptanceCriteria?: string;
}

export interface Requirement {
  id: string;
  title: string;
  type: "functional" | "non-functional" | "ui" | "api" | "data";
  priority: "must" | "should" | "could";
  acceptanceCriteria: string[];
}

export const extractRequirements = defineSkill<
  { ticketData: JiraTicketData },
  { requirements: Requirement[]; tags: string[] }
>(
  {
    name: "jira_extract_requirements",
    description: "Parse Jira ticket into structured requirements list",
    service: "jira",
    gather: ["Jira ticket data (get issue by key — all fields)"],
  },
  async ({ ticketData }) => {
    // ... pure logic: parse, classify, extract
  },
);
```

---

## 2. Action — `_shared/actions/{domain}/{action}.ts`

Side-effect function. **Makes fetch() calls, uses secrets from Vault via `ctx.env`.**

Use Action when:
- You need to call an external API (HTTP request)
- You need secrets/tokens from Vault
- You need Claude API for text analysis/generation on the worker (Action-Agent)
- The tool will be triggered by a webhook (Jira, Slack, GitHub)

Two flavors:
- **Action-API** — simple fetch, no Claude API
- **Action-Agent** — fetch + Claude API for text analysis/generation/classification (requires `CLAUDE_API_KEY` from Vault)

**Runtime budget (Cloudflare Workers — see "Runtime" in CLAUDE.md before designing):**
webhook/API-triggered actions get **~30 s** wall-clock (gateway runs them via
`waitUntil` after replying 200 — longer work is killed silently); interactive MCP
calls live while the client waits; Cron Triggers get 15 min. If the action can
exceed 30 s (async report polling, multi-account scans, media jobs), split it into
`submit`/`poll`/`finalize` actions or accept a partition parameter (one shard per
invocation) — never sleep-poll for minutes inside one call.

```typescript
import { defineAction } from "@shared/types";

// 1. Define input/output interfaces
export interface HealthCheckInput {
  url: string;
  timeout?: number;
}

export interface HealthCheckOutput {
  status: "ok" | "error";
  httpCode: number | null;
  responseTime: number;
  message: string;
}

// 2. Export action with camelCase name
export const healthCheck = defineAction<HealthCheckInput, HealthCheckOutput>(
  {
    name: "web_health_check",              // snake_case with domain prefix
    description: "Check website availability and response time",
    service: "web",                         // knowledge domain
    gather: ["URL to check (or use default https://example.com/)"],
    adr: "004-health-check",
  },
  async ({ url, timeout = 10000 }, ctx) => {
    // fetch() is allowed here — this is an Action
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(timeout),
      });
      const responseTime = Date.now() - start;

      return {
        status: response.ok ? "ok" : "error",
        httpCode: response.status,
        responseTime,
        message: `${response.status} in ${responseTime}ms`,
      };
    } catch (error) {
      return {
        status: "error",
        httpCode: null,
        responseTime: Date.now() - start,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
);
```

### Example — Action-Agent (fetch + Claude API)

```typescript
import { defineAction } from "@shared/types";

export const reviewTicket = defineAction<ReviewInput, ReviewOutput>(
  {
    name: "jira_review_ticket",
    description: "Analyze Jira ticket with Claude API and post review comment",
    service: "jira",
    gather: ["Jira ticket data (get issue by key — all fields)"],
    adr: "005-review-ticket",
  },
  async ({ ticketData, issueKey }, ctx) => {
    // Step 1: Call Claude API for analysis (Action-Agent flavor)
    const analysis = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ctx.env.CLAUDE_API_KEY,  // from Vault
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: `Review this ticket: ${ticketData}` }],
      }),
    });

    const result = await analysis.json();
    ctx.metrics.reportTokens({
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
      model: result.model,
    });

    // Step 2: Post review to Jira (fetch to external API)
    await fetch(`https://jira.example.com/rest/api/2/issue/${issueKey}/comment`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.env.JIRA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: result.content[0].text }),
    });

    return { reviewPosted: true, issueKey };
  },
);
```

---

## 3. Agent — `_shared/agents/{name}.ts`

Orchestrates skills into a workflow. **No fetch, no API calls, no MCP knowledge.**

```typescript
import { defineAgent } from "@shared/types";
import { extractSomething } from "@shared/skills/domain/extract-something";
import { formatResult } from "@shared/skills/formatting/format-result";

export interface AgentInput {
  rawData: string;
  context?: object;
}

export interface AgentOutput {
  markdown: string;
  itemCount: number;
}

export const myAgent = defineAgent<AgentInput, AgentOutput>(
  {
    name: "my_agent",
    description: "What this agent does end-to-end",
    skills: ["domain_extract_something", "formatting_format_result"],
    adr: "002-my-agent",
  },
  async (input, ctx) => {
    // Step 1: Extract
    const extracted = await extractSomething.execute(
      { text: input.rawData },
      ctx,
    );

    // Step 2: Format
    const formatted = await formatResult.execute(
      { items: extracted.results },
      ctx,
    );

    return {
      markdown: formatted.markdown,
      itemCount: extracted.count,
    };
  },
);
```

---

## 4. Migrating a `.claude/agents/*.md` agent

Source markdown describes one workflow with numbered steps. **Do not map it agent → agent 1:1.** The source is a v0 spec; the AI Hub shape is decomposed.

### Anchor patterns

| Anchor | When to use | Why |
|---|---|---|
| `ticket_reviewer` (`ticket_reviewer`) | Single-call workflow: Claude gathers everything, then calls the agent once | 5 skills, raw-JSON inputs cover every gather step |
| `report_export_prepare` + `report_export_finalize` | Workflow waits on an external job mid-flow (e.g. a long export or render) | First agent returns an opaque `phase3Context` blob; second agent consumes it verbatim |

### Decomposition rule

For each numbered step in the source markdown:

| Step does | → Becomes |
|---|---|
| Parse / format / classify / build / validate | **Skill** in `_shared/skills/{domain}/` |
| External API / HTTP call | **Action** in `_shared/actions/{domain}/` |
| Pure orchestration | Stays in the **agent** body |

Every gather step that produces data MUST have a corresponding `raw*` field on the agent's `Input` interface. If the workflow has a phase boundary, split the agent.

### Worked example — a report export with an external job

The source markdown had steps to look up a report, create an export, wait for the external job and publish the result. It becomes three phases:

```
[prepare agent]            [external job]        [finalize agent]
report_export_prepare      export_submit/poll    report_export_finalize
├ report_parse_id          (actions)             ├ export_validate_result
├ report_parse_source                            └ report_build_publish_payload
└ report_build_export_name

→ returns exportRequest, phase3Context (opaque)
```

Every gather step has its own `raw*` input field holding the verbatim MCP response. The agent never makes the call itself: Claude collects the data, the agent transforms it, and `phase3Context` carries state between phases instead of chat memory.

### Anti-pattern

One agent with `skills: []`, a long numbered workflow written as `gather` prose, and no `raw*` fields. Claude has to carry intermediate values across many MCP calls in working memory and loses them in long chats. `submit_for_review` blocks this shape.

## 5. Registries

### Skill Runner — `skill-runner/src/registry.ts`

Every new skill and agent must be registered here.

```typescript
import type { Skill, Agent } from "@shared/types";
import { extractSomething } from "@shared/skills/domain/extract-something";
import { myAgent } from "@shared/agents/my-agent";

export const skills: Skill<unknown, unknown>[] = [
  extractSomething,
];

export const agents: Agent<unknown, unknown>[] = [
  myAgent,
];
```

Skill-runner automatically:
- Registers each skill/agent as an MCP tool
- Generates tool descriptions with `gather` instructions
- For agents, collects `gather` from all referenced skills

### Agent Runner — `agent-runner/src/registry.ts`

Every new action must be registered here.

```typescript
import type { Action } from "@shared/types";
import { healthCheck } from "@shared/actions/web/health-check";

export const actions: Action<unknown, unknown>[] = [
  healthCheck,
];
```

Agent-runner automatically:
- Registers each action as an MCP tool (for Claude Desktop)
- Exposes each action as HTTP endpoint: `POST /actions/{name}` (for webhooks)
- Injects secrets from Vault via `ctx.env`
- Logs execution: action name, trigger type, duration, status

---

## Checklist

**For skills:**
- [ ] Pure function — NO `fetch()`, NO tokens, NO side effects
- [ ] Organized by domain (`skills/jira/`, `skills/analysis/`), not feature
- [ ] Uses `defineSkill()`
- [ ] Registered in `skill-runner/src/registry.ts`
- [ ] ADR generated in `docs/adr/`
- [ ] `allowedGroups` set if user requested group restriction (omit for public)

**For actions:**
- [ ] Uses `defineAction()`
- [ ] All secrets via `ctx.env` (Vault), never hardcoded
- [ ] Organized by domain (`actions/web/`, `actions/jira/`)
- [ ] Registered in `agent-runner/src/registry.ts`
- [ ] ADR generated in `docs/adr/`
- [ ] If Action-Agent: reports token usage via `ctx.metrics.reportTokens()`
- [ ] `allowedGroups` set if user requested group restriction (omit for public)

**For agents:**
- [ ] Orchestrates skills only — NO `fetch()`, NO direct API calls
- [ ] Uses `defineAgent()`
- [ ] Registered in `skill-runner/src/registry.ts`
- [ ] ADR generated in `docs/adr/`
- [ ] `allowedGroups` set if user requested group restriction (omit for public)

**Never do:**
- [ ] `fetch()` inside a skill or agent
- [ ] Create a separate MCP service inside AI Hub
- [ ] Hardcode secrets in code
