import { describe, expect, it } from "vitest";
import corpus from "./testing/corpus.json";
import { classifyStage2 } from "./classifier";
import { classifyStage1 } from "./heuristics";

/**
 * Golden-output tests — routing decisions over the whole 60-prompt corpus.
 *
 * The unit tests check rules in isolation. These check the *aggregate* the
 * router actually produces, which is what determines cost. They need no API key
 * and no network: Stage 1 and Stage 2 are both local by design.
 *
 * KNOWN_MISROUTES below is the important part. The classifier gets five prompts
 * wrong, and the pattern is diagnosable rather than random: every complex
 * example in the training set opens with an imperative (Compare, Assess,
 * Evaluate, Discuss), so the model learned "imperative verb => complex" and
 * trips on "Return", "List" and "Fix". Holdout accuracy of 86.7% did not
 * surface this; running the corpus did.
 *
 * Listing them here rather than relabelling the corpus means the suite fails on
 * a NEW misroute (a regression) and also fails when one is FIXED (so the list
 * and the training data stay honest about each other).
 */

type Path = "tier1" | "tier2_direct" | "tier2_classified";

interface Prompt {
  text: string;
  expect: Path;
  schema?: { type: "json"; required?: string[] };
}

const prompts = corpus.prompts as Prompt[];

/** Prompts the Stage 2 classifier currently routes against intent. */
const KNOWN_MISROUTES: Record<string, { actual: Path; cause: string }> = {
  "Fix the grammar: he dont have no time.": {
    actual: "tier2_classified",
    cause: "leading imperative 'Fix' reads as complex",
  },
  "Who was the first woman to win a Nobel Prize?": {
    actual: "tier2_classified",
    cause: "hash collision; no clear lexical cause",
  },
  "Return the three primary colours as JSON with a key named colours.": {
    actual: "tier2_classified",
    cause: "leading imperative 'Return' reads as complex",
  },
  "Return JSON with keys country and continent for Peru.": {
    actual: "tier2_classified",
    cause: "leading imperative 'Return' reads as complex",
  },
  "List two Scandinavian languages as JSON under a key called languages.": {
    actual: "tier2_classified",
    cause: "leading imperative 'List' reads as complex",
  },
};

async function routeOf(prompt: Prompt): Promise<Path> {
  if (classifyStage1(prompt.text).route === "direct_t2") return "tier2_direct";
  const stage2 = await classifyStage2(prompt.text);
  return stage2.route === "simple" ? "tier1" : "tier2_classified";
}

describe("corpus integrity", () => {
  it("has 60 prompts covering all three paths", () => {
    expect(prompts).toHaveLength(60);
    const paths = new Set(prompts.map((p) => p.expect));
    expect(paths).toEqual(new Set(["tier1", "tier2_direct", "tier2_classified"]));
  });

  it("keeps Stage-1-catchable prompts out of the Stage 2 label set", () => {
    // Stage 2 only ever scores prompts that passed Stage 1. A prompt labelled
    // tier2_classified that Stage 1 would catch is a mislabelled example.
    for (const p of prompts.filter((p) => p.expect === "tier2_classified")) {
      expect(classifyStage1(p.text).route, p.text).toBe("passed");
    }
  });
});

describe("Stage 1 is exact on the corpus", () => {
  it("catches every prompt labelled tier2_direct and no others", async () => {
    const caught = prompts
      .filter((p) => classifyStage1(p.text).route === "direct_t2")
      .map((p) => p.text);
    const intended = prompts
      .filter((p) => p.expect === "tier2_direct")
      .map((p) => p.text);

    // Heuristics are hand-written, so both over- and under-matching are live
    // risks. Asserting set equality catches drift in either direction.
    expect(caught.sort()).toEqual(intended.sort());
  });
});

describe("Stage 2 routing, against intent", () => {
  it("misroutes exactly the known set — no more, no fewer", async () => {
    const misrouted: Record<string, Path> = {};

    for (const prompt of prompts) {
      const actual = await routeOf(prompt);
      if (actual !== prompt.expect) misrouted[prompt.text] = actual;
    }

    const expected = Object.fromEntries(
      Object.entries(KNOWN_MISROUTES).map(([text, v]) => [text, v.actual]),
    );

    expect(misrouted).toEqual(expected);
  });

  it("is correct on every prompt outside the known set", async () => {
    for (const prompt of prompts) {
      if (prompt.text in KNOWN_MISROUTES) continue;
      expect(await routeOf(prompt), prompt.text).toBe(prompt.expect);
    }
  });
});

describe("the distribution the router actually produces", () => {
  it("matches the committed golden snapshot", async () => {
    const tally = { tier1: 0, tier2_direct: 0, tier2_classified: 0 };
    for (const prompt of prompts) tally[await routeOf(prompt)]++;

    // Cost follows directly from these three numbers, so they are pinned.
    // A change here means the savings projection changed too.
    expect(tally).toEqual({
      tier1: 31,
      tier2_direct: 15,
      tier2_classified: 14,
    });
  });

  it("still sends a majority to the fast path", async () => {
    let fast = 0;
    for (const prompt of prompts) if ((await routeOf(prompt)) === "tier1") fast++;

    // If this drops below half, the router has stopped earning its complexity.
    expect(fast / prompts.length).toBeGreaterThan(0.5);
  });
});

describe("Stage 2 performance budget", () => {
  it("scores the whole corpus well inside its latency allowance", async () => {
    const eligible = prompts.filter(
      (p) => classifyStage1(p.text).route === "passed",
    );

    const started = performance.now();
    for (const prompt of eligible) await classifyStage2(prompt.text);
    const perPrompt = (performance.now() - started) / eligible.length;

    // The design doc budgets 10-30ms for local embedding + scoring. Generous
    // ceiling here so the test does not flake on a loaded CI machine, but it
    // would still catch a network call sneaking into the pre-query path.
    expect(perPrompt).toBeLessThan(10);
  });
});
