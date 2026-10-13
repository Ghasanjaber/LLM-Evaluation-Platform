import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests — schema repair, with the provider layer mocked.
 *
 * MOCKED, not live. These encode the behaviour change motivated by a live
 * finding (8 of 8 escalations were schema_fail, and Tier 2 did not reliably
 * produce conforming output). They verify the new control flow; they do not
 * verify that any real model obeys a repair instruction.
 */

const callModel = vi.fn();
const logRequest = vi.fn();

vi.mock("../providers", () => ({
  callModel: (...args: unknown[]) => callModel(...args),
  supportsLogprobs: (model: string) => model.startsWith("gpt-"),
  supportsJsonMode: (model: string) => /^gpt-4(o|\.1)/.test(model),
  MODEL_PROVIDERS: { "gpt-4o-mini": "openai", "gpt-4o": "openai" },
}));

vi.mock("./logger", () => ({
  logRequest: (...args: unknown[]) => logRequest(...args),
  readRequestLog: async () => [],
}));

const { route } = await import("./router");
const { TIER_1_MODEL, TIER_2_MODEL, SCHEMA_REPAIR_ATTEMPTS } = await import("./config");

const noShadow = { random: () => 0.99 };

interface Reply {
  text: string;
  cost?: number;
}

/** Queues scripted replies in call order, so each attempt can differ. */
function script(...replies: Reply[]) {
  let i = 0;
  callModel.mockImplementation(async (options: { model: string }) => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return {
      model: options.model,
      text: reply.text,
      usage: { tokens_in: 10, tokens_out: 20 },
      mean_logprob: -0.1,
      latency_ms: 50,
      cost_usd: reply.cost ?? (options.model === TIER_2_MODEL ? 0.05 : 0.001),
    };
  });
}

const jsonSchema = { type: "json" as const, required: ["city"] };

beforeEach(() => {
  callModel.mockReset();
  logRequest.mockReset();
});

describe("repair is attempted before escalating a format failure", () => {
  it("retries Tier 1 with the constraint restated, and avoids Tier 2 on success", async () => {
    script({ text: "Sure! The city is Oslo." }, { text: '{"city":"Oslo"}' });

    const result = await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    expect(result.schema_repaired).toBe(true);
    expect(result.tier_called).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.response_text).toBe('{"city":"Oslo"}');

    // Two Tier 1 calls, and crucially no Tier 2 call at all.
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls.map((c) => c[0].model)).toEqual([
      TIER_1_MODEL,
      TIER_1_MODEL,
    ]);
  });

  it("sends the schema constraint and JSON mode on the repair attempt", async () => {
    script({ text: "prose" }, { text: '{"city":"Oslo"}' });

    await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    const repair = callModel.mock.calls[1][0];
    expect(repair.jsonMode).toBe(true);
    expect(repair.systemInstruction).toContain("city");
    // Temperature 0: a formatting correction, not a resample.
    expect(repair.temperature).toBe(0);
  });

  it("uses instruction only, without JSON mode, for a regex schema", async () => {
    script({ text: "The code is NO." }, { text: "NO" });

    // Prompt must be one Stage 2 routes to Tier 1, or repair never runs.
    const result = await route(
      {
        prompt: "What is the capital of Norway?",
        schema: { type: "regex", pattern: "^[A-Z]{2}$" },
      },
      noShadow,
    );

    expect(result.schema_repaired).toBe(true);
    const repair = callModel.mock.calls[1][0];
    expect(repair.jsonMode).toBe(false);
    expect(repair.systemInstruction).toContain("^[A-Z]{2}$");
  });

  it("bills every call the repair caused", async () => {
    script(
      { text: "prose", cost: 0.001 },
      { text: '{"city":"Oslo"}', cost: 0.002 },
    );

    const result = await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    // Charging only for the returned answer would hide the repair's cost.
    expect(result.cost_usd).toBeCloseTo(0.003, 10);
  });
});

