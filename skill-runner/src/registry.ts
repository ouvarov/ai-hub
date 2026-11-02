import type { Skill, Agent } from "@shared/types";

import { wordStats } from "@shared/skills/text/word-stats";

export const skills: Skill<any, any>[] = [
  wordStats,
];

export const agents: Agent<any, any>[] = [
];
