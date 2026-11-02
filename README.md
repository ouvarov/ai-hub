# AI Hub

An MCP platform that lets non-engineers create AI tools from a chat with Claude and ship them through enforced steps: plan, review, pull request, merge.

This is the clean platform: three Cloudflare Workers and the builder pipeline. Company content has been removed, and one small skill remains as an example. `Acme` and `example.com` are placeholders.

## The idea

A prompt asks the model to behave. A tool can refuse. Each step of the pipeline is a tool that checks server-side state, so skipping a step returns an error instead of relying on the model to follow instructions.

Everything on the platform is one of three types:

| Type | What it does | Network and secrets |
|---|---|---|
| **Skill** | Pure logic, input to output | No |
| **Action** | Talks to the outside world | Yes, injected on the server |
| **Agent** | Composes skills and actions into a workflow | Through actions |

## How the hub serves skills

```
Claude client
   │  MCP over HTTP, OAuth 2.1
   ▼
gateway ── authenticates, adds the caller's identity and groups
   │
   ├─► skill-runner ── skills and agents as MCP tools, builder pipeline
   └─► agent-runner ── actions as MCP tools and webhooks, cron
```

A skill is a typed function with metadata. This is the example, from [`_shared/skills/text/word-stats.ts`](_shared/skills/text/word-stats.ts):

```ts
export const wordStats = defineSkill<WordStatsInput, WordStatsOutput>(
  {
    name: "text_word_stats",
    description: "Counts words and sentences in a text and estimates its reading time.",
    service: "text",
    inputSchema: { text: "Any plain text" },
  },
  async ({ text }) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const sentences = text.split(/[.!?]+/).filter((part) => part.trim()).length;

    return {
      words,
      sentences,
      readingTimeMinutes: Math.ceil(words / WORDS_PER_MINUTE),
    };
  },
);
```

Adding it to [`skill-runner/src/registry.ts`](skill-runner/src/registry.ts) is enough to publish it. For each session, [`run-skill.ts`](skill-runner/src/tools/run-skill.ts) loops over the registry and:

1. skips anything the caller's groups cannot access, so a user only sees their own tools;
2. builds the tool description from the metadata, including the `gather` steps that tell Claude what to collect from its other MCP servers first;
3. registers an MCP tool that parses the JSON input, runs the function and logs the result.

## How the hub generates skills

The user describes a problem in chat. The builder walks Claude through these tools:

```
start_building ──► list_skills + list_agents ──► run_bmad (questions)
   ──► confirm_plan ──► generate code ──► submit_for_review
   ──► run_bmad (reviews) ──► submit_final ──► create_pull_request
   ──► get_pr_review ──► push_fix_to_pr ──► confirm_merge
```

The rules the platform enforces:

| Mechanism | Why it exists | Code |
|---|---|---|
| **Run-scoped gates** | Pipeline state lives in a Durable Object under a `runId`, because MCP sessions are not a reliable place for it | [`builder-gates.ts`](skill-runner/src/builder-gates.ts), [`builder-run-state.ts`](skill-runner/src/builder-run-state.ts) |
| **Anchored edits** | Claude sends edits against unique anchors, and the server applies them. Resending a long file let the model truncate it | [`resolve-files.ts`](skill-runner/src/tools/resolve-files.ts) |
| **Submission validation** | Rejects removed registry entries, suspicious file shrinkage and code that breaks the platform's structure rules | [`validate-submission.ts`](skill-runner/src/tools/validate-submission.ts) |
| **Registry derivation** | Takes the registry from `main` and adds only the new entries, so a regenerated file cannot drop existing lines | [`derive-registry.ts`](skill-runner/src/tools/derive-registry.ts) |
| **Merge readiness** | A pure function decides whether a run may merge: pinned head SHA, passing checks, an approved review, allowed paths only | [`merge-readiness.ts`](skill-runner/src/tools/merge-readiness.ts) |

The self-merge boundary is deliberate. An author can merge their own skills, actions, agents, docs and tests. Platform code stays with an engineer.

## Repository layout

```
_shared/          types, libraries and the example skill
skill-runner/     MCP server for skills and agents, builder pipeline
agent-runner/     MCP server for actions, webhooks, cron
gateway/          OAuth 2.1 server and routing (Hono)
_template/        reference used by the builder when generating code
_bmad/            BMAD Method workflows served by run_bmad (MIT, see _bmad/LICENSE)
test/             unit tests for the pipeline logic
CLAUDE.md         instructions the builder gives Claude
```

## Run the checks

Requires Node 22 and pnpm 10.

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

This repository is meant for reading and for running the tests. Nothing is deployed from it. Running it for real would need a Cloudflare account, an OIDC provider, HashiCorp Vault, a GitHub App and a review bot, with the placeholder values replaced. `deploy.yml` only runs when started by hand and is kept to show how deployment worked.

## Known limitations

- `push_fix_to_pr` takes any branch name and does not check that the caller owns the run.
- The webhook and cron path for actions does not check `allowedGroups`, and one shared key opens all actions.
- Tool input is a JSON string. `inputSchema` is an example placed in the description, and the input is not validated against it.
- Scheduled jobs keep no run state, so a daylight-saving change can skip or repeat a run.

## Stack

TypeScript, Cloudflare Workers and Durable Objects, `@modelcontextprotocol/sdk`, Hono, Zod, Vitest, GitHub Actions.

## More

- [How it worked](docs/HOW-IT-WORKED.md): login, tool registration and every builder step, with the reasons behind them
- [A Prompt Is a Wish. A Tool Is a Law.](https://dev.to/ouvarov/a-prompt-is-a-wish-a-tool-is-a-law-54pl)
