# Skills — How to Write

## What is a Skill?

A skill is an **atomic action** — one function that does one thing.
It does NOT know about MCP, agents, or Claude. Just input → output.

## Contract

```typescript
import { defineSkill } from "../types";

// Define typed interfaces for input and output
interface ExtractLinksInput {
  text: string;
}

interface ExtractLinksOutput {
  links: Array<{ url: string; fileKey: string; nodeId?: string }>;
}

export const extractLinks = defineSkill<ExtractLinksInput, ExtractLinksOutput>(
  {
    name: "figma_extract_links",
    description: "Extract Figma file/node URLs from any text",
    service: "figma",
    adr: "001-extract-links",  // links to docs/adr/001-extract-links.md
  },
  async (input, ctx) => {
    const regex = /https:\/\/(?:www\.)?figma\.com\/(design|file)\/([a-zA-Z0-9]+)(?:\/[^?\s]*)?(?:\?node-id=([^&\s]+))?/g;
    const links: ExtractLinksOutput["links"] = [];
    let match;
    while ((match = regex.exec(input.text)) !== null) {
      links.push({
        url: match[0],
        fileKey: match[2],
        nodeId: match[3]?.replace("-", ":"),
      });
    }
    return { links };
  },
);
```

## Rules

1. **One file = one skill** (or a few closely related ones)
2. **No fetch, no tokens** — skills receive pre-fetched data as input. Claude gathers data from its MCPs and passes it.
3. **Typed input and output** — define interfaces in the same file (not as generic placeholders)
4. **No MCP imports** — skills don't know about MCP
5. **Folder = knowledge domain** — `skills/figma/`, `skills/jira/`, `skills/analysis/`, NOT `skills/preref/`
6. **`gather` field** — if the skill needs data from external MCPs (Jira, ReviewBot, Figma), describe what Claude should fetch. This appears in the tool description when skill-runner registers it.
7. **Always register in `skill-runner/src/registry.ts`** — so Claude Desktop can call it
8. **Mandatory ADR** — every new skill must have an ADR in `docs/adr/` and the `adr` field set in meta

## skill-runner limitation

Skills called through `skill-runner` receive `ctx.env = {}` (empty). This means:
- **Pure skills** (no API calls) work fine through skill-runner
- **Skills that need Vault secrets** via `ctx.env` will NOT work through skill-runner — they must be called through their own MCP service where env is properly injected

If your skill needs `ctx.env`, document this clearly in the skill description.

## Naming

- File: `kebab-case.ts` (e.g. `extract-links.ts`)
- Skill name: `snake_case` with domain prefix (e.g. `figma_extract_links`)
- Export: named export, camelCase (e.g. `export const extractLinks = defineSkill(...)`)

## Example

See `_shared/skills/` for existing skills.