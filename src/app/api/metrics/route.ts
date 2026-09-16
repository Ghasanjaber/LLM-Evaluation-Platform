import { NextResponse } from "next/server";
import { classifierStatus } from "@/lib/cascade/classifier";
import {
  PRICING_LAST_VERIFIED,
  SHADOW_SAMPLE_RATE,
  TIER_1_MODEL,
  TIER_2_MODEL,
} from "@/lib/cascade/config";
import { readRequestLog } from "@/lib/cascade/logger";
import { buildMetrics } from "@/lib/cascade/metrics";

/** GET /api/metrics — the four observability views, plus router config. */
export async function GET() {
  try {
    const rows = await readRequestLog();

    return NextResponse.json({
      metrics: buildMetrics(rows),
      config: {
        tier1_model: TIER_1_MODEL,
        tier2_model: TIER_2_MODEL,
        shadow_sample_rate: SHADOW_SAMPLE_RATE,
        pricing_last_verified: PRICING_LAST_VERIFIED,
      },
      classifier: await classifierStatus(),
    });
  } catch (error) {
    console.error("[cascade] metrics failed:", error);
    return NextResponse.json(
      { error: "Failed to read metrics" },
      { status: 500 },
    );
  }
}
