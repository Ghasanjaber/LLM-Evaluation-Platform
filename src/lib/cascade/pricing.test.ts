import { describe, expect, it } from "vitest";
import { PRICING, TIER_1_MODEL, TIER_2_MODEL } from "./config";
import { computeCost, isPriced } from "./pricing";

/**
 * Unit tests — cost arithmetic.
 *
 * Every figure the dashboard reports passes through computeCost, so an error
 * here is invisible and wrong rather than loud and wrong. The last two tests
 * are invariants about the tier configuration itself, not about the function.
 */

describe("computeCost", () => {
  it("charges input and output at their separate rates", () => {
    // gpt-4: $30/Mtok in, $60/Mtok out.
    const cost = computeCost("gpt-4", { tokens_in: 1_000_000, tokens_out: 0 });
    expect(cost).toBeCloseTo(30, 10);

    const outCost = computeCost("gpt-4", { tokens_in: 0, tokens_out: 1_000_000 });
    expect(outCost).toBeCloseTo(60, 10);
  });

  it("sums both sides", () => {
    const cost = computeCost("gpt-3.5-turbo", {
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.5 + 1.5, 10);
  });

  it("is zero for zero usage", () => {
    expect(computeCost("gpt-4", { tokens_in: 0, tokens_out: 0 })).toBe(0);
  });

  it("scales linearly", () => {
    const one = computeCost("gpt-4", { tokens_in: 100, tokens_out: 100 });
    const ten = computeCost("gpt-4", { tokens_in: 1000, tokens_out: 1000 });
    expect(ten).toBeCloseTo(one * 10, 12);
  });

  it("returns 0 for an unpriced model instead of throwing", () => {
    // Deliberate: a missing price must not fail a user's request. It does
    // understate cost, which is why isPriced exists for callers to check.
    expect(computeCost("some-unknown-model", { tokens_in: 1000, tokens_out: 1000 })).toBe(0);
    expect(isPriced("some-unknown-model")).toBe(false);
    expect(isPriced(TIER_1_MODEL)).toBe(true);
  });
});

describe("tier configuration invariants", () => {
  it("prices both configured tiers", () => {
    // An unpriced tier silently reports every request as free.
    expect(isPriced(TIER_1_MODEL)).toBe(true);
    expect(isPriced(TIER_2_MODEL)).toBe(true);
  });

  it("keeps Tier 1 strictly cheaper than Tier 2 on both sides", () => {
    // The whole premise of the cascade. If this inverts, the router raises cost.
    expect(PRICING[TIER_1_MODEL].in).toBeLessThan(PRICING[TIER_2_MODEL].in);
    expect(PRICING[TIER_1_MODEL].out).toBeLessThan(PRICING[TIER_2_MODEL].out);
  });
});
