import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests — the router end to end, with the provider layer mocked.
 *
 * These cover the wiring the unit tests cannot: that a routing decision leads
 * to the right call being made, that a request is billed for every call it
 * actually caused, and that one log row is written on every path. No network
 * is touched — a test that reaches a provider is a failing test.
 *
 * The logger is mocked too, so the suite neither reads nor writes .data/.
 */

const callModel = vi.fn();
const logRequest = vi.fn();

vi.mock("../providers", () => ({
  callModel: (...args: unknown[]) => callModel(...args),
  supportsLogprobs: (model: string) => model.startsWith("gpt-"),
  MODEL_PROVIDERS: { "gpt-3.5-turbo": "openai", "gpt-4": "openai" },
}));

vi.mock("./logger", () => ({
  logRequest: (...args: unknown[]) => logRequest(...args),
  readRequestLog: async () => [],
}));

const { route } = await import("./router");
const { TIER_1_MODEL, TIER_2_MODEL } = await import("./config");

/** A successful call from whichever model was asked for. */
function reply(text: string, logprob: number | null, costPerCall = 0.001) {
  return async (options: { model: string }) => ({
    model: options.model,
    text,
    usage: { tokens_in: 10, tokens_out: 20 },
    mean_logprob: logprob,
    latency_ms: 50,
    cost_usd: options.model === TIER_2_MODEL ? costPerCall * 50 : costPerCall,
  });
}

/** Never fires the shadow sample. */
const noShadow = { random: () => 0.99 };
/** Always fires it. */
const alwaysShadow = { random: () => 0.0 };

beforeEach(() => {
  callModel.mockReset();
  logRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stage 1 sends obviously complex prompts straight to Tier 2", () => {
  it("never calls Tier 1 for a code prompt", async () => {
    callModel.mockImplementation(reply("here is a function", -0.1));

    const result = await route(
      { prompt: "Write a function that reverses a list" },
      noShadow,
    );

    expect(result.tier_called).toBe(2);
    expect(result.stage1_route).toBe("direct_t2");
    // Stage 2 must not have run; Stage 1 already decided.
    expect(result.stage2_route).toBeNull();
    expect(result.escalated).toBe(false);

    // The point of pre-routing: exactly one call, and not to the small model.
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].model).toBe(TIER_2_MODEL);
  });
});

describe("the fast path", () => {
  it("answers from Tier 1 and bills one call", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));

    const result = await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(result.tier_called).toBe(1);
    expect(result.stage2_route).toBe("simple");
    expect(result.escalated).toBe(false);
    expect(result.response_text).toBe("Oslo");

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0][0].model).toBe(TIER_1_MODEL);
    expect(result.cost_usd).toBeCloseTo(0.001, 10);
  });

  it("asks for logprobs on Tier 1, since that signal is free", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));
    await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(callModel.mock.calls[0][0].wantLogprobs).toBe(true);
  });
});

describe("escalation", () => {
  it("falls through to Tier 2 on a low logprob and bills both calls", async () => {
    callModel.mockImplementation(reply("unsure", -5.0));

    const result = await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(result.tier_called).toBe(2);
    expect(result.escalated).toBe(true);
    expect(result.escalation_reason).toBe("logprob_low");

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[0][0].model).toBe(TIER_1_MODEL);
    expect(callModel.mock.calls[1][0].model).toBe(TIER_2_MODEL);

    // Billed for the wasted Tier 1 call as well as the Tier 2 one. Charging
    // only for the answer returned would understate the cost of escalating.
    expect(result.cost_usd).toBeCloseTo(0.001 + 0.05, 10);
  });

  it("escalates a schema failure and returns the Tier 2 answer", async () => {
    callModel.mockImplementation(async (options: { model: string }) => ({
      model: options.model,
      text: options.model === TIER_1_MODEL ? "Sorry, here you go!" : '{"city":"Oslo"}',
      usage: { tokens_in: 10, tokens_out: 20 },
      mean_logprob: -0.1,
      latency_ms: 50,
      cost_usd: 0.001,
    }));

    const result = await route(
      { prompt: "Give me the capital of Norway as JSON", schema: { type: "json" } },
      noShadow,
    );

    expect(result.escalation_reason).toBe("schema_fail");
    expect(result.response_text).toBe('{"city":"Oslo"}');
  });
});

