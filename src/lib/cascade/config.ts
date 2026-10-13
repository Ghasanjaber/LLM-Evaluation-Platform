/**
 * Tunable knobs for the Cascade Router.
 *
 * Every value that the design document calls out as "a starting point, not a
 * derived optimum" lives here so it can be adjusted without touching logic.
 */

/**
 * Per-million-token USD pricing.
 *
 * IMPORTANT: not a live price feed. The Anthropic rates below were taken from
 * Anthropic's published pricing table (cached 2026-06-24); the OpenAI and
 * Google rates are still hand-entered and unchecked. Provider pricing changes —
 * verify against each provider's pricing page before presenting any cost figure
 * as authoritative, and update PRICING_LAST_VERIFIED.
 */
export const PRICING_LAST_VERIFIED =
  "Anthropic 2026-06-24; OpenAI and Google not yet verified";

export const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10.0 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4": { in: 30.0, out: 60.0 },
  "gpt-3.5-turbo": { in: 0.5, out: 1.5 },
  "gemini-1.5-pro": { in: 1.25, out: 5.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
  // Opus 5's server-side refusal fallback bills at this model's own rates.
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
};

/**
 * Tier assignments. Tier 1 must be the cheaper model.
 *
 * Both tiers are OpenAI models for two reasons that compound:
 *
 *   1. A ~16.7x cost spread at short-answer token counts (gpt-4o is $2.50/$10
 *      per Mtok against gpt-4o-mini's $0.15/$0.60), so the cascade has real
 *      headroom to demonstrate.
 *   2. OpenAI exposes token logprobs, which keeps the escalation gate's free
 *      `logprob_low` signal live. On a provider without logprobs every gate
 *      check falls through to self-consistency instead, costing one extra
 *      Tier 1 call and roughly halving the savings.
 *
 * Not `gpt-4`: it is listed by /v1/models but returns 404 to project-scoped
 * (`sk-proj-…`) keys whose project allowlist excludes it. The org-level model
 * list overstates what a given key can call, so the pairing below was chosen by
 * probing the key directly rather than by reading that list.
 *
 * Claude models remain available to comparison mode via src/lib/providers.ts;
 * pointing a tier at one is a one-line change here, but see the note above for
 * what it costs. See docs/architecture/cascade-router.md §5 and §11.8.
 */
export const TIER_1_MODEL = "gpt-4o-mini";
export const TIER_2_MODEL = "gpt-4o";

/** Stage 1: prompt length above this many chars falls through to Stage 2. */
export const LONG_PROMPT_CHARS = 600;

/** Stage 1: this many distinct asks ("?" or imperative clauses) is "dense". */
export const DENSE_PROMPT_ASKS = 3;

/** Stage 2: P(complex) at or above this routes to Tier 2. */
export const CLASSIFIER_COMPLEX_THRESHOLD = 0.5;

/** Escalation: mean token logprob below this triggers escalation (τ). */
export const LOGPROB_THRESHOLD = -1.0;

/**
 * Schema repair: attempt this many constrained Tier 1 retries before escalating
 * a format failure to Tier 2.
 *
 * Set from a measured result. Across 155 live requests every one of the 8
 * escalations was `schema_fail`, and Tier 2 did not reliably produce conforming
 * output either — a larger model is not a fix for a formatting miss. One bounded
 * retry at Tier 1, with the constraint stated explicitly and JSON mode on where
 * the provider supports it, addresses the actual cause at ~1/17th the cost.
 *
 * Deliberately a small fixed number, not a loop: an unbounded repair cycle on a
 * model that cannot satisfy the schema would spend without terminating.
 */
export const SCHEMA_REPAIR_ATTEMPTS = 1;

/**
 * Escalation: Jaccard similarity between two Tier 1 samples below this counts
 * as "materially disagree". Only used when logprobs are unavailable.
 */
export const SELF_CONSISTENCY_THRESHOLD = 0.6;

/** Temperature for the second self-consistency sample (must be > 0). */
export const SELF_CONSISTENCY_TEMPERATURE = 0.7;

/**
 * Fraction of Tier 1-resolved requests that also make a Tier 2 call purely to
 * measure the naive baseline. Directly trades baseline freshness against the
 * savings the router exists to capture.
 */
export const SHADOW_SAMPLE_RATE = 0.05;

/** Wall-clock ceiling on any single provider call. */
export const REQUEST_TIMEOUT_MS = 60_000;
