# Agents — How to Write

## What is an Agent?

An agent is an **orchestrator** — it combines multiple skills into a workflow
to solve a business problem. It does NOT know about MCP.

## Contract

```typescript
import { defineAgent, type SkillContext } from "../types";
import { getTicket } from "../skills/jira/get-ticket";
import { createPR } from "../skills/github/create-pr";

export const prBuilderAgent = defineAgent<
  { ticketId: string },
  { prUrl: string }
>(
  {
    name: "pr_builder",
    description: "Takes a Jira ticket and creates a PR with proper title",
    skills: ["jira_get_ticket", "github_create_pr"],
    adr: "002-pr-builder",  // links to docs/adr/002-pr-builder.md
  },
  async (input, ctx) => {
    const ticket = await getTicket.execute({ ticketId: input.ticketId }, ctx);
    const pr = await createPR.execute({
      branch: `feature/${input.ticketId}`,
      title: ticket.summary,
      body: ticket.description,
    }, ctx);
    return { prUrl: pr.url };
  },
);
```

## Rules

1. **Import skills, never call APIs directly** — if there's no skill for what you need, create one first
2. **All secrets flow through `ctx`** — agent passes ctx to every skill
3. **One agent = one business workflow**
4. **Typed input and output** — define interfaces clearly
5. **No MCP imports** — agents don't know about MCP
6. **Mandatory ADR** — every new agent must have an ADR in `docs/adr/` and the `adr` field set in meta
7. **Every `gather` step MUST have a corresponding field in the Input interface.** Claude collects data via MCP tools and passes it through input fields. If there's no input field, the gathered data has nowhere to go and the agent won't work.

## Gather → Input pattern

When an agent uses `gather` to tell Claude to collect data from MCP tools (Notion, Slack, Jira, etc.), the Input interface must have fields for each gathered result. See `ticket-quality-reviewer.ts` for the reference implementation.

```typescript
// ❌ WRONG — gather says to search Notion and Slack, but input has no fields for results
export interface BotInput {
  question: string;
}

// ✅ CORRECT — every gather step has a corresponding input field
export interface BotInput {
  question: string;
  rawFaqResult: string;     // ← Claude puts Notion FAQ search result here
  rawNotionResult: string;  // ← Claude puts Notion workspace search result here
  rawSlackResult: string;   // ← Claude puts Slack search result here
}
```

In `execute()`, determine which source returned data:
```typescript
async (input, ctx) => {
  let rawAnswer = "";
  let source: "faq" | "notion" | "slack" | "not_found" = "not_found";

  if (input.rawFaqResult?.trim()) {
    rawAnswer = input.rawFaqResult;
    source = "faq";
  } else if (input.rawNotionResult?.trim()) {
    rawAnswer = input.rawNotionResult;
    source = "notion";
  } else if (input.rawSlackResult?.trim()) {
    rawAnswer = input.rawSlackResult;
    source = "slack";
  }
  // ... pass to formatting skill
}
```

## After writing an agent

1. **Register the agent** in `skill-runner/src/registry.ts` — it becomes a callable MCP tool automatically
2. **Register its skills** — every skill used by the agent must also be in `skill-runner/src/registry.ts`
3. Skill-runner auto-generates the tool description with `gather` instructions collected from all skills the agent uses
4. If the agent needs Vault secrets (`ctx.env`) — it must run through a separate MCP service instead

## Naming

- File: `kebab-case.ts` (e.g. `pr-builder.ts`)
- Agent name: `snake_case` (e.g. `pr_builder`)
- Export: named export, camelCase (e.g. `export const prBuilderAgent = defineAgent(...)`)
