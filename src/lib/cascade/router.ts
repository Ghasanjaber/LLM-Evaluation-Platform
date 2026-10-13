import { randomUUID } from "node:crypto";
import { callModel, supportsLogprobs } from "../providers";
import { classifyStage2 } from "./classifier";
import {
  SCHEMA_REPAIR_ATTEMPTS,
  SHADOW_SAMPLE_RATE,
  TIER_1_MODEL,
  TIER_2_MODEL,
} from "./config";
import { evaluateEscalation, failsSchema } from "./escalation";
import { classifyStage1 } from "./heuristics";
import { logRequest } from "./logger";
import type {
  ModelCall,
  OutputSchema,
  RequestLogRow,
  RouteRequest,
  RouteResponse,
  Stage2Route,
} from "./types";

/**
 * The constraint, restated for the repair attempt. Mentions JSON explicitly
 * because OpenAI's json_object mode requires the word to appear in the request.
 */
function repairInstruction(schema: OutputSchema): string {
  if (schema.type === "regex") {
    return (
      `Reply with output matching this regular expression and nothing else: ` +
      `${schema.pattern}. No explanation, no prose, no code fence.`
    );
  }

  const fields = schema.required?.length
    ? ` It must contain exactly these keys: ${schema.required.join(", ")}.`
    : "";

  return (
    `Reply with a single valid JSON object and nothing else.${fields} ` +
    `No explanation, no prose, no markdown code fence.`
  );
}

/**
 * Cascade Router orchestration.
 *
 * Flow, per docs/architecture/cascade-router.md §3:
 *
 *   Stage 1 heuristics ──(complex)──────────────────────┐
 *        │ passed                                       │
 *   Stage 2 classifier ──(complex | cold_start)─────────┤
 *        │ simple                                       ▼
 *   Tier 1 call ──> escalation gate ──(fail)──────> Tier 2 call
 *        │ pass                                         │
 *        └──────────────> return <─────────────────────-┘
 *
 * Both pre-model stages run before any provider call, so a prompt that was
 * always going to need Tier 2 never pays for a Tier 1 call first.
 */

/** Seam for tests; production uses Math.random. */
export interface RouterDeps {
  random?: () => number;
}