describe("repair failure still escalates", () => {
  it("falls through to Tier 2 when the retry also misses the schema", async () => {
    script({ text: "prose" }, { text: "still prose" }, { text: '{"city":"Oslo"}' });

    const result = await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    expect(result.schema_repaired).toBe(false);
    expect(result.escalated).toBe(true);
    expect(result.escalation_reason).toBe("schema_fail");
    expect(result.tier_called).toBe(2);

    const models = callModel.mock.calls.map((c) => c[0].model);
    expect(models).toEqual([TIER_1_MODEL, TIER_1_MODEL, TIER_2_MODEL]);
  });

  it("escalates rather than losing the request when the repair call throws", async () => {
    let call = 0;
    callModel.mockImplementation(async (options: { model: string }) => {
      call += 1;
      if (call === 2) throw new Error("upstream 500");
      return {
        model: options.model,
        text: call === 1 ? "prose" : '{"city":"Oslo"}',
        usage: { tokens_in: 10, tokens_out: 20 },
        mean_logprob: -0.1,
        latency_ms: 50,
        cost_usd: 0.001,
      };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    expect(result.escalated).toBe(true);
    expect(result.tier_called).toBe(2);
    expect(result.schema_repaired).toBe(false);
  });

  it("is bounded — never more repair attempts than configured", async () => {
    script({ text: "prose" });

    await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    // 1 initial Tier 1 + N repairs + 1 Tier 2.
    expect(callModel).toHaveBeenCalledTimes(2 + SCHEMA_REPAIR_ATTEMPTS);
  });
});

describe("repair does not fire where it does not apply", () => {
  it("is not attempted when no schema was declared", async () => {
    // An empty answer trips schema_fail without a schema; there is no
    // constraint to restate, so repair must be skipped.
    script({ text: "   " }, { text: "Oslo" });

    const result = await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(result.schema_repaired).toBeNull();
    expect(result.escalated).toBe(true);
    expect(callModel.mock.calls.map((c) => c[0].model)).toEqual([
      TIER_1_MODEL,
      TIER_2_MODEL,
    ]);
  });

  it("is not attempted on a logprob escalation", async () => {
    // Low confidence is a capability signal; a bigger model is the right
    // remedy there, unlike a formatting miss.
    callModel.mockImplementation(async (options: { model: string }) => ({
      model: options.model,
      text: "unsure",
      usage: { tokens_in: 10, tokens_out: 20 },
      mean_logprob: -5,
      latency_ms: 50,
      cost_usd: 0.001,
    }));

    const result = await route({ prompt: "What is the capital of Norway?" }, noShadow);

    expect(result.escalation_reason).toBe("logprob_low");
    expect(result.schema_repaired).toBeNull();
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("is not attempted when Stage 1 pre-routed to Tier 2", async () => {
    script({ text: "here is a function" });

    const result = await route(
      { prompt: "Write a function that reverses a list", schema: jsonSchema },
      noShadow,
    );

    expect(result.schema_repaired).toBeNull();
    expect(callModel).toHaveBeenCalledTimes(1);
  });
});

describe("the log records the repair outcome", () => {
  it("logs true on a successful repair", async () => {
    script({ text: "prose" }, { text: '{"city":"Oslo"}' });
    await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    const row = logRequest.mock.calls[0][0];
    expect(row.schema_repaired).toBe(true);
    expect(row.tier_called).toBe(1);
    expect(row.escalated).toBe(false);
  });

  it("logs false when repair was tried and the request escalated anyway", async () => {
    script({ text: "prose" }, { text: "still prose" }, { text: "ok" });
    await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    expect(logRequest.mock.calls[0][0].schema_repaired).toBe(false);
  });

  it("still writes exactly one row, with the documented field set", async () => {
    script({ text: "prose" }, { text: '{"city":"Oslo"}' });
    await route(
      { prompt: "Give me the capital of Norway as JSON", schema: jsonSchema },
      noShadow,
    );

    expect(logRequest).toHaveBeenCalledTimes(1);
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
});
