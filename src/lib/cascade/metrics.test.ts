import { describe, expect, it } from "vitest";
import { buildMetrics, pathOf, percentile } from "./metrics";
import type { RequestLogRow } from "./types";

/**
 * Unit tests — the metrics pipeline.
 *
 * The dashboard's job is to be defensible, so most of these assert honesty
 * properties rather than arithmetic: no baseline is reported without a sample
 * behind it, and an empty log reports nothing rather than zero.
 */

function row(overrides: Partial<RequestLogRow> = {}): RequestLogRow {
  return {
    request_id: "00000000-0000-0000-0000-000000000000",
    timestamp: "2026-10-13T10:00:00.000Z",
    tier_called: 1,
    stage1_route: "passed",
    stage2_route: "simple",
    escalated: false,
    escalation_reason: null,
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: 0.001,
    latency_ms: 100,
    baseline_cost_usd: null,
    schema_repaired: null,
    ...overrides,
  };
}

const tier2Direct = (o: Partial<RequestLogRow> = {}) =>
  row({
    tier_called: 2,
    stage1_route: "direct_t2",
    stage2_route: null,
    cost_usd: 0.05,
    baseline_cost_usd: 0.05,
    ...o,
  });

const escalated = (o: Partial<RequestLogRow> = {}) =>
  row({
    tier_called: 2,
    escalated: true,
    escalation_reason: "logprob_low",
    cost_usd: 0.051,
    baseline_cost_usd: 0.05,
    ...o,
  });

describe("percentile", () => {
  it("picks the nearest rank", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 100)).toBe(10);
  });

  it("surfaces the tail rather than smoothing it away", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 99)).toBe(100);
  });

  it("does not care about input order", () => {
    expect(percentile([10, 1, 5], 50)).toBe(percentile([1, 5, 10], 50));
  });

  it("returns null for an empty sample instead of 0", () => {
    // 0 ms would render as a real, excellent latency. null renders as "—".
    expect(percentile([], 50)).toBeNull();
  });

  it("handles a single value", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });
});

describe("pathOf", () => {
  it("separates the three latency paths", () => {
    expect(pathOf(row())).toBe("tier1_only");
    expect(pathOf(escalated())).toBe("escalated");
    expect(pathOf(tier2Direct())).toBe("tier2_direct");
  });
});

describe("buildMetrics — empty log", () => {
  const metrics = buildMetrics([]);

  it("claims no baseline", () => {
    expect(metrics.cost.baseline_unavailable).toBe(true);
    expect(metrics.cost.baseline_total_usd).toBeNull();
    expect(metrics.cost.savings_pct).toBeNull();
  });

  it("reports null rather than zero for rates and percentiles", () => {
    expect(metrics.escalation.rate_pct).toBeNull();
    expect(metrics.tier_distribution.tier1_pct).toBeNull();
    expect(metrics.latency.blended.p50).toBeNull();
    expect(metrics.total_requests).toBe(0);
  });
});

describe("buildMetrics — tier distribution", () => {
  const rows = [row(), row(), tier2Direct(), escalated()];
  const metrics = buildMetrics(rows);

  it("counts each path separately", () => {
    expect(metrics.tier_distribution.tier1_count).toBe(2);
    expect(metrics.tier_distribution.tier2_direct_count).toBe(1);
    expect(metrics.tier_distribution.tier2_escalated_count).toBe(1);
  });

  it("splits the shares so they account for every request", () => {
    expect(metrics.tier_distribution.tier1_pct).toBe(50);
    expect(metrics.tier_distribution.tier2_pct).toBe(50);
  });
});

