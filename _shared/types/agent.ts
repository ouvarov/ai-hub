/**
 * Agent — an orchestrator that combines skills into a workflow.
 *
 * Rules:
 * - Imports and calls skills, never calls APIs directly
 * - Does not know about MCP — just solves a business problem
 * - Receives SkillContext so it can pass env to skills
 */

import type { SkillContext } from "./skill";

export interface AgentMeta {
  name: string;
  description: string;
  /** Which skills this agent depends on */
  skills: string[];
  /** Step-by-step instructions for Claude on what data to gather before calling this agent */
  gather?: string[];
  /** ADR filename (e.g. "001-preref-analyzer") — links to docs/adr/{name}.md */
  adr?: string;
  /** Authentik groups that can access this agent. Empty/undefined = public (everyone). */
  allowedGroups?: string[];
  /**
   * Opt-in: when true, this agent may propose review-gated self-improvement PRs
   * upon detecting gaps in its own work. A proposal always requires human
   * confirmation, and any resulting PR goes through the same builder review
   * pipeline (BMAD + ReviewBot) as normal creation — never auto-merged.
   * Default (undefined) = disabled. See ADR self-improving-agents-foundation.
   */
  selfImprove?: boolean;
}

export type Agent<TInput, TOutput> = {
  meta: AgentMeta;
  execute: (input: TInput, ctx?: SkillContext) => Promise<TOutput>;
};

/** Helper to define an agent with proper typing. Provides default empty ctx. */
export function defineAgent<TInput, TOutput>(
  meta: AgentMeta,
  execute: (input: TInput, ctx: SkillContext) => Promise<TOutput>,
): Agent<TInput, TOutput> {
  return {
    meta,
    execute: (input, ctx = { env: {} }) => execute(input, ctx),
  };
}
