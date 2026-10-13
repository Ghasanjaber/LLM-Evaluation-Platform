import Anthropic from "@anthropic-ai/sdk";
import { REQUEST_TIMEOUT_MS } from "./cascade/config";
import { computeCost } from "./cascade/pricing";
import type { ModelCall } from "./cascade/types";

/**
 * Provider adapters. Each returns the same ModelCall shape so the router never
 * branches on provider, and each reports token usage so cost is computed from
 * what was actually consumed rather than estimated.
 *
 * OpenAI and Google go over plain fetch: the request shape stays visible at the
 * call site and there is no SDK version to drift. Anthropic uses its official
 * SDK, which carries two things worth the dependency here — typed error classes,
 * and the `refusal` stop reason, which has to be checked before reading content.
 */

export type Provider = "openai" | "google" | "anthropic";

export const MODEL_PROVIDERS: Record<string, Provider> = {
  "gpt-4o": "openai",
  "gpt-4o-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-4.1-mini": "openai",
  "gpt-4": "openai",
  "gpt-3.5-turbo": "openai",
  "gemini-1.5-pro": "google",
  "claude-haiku-4-5": "anthropic",
  "claude-opus-5": "anthropic",
};

/**
 * Model the API falls back to when Claude Opus 5 declines a request on policy
 * grounds. Without it a refused request simply stops with no answer.
 */
const OPUS_REFUSAL_FALLBACK = "claude-opus-4-8";

/** Lazily constructed so a missing key surfaces as our own error message. */
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env.local");
  }
  anthropicClient ??= new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  return anthropicClient;
}

export interface CallOptions {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  /** Request token logprobs where the provider supports them. */
  wantLogprobs?: boolean;
  /**
   * Ask the provider to emit a JSON object rather than only checking afterwards.
   * Used by the router's schema-repair attempt. OpenAI-only; ignored elsewhere.
   */
  jsonMode?: boolean;
  /** Extra system-role instruction, prepended ahead of the prompt. */
  systemInstruction?: string;
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

/** Bounded retry policy for the raw-fetch providers. */
export const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Honours `Retry-After`, which may be seconds or an HTTP date. Falls back to
 * exponential backoff with jitter, so concurrent callers do not resynchronise
 * onto the same retry instant.
 */
export function retryDelayMs(
  header: string | null,
  attempt: number,
  now: number = Date.now(),
): number {
  if (header) {
    const trimmed = header.trim();

    // A numeric header is delta-seconds and is never also a date. Checking the
    // shape first matters: Date.parse("-5") succeeds as a past date, which
    // would yield a 0ms delay and turn a retry into a hot loop.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (seconds >= 0) {
        return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
      }
    } else {
      const date = Date.parse(trimmed);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - now, 0), RETRY_MAX_DELAY_MS);
      }
    }
    // Anything else (negative seconds, unparseable text) falls through to
    // exponential backoff rather than being trusted.
  }

  const exponential = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * RETRY_BASE_DELAY_MS;
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

/** 429 is an outright rejection; 5xx usually means no work was done. Bounded above. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * POSTs with bounded retries on 429 and 5xx only.
 *
 * Deliberately does NOT retry network errors or timeouts. A timed-out request
 * may have been received and billed, so repeating it risks a duplicate charge.
 * A 429 is an outright rejection, so repeating it is safe. A 5xx usually means
 * the work was not done, but that is not guaranteed — the attempt bound is what
 * caps duplicate-charge exposure rather than eliminating it.
 */
async function postWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok || !isRetryableStatus(res.status)) return res;

    // Out of attempts — hand the final response back so the caller reports the
    // provider's own message rather than a generic "retries exhausted".
    if (attempt >= RETRY_MAX_ATTEMPTS - 1) return res;

    const delay = retryDelayMs(res.headers.get("retry-after"), attempt);
    console.warn(
      `[providers] ${label} ${res.status}; retry ${attempt + 1}/${
        RETRY_MAX_ATTEMPTS - 1
      } in ${Math.round(delay)}ms`,
    );
    // The body is discarded unread; nothing is retained between attempts, so
    // each retry is a fresh single request rather than a queued duplicate.
    await res.body?.cancel().catch(() => {});
    await sleep(delay);
  }
}

