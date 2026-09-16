import { CLASSIFIER_COMPLEX_THRESHOLD } from "./config";
import { hashingEmbedder, type Embedder } from "./embedding";
import type { Stage2Result } from "./types";

/**
 * Stage 2 — embedding classifier.
 *
 * Logistic regression over a local embedding. Its only job is a binary route
 * decision: simple (Tier 1) or complex (Tier 2). It makes no network call, by
 * design — a model call made purely to decide how to route reintroduces the
 * cost and latency problem the router exists to solve.
 *
 * With no trained weights available it reports `cold_start`, and the caller
 * applies the documented conservative default: route to Tier 2.
 */

export interface ClassifierWeights {
  /** Embedder the weights were trained against; a mismatch is a hard error. */
  embedder_id: string;
  weights: number[];
  bias: number;
  /** Provenance, so a stale classifier is recognisable in the dashboard. */
  trained_at: string;
  training_examples: number;
  /** Accuracy on a held-out split at training time. */
  holdout_accuracy: number;
}

let cachedWeights: ClassifierWeights | null = null;
let loadAttempted = false;

/**
 * Loads weights emitted by `npm run train:classifier`.
 * Absent weights are the expected cold-start state, not an error.
 */
async function loadWeights(): Promise<ClassifierWeights | null> {
  if (loadAttempted) return cachedWeights;
  loadAttempted = true;

  try {
    const imported = await import("./classifier-weights.json");
    const data = (imported.default ?? imported) as ClassifierWeights;

    if (!Array.isArray(data.weights) || typeof data.bias !== "number") {
      console.warn("[cascade] classifier weights malformed; using cold start");
      return null;
    }

    cachedWeights = data;
  } catch {
    // No weights file — cold start.
    cachedWeights = null;
  }

  return cachedWeights;
}

function sigmoid(z: number): number {
  // Split by sign to avoid overflow in Math.exp for large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function scoreWith(
  weights: ClassifierWeights,
  vector: Float64Array,
): number {
  let z = weights.bias;
  const limit = Math.min(vector.length, weights.weights.length);
  for (let i = 0; i < limit; i++) z += vector[i] * weights.weights[i];
  return sigmoid(z);
}

export async function classifyStage2(
  prompt: string,
  embedder: Embedder = hashingEmbedder,
): Promise<Stage2Result> {
  const startedAt = performance.now();
  const weights = await loadWeights();

  if (!weights) {
    return {
      route: "cold_start",
      score: null,
      latency_ms: performance.now() - startedAt,
    };
  }

  if (weights.embedder_id !== embedder.id) {
    // Weights are only meaningful for the embedder they were fitted on.
    console.warn(
      `[cascade] weights trained on "${weights.embedder_id}" but embedder is ` +
        `"${embedder.id}"; falling back to cold start. Retrain to fix.`,
    );
    return {
      route: "cold_start",
      score: null,
      latency_ms: performance.now() - startedAt,
    };
  }

  const score = scoreWith(weights, embedder.embed(prompt));

  return {
    route: score >= CLASSIFIER_COMPLEX_THRESHOLD ? "complex" : "simple",
    score,
    latency_ms: performance.now() - startedAt,
  };
}

/** Exposed for the dashboard so a cold-start or stale classifier is visible. */
export async function classifierStatus(): Promise<
  | { trained: false }
  | {
      trained: true;
      trained_at: string;
      training_examples: number;
      holdout_accuracy: number;
      embedder_id: string;
    }
> {
  const weights = await loadWeights();
  if (!weights) return { trained: false };

  return {
    trained: true,
    trained_at: weights.trained_at,
    training_examples: weights.training_examples,
    holdout_accuracy: weights.holdout_accuracy,
    embedder_id: weights.embedder_id,
  };
}
