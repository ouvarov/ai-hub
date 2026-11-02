# How it worked

A walkthrough of the platform as it ran in production. This repository is here for reading: nothing is deployed from it, and the hosts and IDs are placeholders.

## The problem

Teams were duplicating AI tooling, and people who were not engineers needed a safe way to build tools of their own.

The hub put everything behind one MCP server. Connect Claude once, and you see every tool you have access to. Describe what you need, and the builder takes it to production.

## The three Workers

| Worker | Responsibility |
|---|---|
| `gateway` | OAuth 2.1 server for Claude clients, routing, secrets broker, webhook entry point |
| `skill-runner` | Exposes skills and agents as MCP tools, runs the builder pipeline, proxies actions |
| `agent-runner` | Exposes actions as MCP tools and webhooks, runs the cron scheduler |

They talk over Cloudflare service bindings. Only the gateway can reach Vault.

## Connecting and logging in

1. A Claude client connects to the gateway and goes through OAuth 2.1 with PKCE.
2. The gateway sends the user to the company identity provider (Authentik over OIDC) and gets their email and groups.
3. On each MCP request the gateway validates the token, then forwards the request to a runner over a service binding.
4. It first deletes any `X-User-*` headers from the client, then sets its own, so a client cannot fake an identity.

Runners trust those headers only for calls that came over the binding. Such calls have no `cf-connecting-ip`, so a request that has that header came from the public internet and gets a 403.

Code: [`gateway/src/oauth-handlers.ts`](../gateway/src/oauth-handlers.ts).

## How a skill reaches the user

Each MCP session is a Durable Object (`McpAgent`). When it starts, it:

1. fetches secrets from the gateway;
2. reads the caller's identity;
3. loops over the registry and registers the tools this user may see.

Tools are filtered by group at registration, so a tool you have no access to does not exist in your session.

A tool's description is built from the skill's metadata. `gather` is the important part:

```
Counts words and sentences in a text and estimates its reading time.

Expected input JSON structure:
{ "text": "Any plain text" }
```

With `gather`, the description also tells Claude what to collect first from its other MCP servers, such as Jira or Slack. Claude fetches the data and passes it in, and the skill stays pure logic.

Code: [`skill-runner/src/tools/run-skill.ts`](../skill-runner/src/tools/run-skill.ts).

### Skill, action or agent

- **Skill:** no network and no secrets, so it is safe to reuse anywhere and easy to test.
- **Action:** the only type that calls external APIs. Secrets arrive in `ctx.env`, so the author never holds a token. It can also run from a webhook or a cron job.
- **Agent:** composes skills into a workflow. When a workflow waits on a long external job, it splits into `*_prepare` and `*_finalize`, and an opaque context object carries state between them instead of chat memory.

## How a skill gets generated

Suppose someone types: "I want a tool that counts words in a text." Claude has the builder instructions, so it calls `start_building`.

| Step | Tool | What happens | Refuses when |
|---|---|---|---|
| 1 | `start_building` | Opens a run, returns a `runId`, the architecture rules and code patterns | |
| 2 | `list_skills`, `list_agents` | Shows what already exists, so it gets reused | |
| 3 | `run_bmad` | Serves a discovery workflow, and Claude asks the person about the problem | |
| 4 | `confirm_plan` | Records the plan, tells Claude to stop and get a "yes" | Steps 2–3 were not done |
| 5 | `submit_for_review` | Applies edits, validates the generated files | Step 4 was not done, or validation fails |
| 6 | `run_bmad` | Serves three reviews: adversarial, edge cases, code quality | |
| 7 | `submit_final` | Takes the fixed files and the findings, validates again | Findings are too short, or validation fails |
| 8 | `create_pull_request` | Rebuilds registries from `main`, opens a PR as the GitHub App | Any gate is missing |
| 9 | `get_pr_review`, `push_fix_to_pr` | Reads CI and review bot results, pushes fixes | |
| 10 | `confirm_merge` | Shows a preview, then merges after the person types the PR number | Merge readiness fails |

Merging to `main` triggered the deploy, so the new tool appeared in everyone's session.

### Why it is built this way

**Gates live on the server.** Instructions in a prompt can be skipped. Here each tool reads the run's state from a Durable Object and refuses if a step is missing. The state is keyed by `runId` because an MCP session is not guaranteed to stay stable.

A gate proves a step happened, not that it was done well. `reviewFindings` is only checked for length, for example. The real protection comes from validation, CI and the review bot.

**Edits instead of whole files.** The model truncated long files when it had to resend them. So Claude sends operations such as `insertAfter` against a unique anchor, and the server applies them. See [`resolve-files.ts`](../skill-runner/src/tools/resolve-files.ts).

**The server does not trust generated registries.** A regenerated registry could silently lose lines. `create_pull_request` takes the file from `main` and adds only the new entries. See [`derive-registry.ts`](../skill-runner/src/tools/derive-registry.ts).

**Validation runs twice.** `submit_final` checks again because its files can differ from what passed `submit_for_review`. See [`validate-submission.ts`](../skill-runner/src/tools/validate-submission.ts).

**Merging is a pure function.** Merge is the one step with no undo, so every refusal lives in a function with no network access, and it is unit-tested. See [`merge-readiness.ts`](../skill-runner/src/tools/merge-readiness.ts).

### The self-merge boundary

An author may merge skills, actions, agents, docs, tests and the registries. Platform code needs an engineer.

`_shared/lib/github.ts` is denied even though it sits inside the allowed tree. It produces the approval state that merge readiness relies on, so a PR changing it could approve itself. A file that decides whether you may self-merge cannot live where you can self-merge.

## Secrets

Secrets lived in HashiCorp Vault, reached through a Cloudflare Tunnel. The gateway loaded them and served them to the runners over `/__internal/secrets`, which is blocked for public requests. Actions received them in `ctx.env`.

Every action received all the secrets, not just its own. See the limitations below.

## Webhooks and cron

- **Webhook:** `POST /actions/:name` with a key goes to the gateway, which replies immediately and runs the action in the background. Cloudflare limits how long that can run, so long jobs are split into submit and poll actions.
- **Cron:** a Cloudflare trigger fires every minute. A pure function, `cron_select_due_jobs`, decides what is due, and those actions run in-process.

## Limitations I would fix next

- `push_fix_to_pr` accepts any branch and does not check that the caller owns the run.
- Webhook and cron calls skip the `allowedGroups` check, and one shared key opens every action.
- Every action receives every secret. Each should declare the keys it needs.
- Tool input is a JSON string with no schema validation.
- Cron has no run state, so a daylight-saving change can skip or repeat a job.
- Some gates, such as `listSkills`, are satisfied just by calling the tool.

## Reading order

1. [`_shared/types/skill.ts`](../_shared/types/skill.ts) and the example skill
2. [`skill-runner/src/tools/run-skill.ts`](../skill-runner/src/tools/run-skill.ts)
3. [`skill-runner/src/builder-gates.ts`](../skill-runner/src/builder-gates.ts)
4. [`skill-runner/src/tools/merge-readiness.ts`](../skill-runner/src/tools/merge-readiness.ts) and its tests
5. [`CLAUDE.md`](../CLAUDE.md), the instructions the builder gives Claude
