/**
 * Tunable knobs for the Cascade Router.
 *
 * Every value that the design document calls out as "a starting point, not a
 * derived optimum" lives here so it can be adjusted without touching logic.
 */

/**
 * Per-million-token USD pricing.
 *
 * IMPORTANT: these are hand-entered placeholders, not a live price feed.
 * Provider pricing changes; verify against the provider's pricing page before
 * presenting any cost figure as authoritative, and update PRICING_LAST_VERIFIED.
 */
export const PRICING_LAST_VERIFIED = "not yet verified";

export const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4": { in: 30.0, out: 60.0 },
  "gpt-3.5-turbo": { in: 0.5, out: 1.5 },
  "gemini-1.5-pro": { in: 1.25, out: 5.0 },
};

/** Tier assignments. Tier 1 must be the cheaper model. */
export const TIER_1_MODEL = "gpt-3.5-turbo";
export const TIER_2_MODEL = "gpt-4";

/** Stage 1: prompt length above this many chars falls through to Stage 2. */
export const LONG_PROMPT_CHARS = 600;

/** Stage 1: this many distinct asks ("?" or imperative clauses) is "dense". */
export const DENSE_PROMPT_ASKS = 3;

/** Stage 2: P(complex) at or above this routes to Tier 2. */
export const CLASSIFIER_COMPLEX_THRESHOLD = 0.5;

/** Escalation: mean token logprob below this triggers escalation (τ). */
export const LOGPROB_THRESHOLD = -1.0;

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
