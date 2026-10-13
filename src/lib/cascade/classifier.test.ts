import { describe, expect, it } from "vitest";
import { CLASSIFIER_COMPLEX_THRESHOLD } from "./config";
import { classifierStatus, classifyStage2, scoreWith } from "./classifier";
import { hashingEmbedder } from "./embedding";
import type { ClassifierWeights } from "./classifier";

/**
 * Unit tests — Stage 2.
 *
 * The behaviour that matters most is the failure mode: with no usable weights
 * the classifier must report cold start so the router can apply its
 * conservative default (Tier 2). Silently scoring with garbage weights would
 * route real traffic on noise.
 */

function weights(overrides: Partial<ClassifierWeights> = {}): ClassifierWeights {
  return {
    embedder_id: hashingEmbedder.id,
    weights: new Array(hashingEmbedder.dim).fill(0),
    bias: 0,
    trained_at: "2026-10-13T00:00:00.000Z",
    training_examples: 119,
    holdout_accuracy: 0.867,
    ...overrides,
  };
}

describe("scoreWith", () => {
  it("returns 0.5 at a zero decision boundary", () => {
    const score = scoreWith(weights(), hashingEmbedder.embed("anything"));
    expect(score).toBeCloseTo(0.5, 10);
  });

  it("stays inside [0,1] for extreme inputs", () => {
    // Guards the sigmoid against overflow, which would yield NaN and make
    // every comparison against the threshold false.
    for (const bias of [1e6, -1e6, 0]) {
      const score = scoreWith(weights({ bias }), hashingEmbedder.embed("test"));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(Number.isNaN(score)).toBe(false);
    }
  });

  it("moves monotonically with the bias", () => {
    const vector = hashingEmbedder.embed("a prompt");
    expect(scoreWith(weights({ bias: 2 }), vector)).toBeGreaterThan(
      scoreWith(weights({ bias: -2 }), vector),
    );
  });
});

describe("the shipped classifier", () => {
  it("is trained, and reports its provenance", async () => {
    // If this fails, run `npm run train:classifier`. An untrained classifier
    // is a valid state, but it sends all traffic to Tier 2.
    const status = await classifierStatus();
    expect(status.trained).toBe(true);

    if (status.trained) {
      expect(status.embedder_id).toBe(hashingEmbedder.id);
      expect(status.holdout_accuracy).toBeGreaterThan(0.8);
      expect(status.training_examples).toBeGreaterThan(100);
      expect(() => new Date(status.trained_at).toISOString()).not.toThrow();
    }
  });

  it("separates a clearly simple prompt from a clearly complex one", async () => {
    const simple = await classifyStage2("What is the capital of Norway?");
    const complex = await classifyStage2(
      "Compare the trade-offs between eventual and strong consistency for a payments ledger.",
    );

    expect(simple.route).toBe("simple");
    expect(complex.route).toBe("complex");
    expect(simple.score).toBeLessThan(CLASSIFIER_COMPLEX_THRESHOLD);
    expect(complex.score).toBeGreaterThanOrEqual(CLASSIFIER_COMPLEX_THRESHOLD);
  });

  it("is deterministic — the same prompt always routes the same way", async () => {
    const a = await classifyStage2("What is the capital of Peru?");
    const b = await classifyStage2("What is the capital of Peru?");
    expect(a.score).toBe(b.score);
    expect(a.route).toBe(b.route);
  });

  it("reports the time it spent, for the observability pipeline", async () => {
    const result = await classifyStage2("What is the capital of Chile?");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.latency_ms).toBeLessThan(100);
  });

  it("handles an empty prompt without throwing", async () => {
    const result = await classifyStage2("");
    expect(["simple", "complex"]).toContain(result.route);
  });
});
