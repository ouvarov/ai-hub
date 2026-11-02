import { defineSkill } from "@shared/types";

const WORDS_PER_MINUTE = 200;

export type WordStatsInput = {
  text: string;
};

export type WordStatsOutput = {
  words: number;
  sentences: number;
  readingTimeMinutes: number;
};

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
