/**
 * Shared types for the Cascade Router.
 * Field names on RequestLogRow mirror the log schema in
 * docs/architecture/cascade-router.md (appendix 10) exactly.
 */

export type Tier = 1 | 2;

/** Stage 1 heuristic outcome. */
export type Stage1Route = "direct_t2" | "passed";

/**
 * Stage 2 classifier outcome. `cold_start` means no trained model was
 * available, so the conservative default (Tier 2) was applied.
 * Null when Stage 1 already routed directly and Stage 2 never ran.
 */
export type Stage2Route = "simple" | "complex" | "cold_start" | null;

export type EscalationReason =
  | "schema_fail"
  | "logprob_low"
  | "inconsistent"
  | null;

/** Which Stage 1 signal fired, for debugging and heuristic-drift review. */
export type HeuristicSignal =
  | "code"
  | "multi_step"
  | "math"
  | "long_or_dense"
  | "none";

export interface Stage1Result {
  route: Stage1Route;
  signal: HeuristicSignal;
  /** The substring or rule that matched, for auditing misroutes. */
  matched: string | null;
}

export interface Stage2Result {
  route: Exclude<Stage2Route, null>;
  /** P(complex) from the classifier; null on cold start. */
  score: number | null;
  /** Milliseconds spent embedding + scoring. */
  latency_ms: number;
}

/** An expected output shape, used by the schema escalation signal. */
export type OutputSchema =
  | { type: "json"; required?: string[] }
  | { type: "regex"; pattern: string };

export interface TokenUsage {
  tokens_in: number;
  tokens_out: number;
}

/** One completed model call. */
export interface ModelCall {
  model: string;
  text: string;
  usage: TokenUsage;
  /** Mean token logprob, or null when the provider does not expose them. */
  mean_logprob: number | null;
  latency_ms: number;
  cost_usd: number;
}

export interface EscalationDecision {
  escalate: boolean;
  reason: EscalationReason;
  /** Extra Tier 1 calls the gate itself made (self-consistency sampling). */
  extra_calls: ModelCall[];
}

export interface RouteRequest {
  prompt: string;
  /** Declared output shape; enables the free schema escalation signal. */
  schema?: OutputSchema;
  temperature?: number;
  max_tokens?: number;
}

/** One row per request, written regardless of which path was taken. */
export interface RequestLogRow {
  request_id: string;
  timestamp: string;
  tier_called: Tier;
  stage1_route: Stage1Route;
  stage2_route: Stage2Route;
  escalated: boolean;
  escalation_reason: EscalationReason;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  /** Only populated on shadow-sampled requests. */
  baseline_cost_usd: number | null;
}

/** What /api/route returns to the caller. */
export interface RouteResponse {
  request_id: string;
  response_text: string;
  tier_called: Tier;
  model: string;
  escalated: boolean;
  escalation_reason: EscalationReason;
  stage1_route: Stage1Route;
  stage2_route: Stage2Route;
  cost_usd: number;
  latency_ms: number;
}
