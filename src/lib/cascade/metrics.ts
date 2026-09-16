import { SHADOW_SAMPLE_RATE } from "./config";
import type { EscalationReason, RequestLogRow } from "./types";

/**
 * Metrics pipeline — the four views described in §7 of the design document,
 * all derived from the single append-only request log.
 */

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);

  return sorted[index];
}

export type PathLabel = "tier1_only" | "escalated" | "tier2_direct";

/** Which of the three latency paths a logged request took. */
export function pathOf(row: RequestLogRow): PathLabel {
  if (row.escalated) return "escalated";
  return row.tier_called === 1 ? "tier1_only" : "tier2_direct";
}

interface LatencyBucket {
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

function latencyBucket(values: number[]): LatencyBucket {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}

export interface CostView {
  routed_total_usd: number;
  /**
   * Naive always-Tier-2 spend for the same traffic. Tier 2 requests contribute
   * their real cost; Tier 1 requests contribute the mean shadow-sampled cost,
   * extrapolated across all of them. This is an extrapolation from a sample,
   * never a full measurement — the label below says so and the UI must show it.
   */
  baseline_total_usd: number | null;
  savings_usd: number | null;
  savings_pct: number | null;
  baseline_label: string;
  shadow_sample_count: number;
  /** True when no shadow sample exists yet, so no baseline can be claimed. */
  baseline_unavailable: boolean;
  by_day: Array<{ day: string; routed_usd: number; requests: number }>;
}

function buildCostView(rows: RequestLogRow[]): CostView {
  const routed_total_usd = rows.reduce((sum, row) => sum + row.cost_usd, 0);

  const tier2Rows = rows.filter((row) => row.tier_called === 2);
  const tier1Rows = rows.filter((row) => row.tier_called === 1);

  // Shadow samples only exist on the fast path, which is the only path whose
  // naive cost is otherwise unknown.
  const shadowSamples = tier1Rows
    .map((row) => row.baseline_cost_usd)
    .filter((value): value is number => typeof value === "number");

  const tier2Actual = tier2Rows.reduce(
    (sum, row) => sum + (row.baseline_cost_usd ?? row.cost_usd),
    0,
  );

  let baseline_total_usd: number | null = null;
  if (shadowSamples.length > 0) {
    const meanShadow =
      shadowSamples.reduce((sum, value) => sum + value, 0) /
      shadowSamples.length;
    baseline_total_usd = tier2Actual + meanShadow * tier1Rows.length;
  } else if (tier1Rows.length === 0 && tier2Rows.length > 0) {
    // All traffic went to Tier 2, so the baseline is fully measured.
    baseline_total_usd = tier2Actual;
  }

  const byDayMap = new Map<string, { routed_usd: number; requests: number }>();
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10);
    const entry = byDayMap.get(day) ?? { routed_usd: 0, requests: 0 };
    entry.routed_usd += row.cost_usd;
    entry.requests += 1;
    byDayMap.set(day, entry);
  }

  const savings_usd =
    baseline_total_usd === null ? null : baseline_total_usd - routed_total_usd;

  return {
    routed_total_usd,
    baseline_total_usd,
    savings_usd,
    savings_pct:
      baseline_total_usd && baseline_total_usd > 0 && savings_usd !== null
        ? (savings_usd / baseline_total_usd) * 100
        : null,
    baseline_label: `baseline (shadow-sampled, n=${Math.round(
      SHADOW_SAMPLE_RATE * 100,
    )}%)`,
    shadow_sample_count: shadowSamples.length,
    baseline_unavailable: baseline_total_usd === null,
    by_day: [...byDayMap.entries()]
      .map(([day, entry]) => ({ day, ...entry }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export interface MetricsSnapshot {
  total_requests: number;
  cost: CostView;
  latency: {
    blended: LatencyBucket;
    tier1_only: LatencyBucket;
    escalated: LatencyBucket;
    tier2_direct: LatencyBucket;
  };
  escalation: {
    /** Share of Tier 1 calls that tripped the gate. */
    rate_pct: number | null;
    tier1_attempts: number;
    escalated_count: number;
    by_reason: Record<Exclude<EscalationReason, null>, number>;
    by_day: Array<{ day: string; rate_pct: number; tier1_attempts: number }>;
  };
  tier_distribution: {
    tier1_pct: number | null;
    tier2_pct: number | null;
    tier1_count: number;
    tier2_direct_count: number;
    tier2_escalated_count: number;
  };
}

export function buildMetrics(rows: RequestLogRow[]): MetricsSnapshot {
  const byPath = {
    tier1_only: [] as number[],
    escalated: [] as number[],
    tier2_direct: [] as number[],
  };

  for (const row of rows) byPath[pathOf(row)].push(row.latency_ms);

  // A Tier 1 attempt is any request that actually reached the small model:
  // the fast path plus everything that escalated out of it.
  const escalatedRows = rows.filter((row) => row.escalated);
  const tier1Attempts = byPath.tier1_only.length + escalatedRows.length;

  const by_reason = {
    schema_fail: 0,
    logprob_low: 0,
    inconsistent: 0,
  };
  for (const row of escalatedRows) {
    if (row.escalation_reason) by_reason[row.escalation_reason] += 1;
  }

  // Escalation rate per day, to expose classifier drift as a trend.
  const dayMap = new Map<string, { attempts: number; escalated: number }>();
  for (const row of rows) {
    const path = pathOf(row);
    if (path === "tier2_direct") continue; // never reached Tier 1

    const day = row.timestamp.slice(0, 10);
    const entry = dayMap.get(day) ?? { attempts: 0, escalated: 0 };
    entry.attempts += 1;
    if (row.escalated) entry.escalated += 1;
    dayMap.set(day, entry);
  }

  return {
    total_requests: rows.length,
    cost: buildCostView(rows),
    latency: {
      blended: latencyBucket(rows.map((row) => row.latency_ms)),
      tier1_only: latencyBucket(byPath.tier1_only),
      escalated: latencyBucket(byPath.escalated),
      tier2_direct: latencyBucket(byPath.tier2_direct),
    },
    escalation: {
      rate_pct:
        tier1Attempts > 0
          ? (escalatedRows.length / tier1Attempts) * 100
          : null,
      tier1_attempts: tier1Attempts,
      escalated_count: escalatedRows.length,
      by_reason,
      by_day: [...dayMap.entries()]
        .map(([day, entry]) => ({
          day,
          tier1_attempts: entry.attempts,
          rate_pct: (entry.escalated / entry.attempts) * 100,
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    },
    tier_distribution: {
      tier1_pct: rows.length ? (byPath.tier1_only.length / rows.length) * 100 : null,
      tier2_pct: rows.length
        ? ((byPath.tier2_direct.length + byPath.escalated.length) /
            rows.length) *
          100
        : null,
      tier1_count: byPath.tier1_only.length,
      tier2_direct_count: byPath.tier2_direct.length,
      tier2_escalated_count: byPath.escalated.length,
    },
  };
}
