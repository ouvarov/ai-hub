import { defineSkill } from "@shared/types";

export interface EnhancementReportInput {
  /** Short summary of the proposal — becomes the issue title */
  title: string;
  /** What gap or friction exists today */
  problem: string;
  /** What should be built to address it */
  proposedSolution: string;
  /** What changes for the user once shipped */
  expectedOutcome?: string;
  /** Who reported (email, name) — from OAuth */
  reporter?: { email: string; name: string };
}

export interface EnhancementReportOutput {
  title: string;
  body: string;
}

export const formatEnhancementReport = defineSkill<EnhancementReportInput, EnhancementReportOutput>(
  {
    name: "github_format_enhancement_report",
    description:
      "Formats a structured GitHub enhancement/proposal issue from conversation context. Use when a user proposes a new feature or improvement to ai-hub (not a bug). Claude provides the proposal — the skill structures it into a problem/solution/outcome issue body.",
    service: "github",
    gather: [
      "A short title summarising the proposal",
      "The problem: what gap or friction exists today",
      "The proposed solution: what should be built",
      "Optional: the expected outcome — what changes for the user once shipped",
    ],
    adr: "github-format-enhancement-report",
  },
  async (input) => {
    if (!input.title || typeof input.title !== "string") {
      throw new Error('Missing required field "title" (string): short summary of the proposal');
    }
    if (!input.problem || typeof input.problem !== "string") {
      throw new Error('Missing required field "problem" (string): what gap/friction exists today');
    }
    if (!input.proposedSolution || typeof input.proposedSolution !== "string") {
      throw new Error('Missing required field "proposedSolution" (string): what should be built');
    }
    return { title: buildTitle(input), body: buildBody(input) };
  },
);

function buildTitle(input: EnhancementReportInput): string {
  const t = input.title.length > 70 ? input.title.slice(0, 67) + "..." : input.title;
  return `Enhancement: ${t}`;
}

function buildBody(input: EnhancementReportInput): string {
  const sections: string[] = [];

  sections.push(`## Problem\n\n${input.problem}`);
  sections.push(`## Proposed solution\n\n${input.proposedSolution}`);

  if (input.expectedOutcome) {
    sections.push(`## Expected outcome\n\n${input.expectedOutcome}`);
  }

  const reporter = input.reporter
    ? `${input.reporter.name} (${input.reporter.email})`
    : "unknown";
  sections.push(`---\n_Proposed by ${reporter} via ai-hub-enhancement-report_`);

  return sections.join("\n\n");
}
