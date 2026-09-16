import { NextResponse } from "next/server";

/**
 * POST /api/evaluate
 *
 * Runs one prompt against several models in parallel and reports each
 * response alongside the wall-clock latency of its API call.
 *
 * Request:  { prompt, models, temperature?, max_tokens? }
 * Response: [{ model_name, response_text, latency_ms, error? }]
 */

const REQUEST_TIMEOUT_MS = 60_000;

type Provider = "openai" | "google";

const MODEL_PROVIDERS: Record<string, Provider> = {
  "gpt-4": "openai",
  "gpt-3.5-turbo": "openai",
  "gemini-1.5-pro": "google",
};

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

interface CallOptions {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
}

async function callOpenAI({
  model,
  prompt,
  temperature,
  maxTokens,
}: CallOptions): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in .env.local");
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`OpenAI returned ${res.status}: ${await readError(res)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "(empty response)";
}

async function callGemini({
  model,
  prompt,
  temperature,
  maxTokens,
}: CallOptions): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is not set in .env.local");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini returned ${res.status}: ${await readError(res)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part: { text?: string }) => part.text ?? "").join("")
    : "";

  // A truncated or filtered candidate comes back with no parts but a reason why.
  if (!text.trim()) {
    const reason = data?.candidates?.[0]?.finishReason;
    return reason ? `(no text returned, finishReason: ${reason})` : "(empty response)";
  }

  return text.trim();
}

/** Pulls a short, readable snippet out of a provider's error body. */
async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body.slice(0, 200) || res.statusText;
}

/** Times a single model call. A failure is reported per-model, never thrown. */
async function evaluateModel(options: CallOptions): Promise<EvaluationResult> {
  const provider = MODEL_PROVIDERS[options.model];
  const startedAt = performance.now();

  try {
    if (!provider) {
      throw new Error(`Unsupported model "${options.model}"`);
    }

    const responseText =
      provider === "openai"
        ? await callOpenAI(options)
        : await callGemini(options);

    return {
      model_name: options.model,
      response_text: responseText,
      latency_ms: performance.now() - startedAt,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
          : error.message
        : "Unknown error";

    return {
      model_name: options.model,
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

  const temperature = typeof body.temperature === "number" ? body.temperature : 0.7;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 100;

  // One slow model shouldn't delay the others, so fan out and wait for all.
  const results = await Promise.all(
    models.map((model) =>
      evaluateModel({ model, prompt, temperature, maxTokens }),
    ),
  );

  return NextResponse.json(results);
}