async function callOpenAI(options: CallOptions): Promise<ModelCall> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in .env.local");

  const startedAt = performance.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }
  messages.push({ role: "user", content: options.prompt });

  const res = await postWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        ...(options.wantLogprobs ? { logprobs: true } : {}),
        // json_object requires the word "json" somewhere in the messages; the
        // router's repair instruction always contains it.
        ...(options.jsonMode && supportsJsonMode(options.model)
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    },
    `openai ${options.model}`,
  );

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

  const res = await postWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: options.prompt }] }],
        ...(options.systemInstruction
          ? {
              systemInstruction: {
                parts: [{ text: options.systemInstruction }],
              },
            }
          : {}),
        generationConfig: {
          temperature: options.temperature,
          maxOutputTokens: options.maxTokens,
          ...(options.jsonMode
            ? { responseMimeType: "application/json" }
            : {}),
        },
      }),
    },
    `gemini ${options.model}`,
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

async function callAnthropic(options: CallOptions): Promise<ModelCall> {
  const client = getAnthropicClient();
  const startedAt = performance.now();

  // Opus 5 runs adaptive thinking by default. Low effort is the right setting
  // for short routed answers — it keeps thinking on (disabling it on Opus 5 has
  // its own failure modes) while holding token spend down. Haiku 4.5 rejects
  // `output_config`, so it gets neither field.
  const isOpus5 = options.model === "claude-opus-5";

  let message: Anthropic.Message;

  try {
    if (isOpus5) {
      // Server-side fallback: on a policy decline the API re-runs the same
      // request on the fallback model inside this one call.
      message = (await client.beta.messages.create({
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: OPUS_REFUSAL_FALLBACK }],
        messages: [{ role: "user", content: options.prompt }],
      })) as unknown as Anthropic.Message;
    } else {
      message = await client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        messages: [{ role: "user", content: options.prompt }],
      });
    }
  } catch (error) {
    // Typed classes, checked most specific first — never string-matched.
    if (error instanceof Anthropic.AuthenticationError) {
      throw new Error("ANTHROPIC_API_KEY was rejected");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new Error("Anthropic rate limit reached");
    }
    if (error instanceof Anthropic.APIError) {
      throw new Error(`Anthropic returned ${error.status}: ${error.message}`);
    }
    throw error;
  }

  const latency_ms = performance.now() - startedAt;

  const usage = {
    tokens_in: message.usage?.input_tokens ?? 0,
    tokens_out: message.usage?.output_tokens ?? 0,
  };

  // A refusal is a policy outcome, not a capability failure, so it is reported
  // as an error rather than escalated — sending it to a larger model would
  // spend more to be declined again.
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unspecified";
    throw new Error(`${options.model} declined this request (${category})`);
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return {
    model: options.model,
    text,
    usage,
    // The Messages API does not expose token logprobs at all, so the escalation
    // gate uses self-consistency for every Claude model.
    mean_logprob: null,
    latency_ms,
    cost_usd: computeCost(options.model, usage),
  };
}

export async function callModel(options: CallOptions): Promise<ModelCall> {
  const provider = MODEL_PROVIDERS[options.model];
  if (!provider) throw new Error(`Unsupported model "${options.model}"`);

  if (provider === "openai") return callOpenAI(options);
  if (provider === "google") return callGemini(options);
  return callAnthropic(options);
}

/** True when this model can supply the free logprob escalation signal. */
export function supportsLogprobs(model: string): boolean {
  return MODEL_PROVIDERS[model] === "openai";
}

/**
 * True when the model accepts `response_format: {type: "json_object"}`.
 * The legacy gpt-4 / gpt-3.5-turbo snapshots do not, so sending it would 400 —
 * for those the router's repair attempt falls back to instruction-only.
 */
export function supportsJsonMode(model: string): boolean {
  return (
    MODEL_PROVIDERS[model] === "openai" &&
    /^gpt-4(o|\.1)/.test(model)
  );
}
