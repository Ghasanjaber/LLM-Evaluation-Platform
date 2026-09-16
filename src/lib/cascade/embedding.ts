/**
 * Local, dependency-free text embedder.
 *
 * Feature hashing (the "hashing trick") over word unigrams and bigrams,
 * projected into a fixed-width vector and L2-normalised. No network call and
 * no model download, which is the constraint the design document places on the
 * pre-query path: the router must never pay a network tax just to route.
 *
 * This is deliberately behind a narrow interface. Swapping in real sentence
 * embeddings (e.g. all-MiniLM-L6-v2 via transformers.js) means providing
 * another `Embedder` and leaving the classifier untouched — but note that the
 * trained weights are tied to the embedder, so changing it requires retraining.
 */

export const EMBEDDING_DIM = 512;

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): Float64Array;
}

/** FNV-1a, 32-bit. Fast, stable across runs, good enough for bucketing. */
function hash(token: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    value ^= token.charCodeAt(i);
    // 16777619, via shifts to stay in 32-bit range.
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s?!.'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Unigrams plus adjacent bigrams; bigrams carry short-phrase structure. */
function features(text: string): string[] {
  const words = tokenize(text);
  const out: string[] = [];

  for (const word of words) out.push(word);
  for (let i = 0; i + 1 < words.length; i++) {
    out.push(`${words[i]}_${words[i + 1]}`);
  }

  return out;
}

export const hashingEmbedder: Embedder = {
  id: `hashing-fnv1a-uni+bi-d${EMBEDDING_DIM}`,
  dim: EMBEDDING_DIM,

  embed(text: string): Float64Array {
    const vector = new Float64Array(EMBEDDING_DIM);

    for (const feature of features(text)) {
      const digest = hash(feature);
      const bucket = digest % EMBEDDING_DIM;
      // Signed hashing: the low bit picks a sign so collisions tend to cancel
      // rather than always reinforcing each other.
      const sign = (digest >>> 31) & 1 ? -1 : 1;
      vector[bucket] += sign;
    }

    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    }

    return vector;
  },
};
