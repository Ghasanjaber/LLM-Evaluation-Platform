import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, hashingEmbedder, tokenize } from "./embedding";

/**
 * Unit tests — the local embedder.
 *
 * The trained classifier weights are bound to this embedder's exact output, so
 * any silent change here invalidates the model without failing a build. These
 * tests exist mainly to make that coupling loud: determinism and the stable
 * `id` are the contract, not implementation details.
 */

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello   World")).toEqual(["hello", "world"]);
  });

  it("drops punctuation it does not carry", () => {
    expect(tokenize("a,b;c")).toEqual(["a", "b", "c"]);
  });

  it("keeps question marks, which carry prompt shape", () => {
    expect(tokenize("why?")).toEqual(["why?"]);
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n ")).toEqual([]);
  });
});

describe("hashingEmbedder", () => {
  it("produces the configured dimension", () => {
    expect(hashingEmbedder.embed("anything").length).toBe(EMBEDDING_DIM);
    expect(hashingEmbedder.dim).toBe(EMBEDDING_DIM);
  });

  it("is deterministic across calls", () => {
    const a = hashingEmbedder.embed("the capital of Norway");
    const b = hashingEmbedder.embed("the capital of Norway");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("L2-normalises, so prompt length does not dominate the score", () => {
    const vector = hashingEmbedder.embed("a moderately long sentence here");
    const norm = Math.sqrt(
      Array.from(vector).reduce((sum, value) => sum + value * value, 0),
    );
    expect(norm).toBeCloseTo(1, 10);
  });

  it("returns an all-zero vector for empty input rather than NaN", () => {
    // Guards a divide-by-zero in the normalisation step. NaNs here would
    // propagate silently into the classifier score.
    const vector = hashingEmbedder.embed("");
    expect(Array.from(vector).every((value) => value === 0)).toBe(true);
  });

  it("separates different text", () => {
    const a = hashingEmbedder.embed("what is the capital of Norway");
    const b = hashingEmbedder.embed("compare optimistic and pessimistic locking");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it("exposes a stable id, which the weights are checked against", () => {
    // If this string changes, previously trained weights must be regenerated;
    // classifier.ts refuses to use mismatched weights.
    expect(hashingEmbedder.id).toBe("hashing-fnv1a-uni+bi-d512");
  });
});
