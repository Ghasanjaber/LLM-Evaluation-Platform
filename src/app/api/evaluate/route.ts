import { NextResponse } from "next/server";
import { callModel } from "@/lib/providers";

/**
 * POST /api/evaluate
 *
 * Runs one prompt against several models in parallel and reports each
 * response alongside the wall-clock latency of its API call.
 *
 * Provider adapters live in src/lib/providers.ts and are shared with the
 * Cascade Router, so a model added there is available to both paths.
 *
 * Request:  { prompt, models, temperature?, max_tokens? }
 * Response: [{ model_name, response_text, latency_ms, error? }]
 */

interface EvaluateRequest {
  prompt?: string;
  models?: string[];
  temperature?: number;
  max_tokens?: number;
}

interface EvaluationResult {
  model_name: string;
  response_text: string;
  latency_ms: number;
  error?: boolean;
}

/** Times one model call. A failure is reported per-model, never thrown. */
async function evaluateModel(
  model: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
): Promise<EvaluationResult> {
  const startedAt = performance.now();

  try {
    const call = await callModel({ model, prompt, temperature, maxTokens });

    return {
      model_name: model,
      response_text: call.text || "(empty response)",
      latency_ms: call.latency_ms,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? "Request timed out"
          : error.message
        : "Unknown error";

    return {
      model_name: model,
      response_text: message,
      latency_ms: performance.now() - startedAt,
      error: true,
    };
  }
}

export async function POST(request: Request) {
  let body: EvaluateRequest;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: "A prompt is required" }, { status: 400 });
  }

  const models = Array.isArray(body.models) ? body.models : [];
  if (models.length === 0) {
    return NextResponse.json(
      { error: "Select at least one model" },
      { status: 400 },
    );
  }

  const temperature =
    typeof body.temperature === "number" ? body.temperature : 0.7;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 100;

  // One slow model shouldn't delay the others, so fan out and wait for all.
  const results = await Promise.all(
    models.map((model) => evaluateModel(model, prompt, temperature, maxTokens)),
  );

  return NextResponse.json(results);
}
