import { PRICING } from "./config";
import type { TokenUsage } from "./types";

/**
 * Converts token usage into USD using the rates in config.ts.
 * An unpriced model yields 0 rather than throwing — a missing price should not
 * fail a request, but it will visibly understate cost, so keep PRICING current.
 */
export function computeCost(model: string, usage: TokenUsage): number {
  const rate = PRICING[model];
  if (!rate) return 0;

  return (
    (usage.tokens_in / 1_000_000) * rate.in +
    (usage.tokens_out / 1_000_000) * rate.out
  );
}

export function isPriced(model: string): boolean {
  return Boolean(PRICING[model]);
}
