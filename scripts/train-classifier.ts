/**
 * Trains the Stage 2 route classifier and writes classifier-weights.json.
 *
 *   npm run train:classifier
 *
 * Logistic regression with L2 regularisation over the local hashing embedder.
 * Deterministic: a fixed PRNG seed means the same seed set yields the same
 * weights, so a change in reported accuracy reflects a change in data or
 * hyperparameters rather than shuffle luck.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hashingEmbedder } from "../src/lib/cascade/embedding";
import { classifyStage1 } from "../src/lib/cascade/heuristics";
import type { ClassifierWeights } from "../src/lib/cascade/classifier";

const LEARNING_RATE = 0.5;
const EPOCHS = 4000;
const L2 = 1e-4;
const HOLDOUT_FRACTION = 0.2;
const SEED = 42;

interface Example {
  text: string;
  label: 0 | 1;
}

/** mulberry32 — small, deterministic PRNG so runs are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

const root = path.join(import.meta.dirname, "..");
const seedPath = path.join(
  root,
  "src/lib/cascade/training/seed-prompts.json",
);
const outPath = path.join(root, "src/lib/cascade/classifier-weights.json");

const raw = JSON.parse(readFileSync(seedPath, "utf8")) as {
  examples: Example[];
};

// Stage 2 only ever scores prompts that passed Stage 1. Training on prompts
// the heuristics would have caught teaches the classifier a distribution it
// never sees in production, so drop them.
const eligible: Example[] = [];
let droppedByStage1 = 0;

for (const example of raw.examples) {
  if (classifyStage1(example.text).route === "direct_t2") {
    droppedByStage1 += 1;
    continue;
  }
  eligible.push(example);
}

console.log(
  `Loaded ${raw.examples.length} labelled prompts; dropped ${droppedByStage1} ` +
    `already routed by Stage 1; ${eligible.length} usable for Stage 2.`,
);

if (eligible.length < 20) {
  console.error("Not enough usable examples to train. Aborting.");
  process.exit(1);
}

// Stratified split so both classes appear in the holdout set.
const random = makeRandom(SEED);
const simple = shuffle(
  eligible.filter((e) => e.label === 0),
  random,
);
const complex = shuffle(
  eligible.filter((e) => e.label === 1),
  random,
);

console.log(`Class balance: ${simple.length} simple / ${complex.length} complex.`);

function split(items: Example[]) {
  const holdoutSize = Math.max(1, Math.round(items.length * HOLDOUT_FRACTION));
  return {
    holdout: items.slice(0, holdoutSize),
    train: items.slice(holdoutSize),
  };
}

const simpleSplit = split(simple);
const complexSplit = split(complex);

const trainSet = shuffle(
  [...simpleSplit.train, ...complexSplit.train],
  random,
);
const holdoutSet = shuffle(
  [...simpleSplit.holdout, ...complexSplit.holdout],
  random,
);

const dim = hashingEmbedder.dim;
const trainVectors = trainSet.map((e) => hashingEmbedder.embed(e.text));
const holdoutVectors = holdoutSet.map((e) => hashingEmbedder.embed(e.text));

const weights = new Float64Array(dim);
let bias = 0;

for (let epoch = 0; epoch < EPOCHS; epoch++) {
  const gradW = new Float64Array(dim);
  let gradB = 0;

  for (let i = 0; i < trainSet.length; i++) {
    const vector = trainVectors[i];

    let z = bias;
    for (let d = 0; d < dim; d++) z += vector[d] * weights[d];

    const error = sigmoid(z) - trainSet[i].label;
    for (let d = 0; d < dim; d++) gradW[d] += error * vector[d];
    gradB += error;
  }

  const scale = LEARNING_RATE / trainSet.length;
  for (let d = 0; d < dim; d++) {
    weights[d] -= scale * gradW[d] + LEARNING_RATE * L2 * weights[d];
  }
  bias -= scale * gradB;
}

function accuracy(examples: Example[], vectors: Float64Array[]): number {
  if (examples.length === 0) return 0;

  let correct = 0;
  for (let i = 0; i < examples.length; i++) {
    let z = bias;
    for (let d = 0; d < dim; d++) z += vectors[i][d] * weights[d];
    const predicted = sigmoid(z) >= 0.5 ? 1 : 0;
    if (predicted === examples[i].label) correct += 1;
  }

  return correct / examples.length;
}

const trainAccuracy = accuracy(trainSet, trainVectors);
const holdoutAccuracy = accuracy(holdoutSet, holdoutVectors);

console.log(`Train accuracy:   ${(trainAccuracy * 100).toFixed(1)}%`);
console.log(
  `Holdout accuracy: ${(holdoutAccuracy * 100).toFixed(1)}% ` +
    `(n=${holdoutSet.length})`,
);

const payload: ClassifierWeights = {
  embedder_id: hashingEmbedder.id,
  weights: Array.from(weights),
  bias,
  trained_at: new Date().toISOString(),
  training_examples: trainSet.length,
  holdout_accuracy: holdoutAccuracy,
};

writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(root, outPath)}`);

if (eligible.length < 200) {
  console.warn(
    `\nNote: ${eligible.length} usable examples is below the 200-500 the ` +
      `design document calls for. Holdout accuracy is indicative only; ` +
      `classifier cold start remains an open question.`,
  );
}
