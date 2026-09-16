import { NextResponse } from "next/server";
import { route as runRouter } from "@/lib/cascade/router";
import type { OutputSchema, RouteRequest } from "@/lib/cascade/types";

/**
 * POST /api/route — the Cascade Router path.
 *
 * Opt-in and separate from /api/evaluate, which keeps the platform's existing
 * three-model side-by-side comparison intact (design doc §2, non-goal 2).
 *
 * Request:  { prompt, schema?, temperature?, max_tokens? }
 * Response: RouteResponse
 */

function parseSchema(value: unknown): OutputSchema | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;

  if (candidate.type === "regex" && typeof candidate.pattern === "string") {
    return { type: "regex", pattern: candidate.pattern };
  }

  if (candidate.type === "json") {
    const required = Array.isArray(candidate.required)
      ? candidate.required.filter(
          (field): field is string => typeof field === "string",
        )
      : undefined;
    return { type: "json", required };
  }

  return undefined;
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "A prompt is required" }, { status: 400 });
  }

  const routeRequest: RouteRequest = {
    prompt,
    schema: parseSchema(body.schema),
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    max_tokens:
      typeof body.max_tokens === "number" ? body.max_tokens : undefined,
  };

  try {
    return NextResponse.json(await runRouter(routeRequest));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? "Upstream model request timed out"
          : error.message
        : "Unknown routing error";

    console.error("[cascade] routing failed:", error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
