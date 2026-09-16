import {
  LOGPROB_THRESHOLD,
  SELF_CONSISTENCY_TEMPERATURE,
  SELF_CONSISTENCY_THRESHOLD,
} from "./config";
import { tokenize } from "./embedding";
import type {
  EscalationDecision,
  ModelCall,
  OutputSchema,
} from "./types";

/**
 * The escalation gate.
 *
 * Decides whether a Tier 1 answer is trustworthy enough to return, using only
 * signals external to the model's own claims. The model is never asked how
 * confident it is: small models are frequently confidently wrong, so an
 * uncalibrated self-rating is not a usable escalation signal.
 *
 * Signals are checked cheapest-first. Self-consistency is the only one with a
 * marginal cost, and it runs solely when logprobs are unavailable.
 */

/** Strips a ```json fence so a fenced object still parses. */
function unfence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Free. Returns true when the output violates its declared shape. */
export function failsSchema(text: string, schema: OutputSchema): boolean {
  if (schema.type === "regex") {
    try {
      return !new RegExp(schema.pattern).test(text);
    } catch {
      // A malformed pattern is a config bug, not a model failure — do not
      // escalate on it, but make it visible.
      console.warn(`[cascade] invalid escalation regex: ${schema.pattern}`);
      return false;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return true; // JSON parse failure
  }

  if (schema.required?.length) {
    if (typeof parsed !== "object" || parsed === null) return true;
    const keys = new Set(Object.keys(parsed as Record<string, unknown>));
    return schema.required.some((field) => !keys.has(field));
  }

  return false;
}

/** Jaccard similarity over token sets; 1 = identical, 0 = disjoint. */
export function similarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;

  return intersection / (setA.size + setB.size - intersection);
}

export interface EscalationInput {
  call: ModelCall;
  schema?: OutputSchema;
  /** Draws another Tier 1 sample; only invoked for self-consistency. */
  resample: (temperature: number) => Promise<ModelCall>;
}

export async function evaluateEscalation({
  call,
  schema,
  resample,
}: EscalationInput): Promise<EscalationDecision> {
  // 1. Schema / format validation — free.
  if (schema && failsSchema(call.text, schema)) {
    return { escalate: true, reason: "schema_fail", extra_calls: [] };
  }

  // An empty answer is a format failure even with no schema declared.
  if (!call.text.trim()) {
    return { escalate: true, reason: "schema_fail", extra_calls: [] };
  }

  // 2. Logprob uncertainty — free, same response.
  if (call.mean_logprob !== null) {
    if (call.mean_logprob < LOGPROB_THRESHOLD) {
      return { escalate: true, reason: "logprob_low", extra_calls: [] };
    }
    // Logprobs were available and passed; skip the paid signal entirely.
    return { escalate: false, reason: null, extra_calls: [] };
  }

  // 3. Self-consistency — costs one extra Tier 1 call. Fallback only.
  try {
    const second = await resample(SELF_CONSISTENCY_TEMPERATURE);
    const agreement = similarity(call.text, second.text);

    return {
      escalate: agreement < SELF_CONSISTENCY_THRESHOLD,
      reason: agreement < SELF_CONSISTENCY_THRESHOLD ? "inconsistent" : null,
      extra_calls: [second],
    };
  } catch (error) {
    // If the resample itself fails we cannot assess consistency. Returning the
    // unverified Tier 1 answer is the cheaper wrong choice; escalating is the
    // safer one, so escalate.
    console.warn("[cascade] self-consistency resample failed:", error);
    return { escalate: true, reason: "inconsistent", extra_calls: [] };
  }
}
