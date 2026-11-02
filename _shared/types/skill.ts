/**
 * Skill — an atomic action. One function, one responsibility.
 *
 * Rules:
 * - Pure input → output, no side knowledge of MCP or agents
 * - All external dependencies (tokens, base URLs) passed via `ctx`
 * - Always async, always returns typed output
 * - Handles its own HTTP errors
 */

export interface SkillContext {
  /** API tokens, base URLs, and other config injected from Worker env */
  env: Record<string, string>;
}

export interface SkillMeta {
  name: string;
  description: string;
  /** Knowledge domain: jira, figma, analysis, formatting */
  service: string;
  /** What Claude should fetch from other MCPs before calling this skill */
  gather?: string[];
  /**
   * JSON example of the expected input structure.
   * Used to generate the MCP tool description so Claude knows what to pass.
   */
  inputSchema?: Record<string, unknown>;
  /** ADR filename (e.g. "001-extract-requirements") — links to docs/adr/{name}.md */
  adr?: string;
  /** Authentik groups that can access this skill. Empty/undefined = public (everyone). */
  allowedGroups?: string[];
}

export type Skill<TInput, TOutput> = {
  meta: SkillMeta;
  execute: (input: TInput, ctx?: SkillContext) => Promise<TOutput>;
};

/** Helper to define a skill with proper typing. Provides default empty ctx. */
export function defineSkill<TInput, TOutput>(
  meta: SkillMeta,
  execute: (input: TInput, ctx: SkillContext) => Promise<TOutput>,
): Skill<TInput, TOutput> {
  return {
    meta,
    execute: (input, ctx = { env: {} }) => execute(input, ctx),
  };
}