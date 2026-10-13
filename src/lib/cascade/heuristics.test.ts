import { describe, expect, it } from "vitest";
import { classifyStage1 } from "./heuristics";
import { DENSE_PROMPT_ASKS, LONG_PROMPT_CHARS } from "./config";

/**
 * Unit tests — Stage 1 heuristics.
 *
 * These rules are the only part of the router that decides without a model, so
 * they are the cheapest place for a mistake to be expensive: a false "simple"
 * sends a hard prompt to the weak tier, and a false "complex" forfeits the
 * saving the router exists to capture. Both directions are asserted.
 */

describe("Stage 1: routes obviously complex prompts straight to Tier 2", () => {
  const cases: Array<[string, string, string]> = [
    ["fenced code", "```js\nconst a = 1;\n```", "code"],
    ["write-a-function", "Write a function that reverses a list", "code"],
    ["language keyword", "What does `import os` do at module load?", "code"],
    ["debugging ask", "Debug this: my SQL query returns duplicates", "code"],
    ["step-by-step", "Explain step by step how TLS works", "multi_step"],
    ["first/then", "First explain a mutex, then compare it to a spinlock", "multi_step"],
    ["show your work", "Show your work for this conversion", "multi_step"],
    ["arithmetic", "What is 847 * 236?", "math"],
    ["solve", "Solve for x: 3x + 7 = 28", "math"],
    ["prove", "Prove that the square root of 2 is irrational", "math"],
  ];

  for (const [label, prompt, signal] of cases) {
    it(`${label} -> direct_t2 (${signal})`, () => {
      const result = classifyStage1(prompt);
      expect(result.route).toBe("direct_t2");
      expect(result.signal).toBe(signal);
      // The matched text is kept so a misroute can be audited later.
      expect(result.matched).toBeTruthy();
    });
  }

  it("numbered sub-questions need at least two to count as multi-step", () => {
    expect(classifyStage1("1. What is a VLAN?").route).toBe("passed");
    expect(
      classifyStage1("1. What is a VLAN?\n2. How does trunking work?").route,
    ).toBe("direct_t2");
  });
});

describe("Stage 1: lets ordinary prompts through to the classifier", () => {
  const simple = [
    "What is the capital of Norway?",
    "Translate 'good evening' into Spanish.",
    "Who wrote Wuthering Heights?",
    "Give me a synonym for reluctant.",
    "What is the plural of analysis?",
  ];

  for (const prompt of simple) {
    it(`passes: ${prompt.slice(0, 38)}`, () => {
      const result = classifyStage1(prompt);
      expect(result.route).toBe("passed");
      expect(result.signal).toBe("none");
    });
  }
});

describe("Stage 1: flags shape without deciding on it", () => {
  it("marks an over-long prompt long_or_dense but still passes it on", () => {
    const result = classifyStage1("filler ".repeat(LONG_PROMPT_CHARS));
    // The point of this branch: length is a hint for the classifier, never a
    // route on its own. Deciding here would bill Tier 2 for a long easy prompt.
    expect(result.route).toBe("passed");
    expect(result.signal).toBe("long_or_dense");
  });

  it("marks a prompt with many distinct asks as dense", () => {
    const prompt = Array.from(
      { length: DENSE_PROMPT_ASKS },
      (_, i) => `Question ${i}?`,
    ).join(" ");
    expect(classifyStage1(prompt).signal).toBe("long_or_dense");
  });

  it("does not flag a single short question as dense", () => {
    expect(classifyStage1("What is the capital of Peru?").signal).toBe("none");
  });
});

describe("Stage 1: degenerate input", () => {
  it("handles an empty prompt without throwing", () => {
    expect(classifyStage1("").route).toBe("passed");
  });

  it("is case-insensitive on word rules", () => {
    expect(classifyStage1("SOLVE FOR X").route).toBe("direct_t2");
    expect(classifyStage1("solve for x").route).toBe("direct_t2");
  });
});
