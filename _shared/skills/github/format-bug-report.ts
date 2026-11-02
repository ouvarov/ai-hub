import { defineSkill } from "@shared/types";

export interface BugReportInput {
  /** What the user was trying to do */
  userGoal: string;
  /** Which step of the Builder flow failed (e.g. "Step 5 \u2014 Generate code") */
  failedStep?: string;
  /** Error messages, stack traces, tool call failures */
  errorDetails: string;
  /** What was attempted before the failure (conversation context summary) */
  contextSummary?: string;
  /** Files that were being created or modified */
  affectedFiles?: string[];
  /** Any additional notes from the user */
  userNotes?: string;
  /** Who reported (email, name) \u2014 from OAuth */
  reporter?: { email: string; name: string };
}

export interface BugReportOutput {
  title: string;
  body: string;
}

export const formatBugReport = defineSkill<BugReportInput, BugReportOutput>(
  {
    name: "github_format_bug_report",
    description:
      "Formats a structured GitHub issue from Builder error context. Use when a skill/agent creation fails or a user reports a bug in ai-hub. Claude provides the conversation context \u2014 the skill structures it into a reproducible bug report.",
    service: "github",
    gather: [
      "Conversation context: what the user was trying to do, which step failed",
      "Error messages and stack traces from tool calls or build output",
      "List of files that were being created or modified",
      "Any user comments about what went wrong",
    ],
  },
  async (input) => {
    if (!input.userGoal || typeof input.userGoal !== "string") {
      throw new Error('Missing required field "userGoal" (string): what the user was trying to do');
    }
    if (!input.errorDetails || typeof input.errorDetails !== "string") {
      throw new Error('Missing required field "errorDetails" (string): error messages or stack traces');
    }
    const title = buildTitle(input);
    const body = buildBody(input);
    return { title, body };
  },
);

function buildTitle(input: BugReportInput): string {
  const step = input.failedStep ? `[${input.failedStep}] ` : "";
  const goal = input.userGoal.length > 60
    ? input.userGoal.slice(0, 57) + "..."
    : input.userGoal;
  return `Bug: ${step}${goal}`;
}

function buildBody(input: BugReportInput): string {
  const sections: string[] = [];

  sections.push(`## What the user was trying to do\n\n${input.userGoal}`);

  if (input.failedStep) {
    sections.push(`## Failed step\n\n${input.failedStep}`);
  }

  sections.push(`## Error details\n\n\`\`\`\n${input.errorDetails}\n\`\`\``);

  if (input.contextSummary) {
    sections.push(`## Context\n\n${input.contextSummary}`);
  }

  if (input.affectedFiles?.length) {
    const fileList = input.affectedFiles.map((f) => `- \`${f}\``).join("\n");
    sections.push(`## Affected files\n\n${fileList}`);
  }

  if (input.userNotes) {
    sections.push(`## User notes\n\n${input.userNotes}`);
  }

  const reporter = input.reporter
    ? `${input.reporter.name} (${input.reporter.email})`
    : "unknown";
  sections.push(`---\n_Reported by ${reporter} via ai-hub-bug-report_`);

  return sections.join("\n\n");
}