function sumUsage(calls: ModelCall[]) {
  return calls.reduce(
    (totals, call) => ({
      tokens_in: totals.tokens_in + call.usage.tokens_in,
      tokens_out: totals.tokens_out + call.usage.tokens_out,
      cost_usd: totals.cost_usd + call.cost_usd,
    }),
    { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
  );
}

export async function route(
  request: RouteRequest,
  deps: RouterDeps = {},
): Promise<RouteResponse> {
  const random = deps.random ?? Math.random;
  const request_id = randomUUID();
  const startedAt = performance.now();

  const temperature = request.temperature ?? 0.7;
  const maxTokens = request.max_tokens ?? 100;

  // Every call actually made, for token/cost accounting.
  const billedCalls: ModelCall[] = [];

  const callTier = (
    tier: 1 | 2,
    overrides: {
      temperature?: number;
      jsonMode?: boolean;
      systemInstruction?: string;
    } = {},
  ) =>
    callModel({
      model: tier === 1 ? TIER_1_MODEL : TIER_2_MODEL,
      prompt: request.prompt,
      temperature: overrides.temperature ?? temperature,
      maxTokens,
      wantLogprobs: tier === 1 && supportsLogprobs(TIER_1_MODEL),
      jsonMode: overrides.jsonMode,
      systemInstruction: overrides.systemInstruction,
    });

  // ---- Pre-model routing (no provider calls) -----------------------------
  const stage1 = classifyStage1(request.prompt);

  let stage2_route: Stage2Route = null;
  let goDirectToTier2 = stage1.route === "direct_t2";

  if (!goDirectToTier2) {
    const stage2 = await classifyStage2(request.prompt);
    stage2_route = stage2.route;
    // Cold start is the documented conservative default: prefer Tier 2.
    goDirectToTier2 = stage2.route === "complex" || stage2.route === "cold_start";
  }

  // ---- Tier 2 direct ------------------------------------------------------
  if (goDirectToTier2) {
    const call = await callTier(2);
    billedCalls.push(call);

    const latency_ms = performance.now() - startedAt;
    const totals = sumUsage(billedCalls);

    await logRequest({
      request_id,
      timestamp: new Date().toISOString(),
      tier_called: 2,
      stage1_route: stage1.route,
      stage2_route,
      escalated: false,
      escalation_reason: null,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      // A naive always-Tier-2 baseline is exactly what this path already paid.
      baseline_cost_usd: totals.cost_usd,
      // Tier 1 was never called, so there was nothing to repair.
      schema_repaired: null,
    } satisfies RequestLogRow);

    return {
      request_id,
      response_text: call.text,
      tier_called: 2,
      model: call.model,
      escalated: false,
      escalation_reason: null,
      stage1_route: stage1.route,
      stage2_route,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      schema_repaired: null,
    };
  }

  // ---- Tier 1, then the escalation gate ----------------------------------
  const tier1Call = await callTier(1);
  billedCalls.push(tier1Call);

  const decision = await evaluateEscalation({
    call: tier1Call,
    schema: request.schema,
    resample: async (selfConsistencyTemp) => callTier(1, {
      temperature: selfConsistencyTemp,
    }),
  });
  billedCalls.push(...decision.extra_calls);

  // ---- Schema repair, before escalating a format failure -----------------
  // A format miss is not a capability gap: measured over 155 live requests,
  // Tier 2 did not reliably produce conforming output either. Restate the
  // constraint to Tier 1 instead, bounded to SCHEMA_REPAIR_ATTEMPTS, and only
  // escalate if that still fails.
  let schema_repaired: boolean | null = null;
  let answer = tier1Call;

  if (
    decision.escalate &&
    decision.reason === "schema_fail" &&
    request.schema &&
    SCHEMA_REPAIR_ATTEMPTS > 0
  ) {
    schema_repaired = false;

    for (let attempt = 0; attempt < SCHEMA_REPAIR_ATTEMPTS; attempt++) {
      let repair: ModelCall;
      try {
        repair = await callTier(1, {
          // Temperature 0: this is a formatting correction, not a resample.
          temperature: 0,
          jsonMode: request.schema.type === "json",
          systemInstruction: repairInstruction(request.schema),
        });
      } catch (error) {
        // A failed repair must not lose the request; fall through to Tier 2.
        console.warn("[cascade] schema repair call failed:", error);
        break;
      }

      billedCalls.push(repair);

      if (!failsSchema(repair.text, request.schema)) {
        schema_repaired = true;
        answer = repair;
        break;
      }
    }
  }

  // Repair succeeded: return the conforming Tier 1 answer, no Tier 2 spend.
  if (schema_repaired === true) {
    const latency_ms = performance.now() - startedAt;
    const totals = sumUsage(billedCalls);

    await logRequest({
      request_id,
      timestamp: new Date().toISOString(),
      tier_called: 1,
      stage1_route: stage1.route,
      stage2_route,
      escalated: false,
      escalation_reason: null,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      baseline_cost_usd: null,
      schema_repaired: true,
    } satisfies RequestLogRow);

    return {
      request_id,
      response_text: answer.text,
      tier_called: 1,
      model: answer.model,
      escalated: false,
      escalation_reason: null,
      stage1_route: stage1.route,
      stage2_route,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      schema_repaired: true,
    };
  }

  if (decision.escalate) {
    const tier2Call = await callTier(2);
    billedCalls.push(tier2Call);

    const latency_ms = performance.now() - startedAt;
    const totals = sumUsage(billedCalls);

    await logRequest({
      request_id,
      timestamp: new Date().toISOString(),
      tier_called: 2,
      stage1_route: stage1.route,
      stage2_route,
      escalated: true,
      escalation_reason: decision.reason,
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      // The Tier 2 call's own cost is the naive baseline; the Tier 1 spend on
      // this path is the escalation overhead, and is visible as the difference.
      baseline_cost_usd: tier2Call.cost_usd,
      schema_repaired,
    } satisfies RequestLogRow);

    return {
      request_id,
      response_text: tier2Call.text,
      tier_called: 2,
      model: tier2Call.model,
      escalated: true,
      escalation_reason: decision.reason,
      stage1_route: stage1.route,
      stage2_route,
      cost_usd: totals.cost_usd,
      latency_ms: Math.round(latency_ms),
      schema_repaired,
    };
  }

  // ---- Fast path: Tier 1 answer stands -----------------------------------
  // Latency is measured to the point the returned answer was ready, so the
  // shadow call below never inflates the user-perceived number.
  const latency_ms = performance.now() - startedAt;

  // Shadow sampling: a small fraction of fast-path requests also call Tier 2
  // purely to keep the cost baseline honest. The result is discarded.
  let baseline_cost_usd: number | null = null;
  if (random() < SHADOW_SAMPLE_RATE) {
    try {
      const shadow = await callTier(2);
      baseline_cost_usd = shadow.cost_usd;
    } catch (error) {
      console.warn("[cascade] shadow-sample call failed:", error);
    }
  }

  const totals = sumUsage(billedCalls);

  await logRequest({
    request_id,
    timestamp: new Date().toISOString(),
    tier_called: 1,
    stage1_route: stage1.route,
    stage2_route,
    escalated: false,
    escalation_reason: null,
    tokens_in: totals.tokens_in,
    tokens_out: totals.tokens_out,
    cost_usd: totals.cost_usd,
    latency_ms: Math.round(latency_ms),
    baseline_cost_usd,
    schema_repaired,
  } satisfies RequestLogRow);

  return {
    request_id,
    response_text: tier1Call.text,
    tier_called: 1,
    model: tier1Call.model,
    escalated: false,
    escalation_reason: null,
    stage1_route: stage1.route,
    stage2_route,
    cost_usd: totals.cost_usd,
    latency_ms: Math.round(latency_ms),
    schema_repaired,
  };
}
