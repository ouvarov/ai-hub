import { describe, expect, it } from "vitest";
import { wordStats } from "@shared/skills/text/word-stats";

describe("text_word_stats", () => {
  it("counts words and sentences and rounds reading time up", async () => {
    await expect(wordStats.execute({ text: "One two. Three four five!" })).resolves.toEqual({
      words: 5,
      sentences: 2,
      readingTimeMinutes: 1,
    });
  });

  it("returns zeros for blank text", async () => {
    await expect(wordStats.execute({ text: "   " })).resolves.toEqual({
      words: 0,
      sentences: 0,
      readingTimeMinutes: 0,
    });
  });
});
