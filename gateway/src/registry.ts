export interface ServiceEntry {
  name: string;
  binding: string;
  description: string;
  skills: string[];
  agents: string[];
}

export const services: Record<string, ServiceEntry> = {
  "skill-runner": {
    name: "Skill Runner",
    binding: "SKILL_RUNNER",
    description: "Universal MCP server that auto-exposes all registered skills as tools",
    skills: [],
    agents: [],
  },
  "agent-runner": {
    name: "Agent Runner",
    binding: "AGENT_RUNNER",
    description: "Executes actions that call external APIs with Vault secrets. Supports MCP (interactive) and HTTP triggers (webhooks).",
    skills: [],
    agents: [],
  },
};