describe("buildMetrics — escalation rate", () => {
  it("is a share of Tier 1 attempts, not of all traffic", () => {
    // A request pre-routed to Tier 2 never reached Tier 1, so including it
    // in the denominator would understate the gate's firing rate.
    const metrics = buildMetrics([row(), row(), escalated(), tier2Direct()]);

    expect(metrics.escalation.tier1_attempts).toBe(3);
    expect(metrics.escalation.escalated_count).toBe(1);
    expect(metrics.escalation.rate_pct).toBeCloseTo(33.33, 1);
  });

  it("tallies reasons", () => {
    const metrics = buildMetrics([
      escalated({ escalation_reason: "schema_fail" }),
      escalated({ escalation_reason: "schema_fail" }),
      escalated({ escalation_reason: "inconsistent" }),
    ]);

    expect(metrics.escalation.by_reason).toEqual({
      schema_fail: 2,
      logprob_low: 0,
      inconsistent: 1,
    });
  });

  it("trends by day, which is how classifier drift shows up", () => {
    const metrics = buildMetrics([
      row({ timestamp: "2026-10-11T10:00:00.000Z" }),
      escalated({ timestamp: "2026-10-12T10:00:00.000Z" }),
    ]);

    expect(metrics.escalation.by_day).toEqual([
      { day: "2026-10-11", tier1_attempts: 1, rate_pct: 0 },
      { day: "2026-10-12", tier1_attempts: 1, rate_pct: 100 },
    ]);
  });
});

describe("buildMetrics — cost baseline", () => {
  it("reports no baseline when nothing has been shadow-sampled", () => {
    // This is the honesty property that matters most: the fast path's naive
    // cost is unknown unless it was deliberately measured.
    const metrics = buildMetrics([row(), row(), row()]);
    expect(metrics.cost.baseline_unavailable).toBe(true);
    expect(metrics.cost.savings_pct).toBeNull();
  });

  it("extrapolates the fast path from the shadow sample", () => {
    const metrics = buildMetrics([
      row({ cost_usd: 0.001 }),
      row({ cost_usd: 0.001, baseline_cost_usd: 0.05 }), // sampled
      row({ cost_usd: 0.001 }),
      row({ cost_usd: 0.001 }),
    ]);

    expect(metrics.cost.shadow_sample_count).toBe(1);
    // Mean shadow cost 0.05 applied across all four Tier 1 requests.
    expect(metrics.cost.baseline_total_usd).toBeCloseTo(0.2, 10);
    expect(metrics.cost.routed_total_usd).toBeCloseTo(0.004, 10);
    expect(metrics.cost.savings_pct).toBeCloseTo(98, 0);
  });

  it("needs no extrapolation when all traffic went to Tier 2", () => {
    const metrics = buildMetrics([tier2Direct(), tier2Direct()]);
    expect(metrics.cost.baseline_unavailable).toBe(false);
    // Routed cost equals the baseline, so there is nothing to claim.
    expect(metrics.cost.savings_pct).toBeCloseTo(0, 10);
  });

  it("labels the baseline as sampled wherever it is shown", () => {
    const metrics = buildMetrics([row({ baseline_cost_usd: 0.05 })]);
    expect(metrics.cost.baseline_label).toContain("shadow-sampled");
  });

  it("can report negative savings, rather than hiding a router that lost money", () => {
    // An escalation-heavy workload costs more than always calling Tier 2.
    const metrics = buildMetrics([
      escalated({ cost_usd: 0.06, baseline_cost_usd: 0.05 }),
      escalated({ cost_usd: 0.06, baseline_cost_usd: 0.05 }),
    ]);
    expect(metrics.cost.savings_usd).toBeLessThan(0);
  });
});

describe("buildMetrics — latency", () => {
  const metrics = buildMetrics([
    row({ latency_ms: 100 }),
    row({ latency_ms: 120 }),
    escalated({ latency_ms: 900 }),
    tier2Direct({ latency_ms: 500 }),
  ]);

  it("isolates the escalated path, which pays both tiers sequentially", () => {
    expect(metrics.latency.escalated.p50).toBe(900);
    expect(metrics.latency.escalated.n).toBe(1);
  });

  it("keeps the fast path uncontaminated by escalations", () => {
    expect(metrics.latency.tier1_only.n).toBe(2);
    // Nearest-rank on [100, 120]: ceil(0.5 * 2) = rank 1 => 100.
    expect(metrics.latency.tier1_only.p50).toBe(100);
    expect(metrics.latency.tier1_only.p99).toBe(120);
  });

  it("blends across all traffic", () => {
    expect(metrics.latency.blended.n).toBe(4);
  });
});
