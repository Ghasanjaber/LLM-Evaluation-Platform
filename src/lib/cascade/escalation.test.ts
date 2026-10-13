import { describe, expect, it, vi } from "vitest";
import { LOGPROB_THRESHOLD, SELF_CONSISTENCY_THRESHOLD } from "./config";
import { evaluateEscalation, failsSchema, similarity } from "./escalation";
import type { ModelCall } from "./types";

/**
 * Unit + behavioural tests — the escalation gate.
 *
 * Two different things are checked here. The signal functions are pure and
 * tested as such. The gate itself is tested for *ordering*: free signals must
 * settle the decision before the paid one runs, because self-consistency costs
 * a second Tier 1 call. That ordering is a cost property, invisible in output,
 * so it is asserted with a spy on the resample function.
 */

function call(overrides: Partial<ModelCall> = {}): ModelCall {
  return {
    model: "gpt-3.5-turbo",
    text: "Oslo",
    usage: { tokens_in: 10, tokens_out: 5 },
    mean_logprob: -0.2,
    latency_ms: 100,
    cost_usd: 0.0001,
    ...overrides,
  };
}

/** A resample that must not be reached; calling it fails the test. */
const forbiddenResample = vi.fn(async () => {
  throw new Error("resample must not be called on a free-signal decision");
});

describe("failsSchema — JSON", () => {
  it("accepts valid JSON", () => {
    expect(failsSchema('{"a":1}', { type: "json" })).toBe(false);
  });

  it("rejects unparseable output", () => {
    expect(failsSchema("Sure! Here you go: a=1", { type: "json" })).toBe(true);
  });

  it("accepts JSON wrapped in a code fence, which models often add", () => {
    expect(failsSchema('```json\n{"a":1}\n```', { type: "json" })).toBe(false);
    expect(failsSchema('```\n{"a":1}\n```', { type: "json" })).toBe(false);
  });

  it("rejects a missing required field", () => {
    expect(failsSchema('{"city":"Oslo"}', { type: "json", required: ["city", "country"] })).toBe(true);
  });

  it("accepts when all required fields are present", () => {
    expect(
      failsSchema('{"city":"Oslo","country":"Norway"}', {
        type: "json",
        required: ["city", "country"],
      }),
    ).toBe(false);
  });

  it("rejects valid JSON that is not an object when fields are required", () => {
    expect(failsSchema("[1,2,3]", { type: "json", required: ["a"] })).toBe(true);
    expect(failsSchema("null", { type: "json", required: ["a"] })).toBe(true);
  });
});

describe("failsSchema — regex", () => {
  it("accepts a match and rejects a miss", () => {
    const schema = { type: "regex" as const, pattern: "^ID-\\d+$" };
    expect(failsSchema("ID-4821", schema)).toBe(false);
    expect(failsSchema("nope", schema)).toBe(true);
  });

  it("does not escalate on a malformed pattern", () => {
    // A bad pattern is a config bug, not a model failure. Escalating would
    // bill Tier 2 for every request until someone noticed.
    expect(failsSchema("anything", { type: "regex", pattern: "([unclosed" })).toBe(false);
  });
});

describe("similarity", () => {
  it("is 1 for identical text and for two empty strings", () => {
    expect(similarity("the sky is blue", "the sky is blue")).toBe(1);
    expect(similarity("", "")).toBe(1);
  });

  it("is 0 when only one side is empty", () => {
    expect(similarity("something", "")).toBe(0);
  });

  it("is low for disjoint answers", () => {
    expect(similarity("yes absolutely", "no never")).toBeLessThan(SELF_CONSISTENCY_THRESHOLD);
  });

  it("ignores word order and case", () => {
    expect(similarity("Oslo is the capital", "the capital is oslo")).toBe(1);
  });
});

describe("the gate: free signals decide before the paid one runs", () => {
  it("escalates on schema failure without resampling", async () => {
    const decision = await evaluateEscalation({
      call: call({ text: "not json" }),
      schema: { type: "json" },
      resample: forbiddenResample,
    });

    expect(decision).toMatchObject({ escalate: true, reason: "schema_fail" });
    expect(decision.extra_calls).toHaveLength(0);
    expect(forbiddenResample).not.toHaveBeenCalled();
  });

  it("escalates on a low logprob without resampling", async () => {
    const decision = await evaluateEscalation({
      call: call({ mean_logprob: LOGPROB_THRESHOLD - 0.5 }),
      resample: forbiddenResample,
    });

    expect(decision).toMatchObject({ escalate: true, reason: "logprob_low" });
    expect(forbiddenResample).not.toHaveBeenCalled();
  });

  it("keeps the answer on a healthy logprob, and skips the paid signal", async () => {
    const decision = await evaluateEscalation({
      call: call({ mean_logprob: -0.1 }),
      resample: forbiddenResample,
    });

    expect(decision).toMatchObject({ escalate: false, reason: null });
    expect(decision.extra_calls).toHaveLength(0);
    expect(forbiddenResample).not.toHaveBeenCalled();
  });

  it("treats an empty answer as a format failure even with no schema", async () => {
    const decision = await evaluateEscalation({
      call: call({ text: "   " }),
      resample: forbiddenResample,
    });

    expect(decision).toMatchObject({ escalate: true, reason: "schema_fail" });
    expect(forbiddenResample).not.toHaveBeenCalled();
  });
});

describe("the gate: self-consistency is the fallback when logprobs are absent", () => {
  it("resamples and keeps the answer when the samples agree", async () => {
    const resample = vi.fn(async () => call({ text: "Oslo", mean_logprob: null }));

    const decision = await evaluateEscalation({
      call: call({ text: "Oslo", mean_logprob: null }),
      resample,
    });

    expect(resample).toHaveBeenCalledTimes(1);
    expect(decision.escalate).toBe(false);
    // The extra call is reported so the router can bill it.
    expect(decision.extra_calls).toHaveLength(1);
  });

  it("escalates when two samples materially disagree", async () => {
    const resample = vi.fn(async () =>
      call({ text: "completely different wording entirely", mean_logprob: null }),
    );

    const decision = await evaluateEscalation({
      call: call({ text: "Oslo is the capital of Norway", mean_logprob: null }),
      resample,
    });

    expect(decision).toMatchObject({ escalate: true, reason: "inconsistent" });
    expect(decision.extra_calls).toHaveLength(1);
  });

  it("resamples at a non-zero temperature, or the check is meaningless", async () => {
    // Sampling twice at temperature 0 would return the same text and the
    // signal would never fire. The parameter is declared so the asserted
    // argument is type-checked, not just present at runtime.
    const temperatures: number[] = [];
    const resample = vi.fn(async (temperature: number) => {
      temperatures.push(temperature);
      return call({ mean_logprob: null });
    });
    await evaluateEscalation({ call: call({ mean_logprob: null }), resample });

    expect(resample).toHaveBeenCalledTimes(1);
    expect(temperatures[0]).toBeGreaterThan(0);
  });

  it("escalates when the resample itself fails", async () => {
    // Consistency cannot be assessed, so take the safer of the two wrong moves.
    const decision = await evaluateEscalation({
      call: call({ mean_logprob: null }),
      resample: async () => {
        throw new Error("upstream 500");
      },
    });

    expect(decision).toMatchObject({ escalate: true, reason: "inconsistent" });
    expect(decision.extra_calls).toHaveLength(0);
  });
});