describe("shadow sampling", () => {
  it("makes an extra Tier 2 call and records the baseline", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));

    await route({ prompt: "What is the capital of Norway?" }, alwaysShadow);

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].model).toBe(TIER_2_MODEL);

    const row = logRequest.mock.calls[0][0];
    expect(row.tier_called).toBe(1); // the shadow call did not change the answer
    expect(row.baseline_cost_usd).toBeCloseTo(0.05, 10);
  });

  it("does not bill the shadow call to the request", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));
    await route({ prompt: "What is the capital of Norway?" }, alwaysShadow);

    const row = logRequest.mock.calls[0][0];
    // Routed cost is the fast path only; the shadow call is baseline data, and
    // counting it as routed spend would make the router look more expensive.
    expect(row.cost_usd).toBeCloseTo(0.001, 10);
  });

  it("leaves the baseline null when not sampled", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));
    await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(logRequest.mock.calls[0][0].baseline_cost_usd).toBeNull();
  });

  it("still answers when the shadow call fails", async () => {
    // Baseline collection must never break a user's request.
    callModel.mockImplementation(async (options: { model: string }) => {
      if (options.model === TIER_2_MODEL) throw new Error("upstream 500");
      return {
        model: options.model,
        text: "Oslo",
        usage: { tokens_in: 10, tokens_out: 20 },
        mean_logprob: -0.1,
        latency_ms: 50,
        cost_usd: 0.001,
      };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await route({ prompt: "What is the capital of Norway?" }, alwaysShadow);

    expect(result.response_text).toBe("Oslo");
    expect(logRequest.mock.calls[0][0].baseline_cost_usd).toBeNull();
  });
});

describe("the request log", () => {
  it("writes exactly one row per request on every path", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));

    await route({ prompt: "What is the capital of Norway?" }, noShadow);
    expect(logRequest).toHaveBeenCalledTimes(1);

    logRequest.mockReset();
    callModel.mockImplementation(reply("code", -0.1));
    await route({ prompt: "Write a function to sort a list" }, noShadow);
    expect(logRequest).toHaveBeenCalledTimes(1);
  });

  it("writes every field in the documented schema", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));
    await route({ prompt: "What is the capital of Norway?" }, noShadow);

    // Contract check against docs/architecture/cascade-router.md appendix 10.
    // A field renamed here silently breaks the dashboard and the doc at once.
    expect(Object.keys(logRequest.mock.calls[0][0]).sort()).toEqual(
      [
        "baseline_cost_usd",
        "cost_usd",
        "escalated",
        "escalation_reason",
        "latency_ms",
        "request_id",
        "schema_repaired",
        "stage1_route",
        "stage2_route",
        "timestamp",
        "tier_called",
        "tokens_in",
        "tokens_out",
      ].sort(),
    );
  });

  it("gives each request a distinct id", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));

    await route({ prompt: "What is the capital of Norway?" }, noShadow);
    await route({ prompt: "What is the capital of Peru?" }, noShadow);

    const [first, second] = logRequest.mock.calls.map((c) => c[0].request_id);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reports an integer latency", async () => {
    callModel.mockImplementation(reply("Oslo", -0.1));
    await route({ prompt: "What is the capital of Norway?" }, noShadow);

    const { latency_ms } = logRequest.mock.calls[0][0];
    expect(Number.isInteger(latency_ms)).toBe(true);
  });
});

describe("failure propagation", () => {
  it("lets a Tier 1 failure surface rather than returning a wrong answer", async () => {
    callModel.mockImplementation(async () => {
      throw new Error("OPENAI_API_KEY is not set in .env.local");
    });

    await expect(
      route({ prompt: "What is the capital of Norway?" }, noShadow),
    ).rejects.toThrow("OPENAI_API_KEY");

    // Nothing is logged for a request that never produced an answer.
    expect(logRequest).not.toHaveBeenCalled();
  });
});
