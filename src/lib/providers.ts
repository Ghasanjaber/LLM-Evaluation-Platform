import { REQUEST_TIMEOUT_MS } from "./cascade/config";
import { computeCost } from "./cascade/pricing";
import type { ModelCall } from "./cascade/types";

/**
 * Provider adapters. Both return the same ModelCall shape so the router never
 * branches on provider, and both report token usage so cost is computed from
 * what was actually consumed rather than estimated.
 *
 * Plain fetch against the REST APIs on purpose: no SDK version drift, and the
 * request shape stays visible at the call site.
 */

export type Provider = "openai" | "google";

export const MODEL_PROVIDERS: Record<string, Provider> = {
  "gpt-4": "openai",
  "gpt-3.5-turbo": "openai",
  "gemini-1.5-pro": "google",
};

export interface CallOptions {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  /** Request token logprobs where the provider supports them. */
  wantLogprobs?: boolean;
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

async function callOpenAI(options: CallOptions): Promise<ModelCall> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env.local");

  const startedAt = performance.now();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [{ role: "user", content: options.prompt }],
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.wantLogprobs ? { logprobs: true } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`OpenAI returned ${res.status}: ${await readError(res)}`);
  }

  const data = await res.json();
  const latency_ms = performance.now() - startedAt;

  const tokenLogprobs: number[] = (data?.choices?.[0]?.logprobs?.content ?? [])
    .map((entry: { logprob?: number }) => entry.logprob)
    .filter((value: unknown): value is number => typeof value === "number");

  const usage = {
    tokens_in: data?.usage?.prompt_tokens ?? 0,
    tokens_out: data?.usage?.completion_tokens ?? 0,
  };

  return {
    model: options.model,
    text: data?.choices?.[0]?.message?.content?.trim() || "",
    usage,
    mean_logprob: tokenLogprobs.length
      ? tokenLogprobs.reduce((sum, value) => sum + value, 0) /
        tokenLogprobs.length
      : null,
    latency_ms,
    cost_usd: computeCost(options.model, usage),
  };
}

async function callGemini(options: CallOptions): Promise<ModelCall> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set in .env.local");

  const startedAt = performance.now();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: options.prompt }] }],
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    throw new Error(`Gemini returned ${res.status}: ${await readError(res)}`);
  }

  const data = await res.json();
  const latency_ms = performance.now() - startedAt;

  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part: { text?: string }) => part.text ?? "").join("")
    : "";

  const usage = {
    tokens_in: data?.usageMetadata?.promptTokenCount ?? 0,
    tokens_out: data?.usageMetadata?.candidatesTokenCount ?? 0,
  };

  return {
    model: options.model,
    text: text.trim(),
    usage,
    // The generateContent endpoint does not return token logprobs, so the
    // escalation gate falls back to self-consistency for this provider.
    mean_logprob: null,
    latency_ms,
    cost_usd: computeCost(options.model, usage),
  };
}

export async function callModel(options: CallOptions): Promise<ModelCall> {
  const provider = MODEL_PROVIDERS[options.model];
  if (!provider) throw new Error(`Unsupported model "${options.model}"`);

  return provider === "openai" ? callOpenAI(options) : callGemini(options);
}

/** True when this model can supply the free logprob escalation signal. */
export function supportsLogprobs(model: string): boolean {
  return MODEL_PROVIDERS[model] === "openai";
}
