"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { MetricsSnapshot } from "@/lib/cascade/metrics";
import type { RouteResponse } from "@/lib/cascade/types";

/**
 * Cascade Router console: send a prompt through the router, then read the four
 * observability views from the request log.
 *
 * Chart colors come from the validated dark categorical slots (blue / orange /
 * aqua) on a #1a1a19 surface; all label text stays in text tokens so identity
 * never rests on color alone.
 */

interface MetricsPayload {
  metrics: MetricsSnapshot;
  config: {
    tier1_model: string;
    tier2_model: string;
    shadow_sample_rate: number;
    pricing_last_verified: string;
  };
  classifier:
    | { trained: false }
    | {
        trained: true;
        trained_at: string;
        training_examples: number;
        holdout_accuracy: number;
        embedder_id: string;
      };
}

const SERIES = {
  tier1: "#3987e5",
  tier2Direct: "#d95926",
  tier2Escalated: "#199e70",
};

function usd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value).toLocaleString()} ms`;
}

/** Stat tile: label + value, optional footnote. No sparkline at this data volume. */
function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="viz-card rounded-lg p-4">
      <p className="text-xs uppercase tracking-wide viz-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold viz-primary">{value}</p>
      {note && <p className="mt-1 text-xs viz-secondary">{note}</p>}
    </div>
  );
}

export default function RouterConsole() {
  const [prompt, setPrompt] = useState("");
  const [schemaMode, setSchemaMode] = useState<"none" | "json">("none");
  const [isRouting, setIsRouting] = useState(false);
  const [result, setResult] = useState<RouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<MetricsPayload | null>(null);

  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics");
      if (res.ok) setData(await res.json());
    } catch (err) {
      console.error("Failed to load metrics:", err);
    }
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRouting(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          ...(schemaMode === "json"
            ? { schema: { type: "json" as const } }
            : {}),
        }),
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Routing failed");

      setResult(payload as RouteResponse);
      setPrompt("");
      await loadMetrics();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setIsRouting(false);
    }
  };

  const metrics = data?.metrics;
  const dist = metrics?.tier_distribution;
  const total = metrics?.total_requests ?? 0;

  const segments = dist
    ? [
        {
          key: "tier1",
          label: "Tier 1 fast path",
          count: dist.tier1_count,
          color: SERIES.tier1,
        },
        {
          key: "tier2_direct",
          label: "Tier 2 direct",
          count: dist.tier2_direct_count,
          color: SERIES.tier2Direct,
        },
        {
          key: "tier2_escalated",
          label: "Tier 2 escalated",
          count: dist.tier2_escalated_count,
          color: SERIES.tier2Escalated,
        },
      ].filter((segment) => segment.count > 0)
    : [];

  return (
    <div className="viz-root min-h-screen bg-black p-8">
      <style>{`
        .viz-root {
          --surface-1: #1a1a19;
          --text-primary: #ffffff;
          --text-secondary: #c3c2b7;
          --text-muted: #898781;
          --gridline: #2c2c2a;
          --border: rgba(255, 255, 255, 0.10);
        }
        .viz-card {
          background: var(--surface-1);
          border: 1px solid var(--border);
        }
        .viz-primary { color: var(--text-primary); }
        .viz-secondary { color: var(--text-secondary); }
        .viz-muted { color: var(--text-muted); }
        .viz-rule { border-color: var(--gridline); }
      `}</style>

      <div className="mx-auto max-w-5xl">
        <header className="mb-6">
          <div className="flex items-baseline justify-between gap-4">
            <h1 className="text-2xl font-bold text-yellow-400">
              Cascade Router
            </h1>
            <Link
              href="/"
              className="text-sm viz-secondary underline hover:text-yellow-400"
            >
              Side-by-side comparison →
            </Link>
          </div>
          <p className="mt-1 viz-secondary">
            Two-tier, cost- and latency-aware routing. Tier 1{" "}
            <span className="viz-primary">
              {data?.config.tier1_model ?? "…"}
            </span>
            , Tier 2{" "}
            <span className="viz-primary">
              {data?.config.tier2_model ?? "…"}
            </span>
            .
          </p>
        </header>

        {/* Cold start is a documented state, not a failure — say so plainly. */}
        {data && !data.classifier.trained && (
          <div className="mb-6 rounded-lg border border-yellow-700 bg-yellow-950/40 p-4">
            <p className="text-sm text-yellow-200">
              <strong>Stage 2 classifier: cold start.</strong> No trained
              weights found, so every prompt that clears Stage 1 takes the
              conservative default and routes to Tier 2. Run{" "}
              <code className="rounded bg-black/40 px-1">
                npm run train:classifier
              </code>{" "}
              to fit the seed model.
            </p>
          </div>
        )}

        {data?.classifier.trained && (
          <p className="mb-6 text-xs viz-muted">
            Stage 2 classifier trained{" "}
            {new Date(data.classifier.trained_at).toLocaleString()} ·{" "}
            {data.classifier.training_examples} examples · holdout accuracy{" "}
            {(data.classifier.holdout_accuracy * 100).toFixed(1)}%
          </p>
        )}

        {/* ---- Send a prompt through the router ---- */}
        <form onSubmit={handleSubmit} className="viz-card mb-8 rounded-lg p-4">
          <label
            htmlFor="prompt"
            className="mb-2 block text-sm font-medium viz-secondary"
          >
            Prompt
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={isRouting}
            placeholder="Ask something. Code, math or step-by-step prompts are routed straight to Tier 2 by the heuristics."
            className="w-full rounded-lg border border-gray-600 bg-gray-900 p-3 text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-yellow-400"
          />

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm viz-secondary">
              <input
                type="checkbox"
                checked={schemaMode === "json"}
                onChange={(e) =>
                  setSchemaMode(e.target.checked ? "json" : "none")
                }
              />
              Require valid JSON output
              <span className="viz-muted">(enables the free schema signal)</span>
            </label>

            <button
              type="submit"
              disabled={isRouting || !prompt.trim()}
              className="ml-auto rounded-lg bg-yellow-500 px-6 py-2 font-medium text-black transition-colors hover:bg-yellow-400 disabled:opacity-50"
            >
              {isRouting ? "Routing…" : "Route prompt"}
            </button>
          </div>
        </form>

        {error && (
          <p className="mb-6 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
            {error}
          </p>
        )}

        {/* ---- Routing trace for the last request ---- */}
        {result && (
          <div className="viz-card mb-8 rounded-lg p-4">
            <h2 className="mb-3 font-bold text-yellow-400">Response</h2>
            <p className="mb-4 whitespace-pre-wrap viz-primary">
              {result.response_text}
            </p>

            <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t viz-rule pt-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-xs uppercase viz-muted">Resolved at</p>
                <p className="viz-primary">
                  <span
                    aria-hidden
                    className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                    style={{
                      background:
                        result.tier_called === 1
                          ? SERIES.tier1
                          : result.escalated
                            ? SERIES.tier2Escalated
                            : SERIES.tier2Direct,
                    }}
                  />
                  Tier {result.tier_called} · {result.model}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase viz-muted">Stage 1</p>
                <p className="viz-primary">
                  {result.stage1_route === "direct_t2"
                    ? "direct to Tier 2"
                    : "passed"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase viz-muted">Stage 2</p>
                <p className="viz-primary">{result.stage2_route ?? "not run"}</p>
              </div>
              <div>
                <p className="text-xs uppercase viz-muted">Escalated</p>
                <p className="viz-primary">
                  {result.escalated
                    ? `yes · ${result.escalation_reason}`
                    : "no"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase viz-muted">Cost</p>
                <p className="viz-primary tabular-nums">
                  {usd(result.cost_usd)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase viz-muted">Latency</p>
                <p className="viz-primary tabular-nums">
                  {result.latency_ms.toLocaleString()} ms
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ---- Metrics ---- */}
        {metrics && total > 0 ? (
          <section>
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-bold text-yellow-400">
                Observability
              </h2>
              <button
                onClick={() => void loadMetrics()}
                className="text-sm viz-secondary underline hover:text-yellow-400"
              >
                Refresh
              </button>
            </div>

            {/* Hero figure — exactly one per view. */}
            <div className="viz-card mb-4 rounded-lg p-6">
              <p className="text-xs uppercase tracking-wide viz-muted">
                Cost vs naive always-Tier-2
              </p>
              {metrics.cost.baseline_unavailable ? (
                <>
                  <p className="mt-1 text-3xl font-semibold viz-secondary">
                    No baseline yet
                  </p>
                  <p className="mt-1 text-sm viz-secondary">
                    A comparison needs at least one shadow-sampled request.
                    Shadow sampling runs on{" "}
                    {((data?.config.shadow_sample_rate ?? 0) * 100).toFixed(0)}%
                    of fast-path requests, so this fills in as traffic
                    accumulates.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1 text-5xl font-semibold viz-primary">
                    {pct(metrics.cost.savings_pct)}
                  </p>
                  <p className="mt-2 text-sm viz-secondary">
                    saved — {usd(metrics.cost.routed_total_usd)} routed vs{" "}
                    {usd(metrics.cost.baseline_total_usd ?? 0)}{" "}
                    {metrics.cost.baseline_label}
                  </p>
                  <p className="mt-1 text-xs viz-muted">
                    Baseline is extrapolated from{" "}
                    {metrics.cost.shadow_sample_count} shadow-sampled request
                    {metrics.cost.shadow_sample_count === 1 ? "" : "s"}, not
                    measured across all traffic. Pricing:{" "}
                    {data?.config.pricing_last_verified}.
                  </p>
                </>
              )}
            </div>

            <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatTile
                label="Requests"
                value={total.toLocaleString()}
                note="rows in the request log"
              />
              <StatTile
                label="Tier 1 share"
                value={pct(dist?.tier1_pct ?? null)}
                note="resolved without Tier 2"
              />
              <StatTile
                label="Escalation rate"
                value={pct(metrics.escalation.rate_pct)}
                note={`${metrics.escalation.escalated_count} of ${metrics.escalation.tier1_attempts} Tier 1 attempts`}
              />
              <StatTile
                label="Blended p95"
                value={ms(metrics.latency.blended.p95)}
                note="all paths together"
              />
            </div>

            {/* Tier distribution — one stacked bar, 2px surface gaps. */}
            <div className="viz-card mb-4 rounded-lg p-4">
              <h3 className="mb-3 text-sm font-medium viz-secondary">
                Tier distribution
              </h3>

              <div
                className="flex h-8 w-full overflow-hidden rounded"
                style={{ gap: "2px", background: "var(--surface-1)" }}
                role="img"
                aria-label={segments
                  .map(
                    (s) =>
                      `${s.label}: ${s.count} of ${total} (${(
                        (s.count / total) *
                        100
                      ).toFixed(1)}%)`,
                  )
                  .join("; ")}
              >
                {segments.map((segment, index) => {
                  const share = (segment.count / total) * 100;
                  return (
                    <div
                      key={segment.key}
                      className="flex items-center justify-center"
                      style={{
                        width: `${share}%`,
                        background: segment.color,
                        borderRadius:
                          index === 0
                            ? "4px 0 0 4px"
                            : index === segments.length - 1
                              ? "0 4px 4px 0"
                              : undefined,
                      }}
                    >
                      {/* Only label inline when the text comfortably fits. */}
                      {share >= 14 && (
                        <span className="px-2 text-xs font-medium text-black">
                          {share.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Legend is always present — identity never rests on color. */}
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1">
                {segments.map((segment) => (
                  <li
                    key={segment.key}
                    className="flex items-center gap-2 text-sm viz-secondary"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: segment.color }}
                    />
                    {segment.label}
                    <span className="viz-muted tabular-nums">
                      {segment.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Latency — a table, because n is small and exact values matter. */}
            <div className="viz-card mb-4 overflow-x-auto rounded-lg p-4">
              <h3 className="mb-1 text-sm font-medium viz-secondary">
                Latency by path
              </h3>
              <p className="mb-3 text-xs viz-muted">
                The escalated row is the one to watch: it pays Tier 1 and Tier 2
                sequentially.
              </p>

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b viz-rule text-left">
                    <th className="pb-2 font-medium viz-muted">Path</th>
                    <th className="pb-2 text-right font-medium viz-muted">n</th>
                    <th className="pb-2 text-right font-medium viz-muted">
                      p50
                    </th>
                    <th className="pb-2 text-right font-medium viz-muted">
                      p95
                    </th>
                    <th className="pb-2 text-right font-medium viz-muted">
                      p99
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Tier 1 only", metrics.latency.tier1_only, SERIES.tier1],
                      [
                        "Escalated",
                        metrics.latency.escalated,
                        SERIES.tier2Escalated,
                      ],
                      [
                        "Tier 2 direct",
                        metrics.latency.tier2_direct,
                        SERIES.tier2Direct,
                      ],
                      ["Blended", metrics.latency.blended, null],
                    ] as const
                  ).map(([label, bucket, color]) => (
                    <tr key={label} className="border-b viz-rule last:border-0">
                      <td className="py-2 viz-primary">
                        {color && (
                          <span
                            aria-hidden
                            className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                            style={{ background: color }}
                          />
                        )}
                        {label}
                      </td>
                      <td className="py-2 text-right viz-secondary tabular-nums">
                        {bucket.n}
                      </td>
                      <td className="py-2 text-right viz-primary tabular-nums">
                        {ms(bucket.p50)}
                      </td>
                      <td className="py-2 text-right viz-primary tabular-nums">
                        {ms(bucket.p95)}
                      </td>
                      <td className="py-2 text-right viz-primary tabular-nums">
                        {ms(bucket.p99)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Escalation reasons */}
            <div className="viz-card rounded-lg p-4">
              <h3 className="mb-3 text-sm font-medium viz-secondary">
                Escalation reasons
              </h3>
              <ul className="space-y-1 text-sm">
                {(
                  [
                    ["schema_fail", "Schema / format invalid"],
                    ["logprob_low", "Token logprob below τ"],
                    ["inconsistent", "Samples disagreed"],
                  ] as const
                ).map(([key, label]) => (
                  <li key={key} className="flex justify-between">
                    <span className="viz-secondary">{label}</span>
                    <span className="viz-primary tabular-nums">
                      {metrics.escalation.by_reason[key]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : (
          <p className="viz-secondary">
            No requests logged yet. Route a prompt above and the four
            observability views will appear here.
          </p>
        )}
      </div>
    </div>
  );
}
