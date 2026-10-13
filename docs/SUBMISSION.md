# Submission pack — LLM Evaluation Platform & Cascade Router

Reference sheet for the technical demo. Every figure is labelled by how it was
obtained: **measured**, **estimated**, **mocked**, or **unverified**.

---

## 1. Architecture overview

Two independent paths over one shared provider layer.

| Path | Entry | Purpose |
|---|---|---|
| Side-by-side comparison | `GET /` → `POST /api/evaluate` | Fans one prompt out to every selected model in parallel; reports each response with its latency. |
| Cascade Router | `GET /router` → `POST /api/route` | Answers each prompt with the cheapest model that can handle it, and records cost/latency/routing for every request. |

The router is opt-in and does not replace comparison mode (design doc §2,
non-goal 2).

### Router request flow

```
prompt
  │
  ├─ Stage 1  regex heuristics          no network, ~0 ms
  │     code fence / step markers / math ops ──► Tier 2 (never touches Tier 1)
  │
  ├─ Stage 2  logistic regression       no network, 0.07 ms warm
  │     over FNV-1a hashed embedding (512-dim)
  │     complex | cold start ──────────────────► Tier 2
  │     simple
  │
  ├─ Tier 1   gpt-4o-mini
  │
  ├─ Escalation gate (objective signals only, cheapest first)
  │     schema/format invalid ──► one bounded constrained retry at Tier 1
  │                                 └─ still invalid ──► Tier 2
  │     mean token logprob < τ ──► Tier 2
  │     two samples disagree  ──► Tier 2   (only when logprobs unavailable)
  │
  └─ Request logger — one row per request, every path
```

The defining constraint: **no LLM call is ever made whose only purpose is
deciding whether to make another LLM call.** Both pre-query stages are local.

### Key modules

| Concern | File |
|---|---|
| Orchestration, shadow sampling, schema repair | `src/lib/cascade/router.ts` |
| Stage 1 heuristics | `src/lib/cascade/heuristics.ts` |
| Stage 2 classifier / embedder | `src/lib/cascade/classifier.ts`, `embedding.ts` |
| Escalation gate | `src/lib/cascade/escalation.ts` |
| Provider adapters + bounded retry | `src/lib/providers.ts` |
| Metrics (four views) | `src/lib/cascade/metrics.ts` |
| Request log (schema in design doc §10) | `src/lib/cascade/logger.ts`, `types.ts` |
| Tunables, pricing, tier choice | `src/lib/cascade/config.ts` |

---

## 2. Measured results

155 real requests, OpenAI API, 13 Oct 2026. Tiers `gpt-4o-mini` → `gpt-4o`.

| Result | Value | Status |
|---|---|---|
| Routed spend | $0.0318 | measured |
| Naive always-Tier-2 baseline | $0.0523 | **estimated** — 4 shadow samples |
| Cost saving | **roughly 40%** | **estimated** |
| Fast-path share, distinct corpus | **52%** (31/60) | measured |
| Escalation rate | 6.5% (8 of 124 Tier 1 attempts) | measured |
| Model outputs retained for audit | none | the log stores no response text |
| p50 / p95 fast path | 856 / 1461 ms | measured |
| p50 / p95 escalated | 1499 / 1821 ms | measured |
| p50 / p95 blended | 908 / 1673 ms | measured |
| Stage 2 classification | 0.07 ms warm, 1.6 ms cold | measured |
| Classifier holdout accuracy | 86.7% (n=30, 149 examples) | measured |

**Three caveats that must be stated alongside these numbers:**

1. **Savings is an estimate from 4 shadow samples** extrapolated over 116
   fast-path requests. Direction sound, precision not. Say "roughly 40%".
2. **Use 52%, not the dashboard's 74.8%.** The logged 155 requests include three
   repeated passes over the 30 simple prompts, run deliberately to make 5%
   shadow sampling fire. That repetition skews the live distribution.
3. **These numbers predate the schema-repair change.** The repair path is not
   represented in them.

---

## 3. Test inventory

`npm test` — **136 tests, 10 files, ~250 ms, fully offline.** API keys are
blanked in `vitest.config.mts`; a test that reaches a provider is a failing test.

| File | Tests | Layer | Covers |
|---|---|---|---|
| `heuristics.test.ts` | 21 | unit | Every Stage 1 rule in both directions; over- and under-matching; empty input; case-insensitivity |
| `embedding.test.ts` | 10 | unit | Determinism, L2 normalisation, zero-vector on empty input, stable embedder `id` |
| `classifier.test.ts` | 8 | unit | Sigmoid overflow bounds, monotonicity, cold-start reporting, provenance, determinism |
| `escalation.test.ts` | 20 | unit + behavioural | Each signal; **signal ordering** — free checks must settle the decision before the paid resample, asserted with a spy that fails if reached |
| `pricing.test.ts` | 7 | unit | Cost arithmetic, linearity, unpriced-model fallback, and the invariant that Tier 1 is strictly cheaper than Tier 2 |
| `metrics.test.ts` | 21 | unit | Percentile edges; **honesty properties** — no baseline without a sample, null not zero on an empty log, negative savings surfaced not hidden |
| `retry.test.ts` | 14 | unit | `Retry-After` as seconds and as HTTP date, caps, jitter, bounded worst case |
| `router.test.ts` | 14 | integration (mocked) | Decision → correct model called; every caused call billed; one log row per path; log field set checked against design doc §10 |
| `repair.test.ts` | 13 | integration (mocked) | Full schema-repair flow: success avoids Tier 2, failure escalates, boundedness, and the three cases where repair must not fire |
| `routing.golden.test.ts` | 8 | golden output | Aggregate routing over all 60 corpus prompts pinned to `{31, 15, 14}`; Stage 1 set-equality; known-misroute tracking; Stage 2 latency budget |

### Why these layers

Unit tests catch rule errors. **Behavioural** tests catch cost regressions that
produce identical output — verified by mutation: removing the gate's
short-circuit on healthy logprobs changes no response and doubles fast-path
cost, and four tests across two files fail. **Golden output** pins the
distribution because cost follows directly from it. **Integration** tests catch
wiring the others cannot see.

### What each gate has actually caught

| Gate | Real defect it caught |
|---|---|
| Running the app | `/api/evaluate` carried a duplicate provider map; `claude-opus-5` returned `Unsupported model` while the router handled it. Typecheck and build both passed. |
| Live API run | `gpt-4` is listed by `/v1/models` but 404s for project-scoped keys — 29 of 60 calls failed. Tiers chosen by probing the key instead. |
| Live API run | No retry on 429; a 3 RPM cap lost 4 of 60 prompts. |
| Live API run | Escalation does not repair schema failures — `gpt-4o` returned prose for a `^[A-Z]{2}$` schema, same as the small model. |
| `npm test` | A negative `Retry-After` header fell through to `Date.parse("-5")`, which succeeds as a past date and yielded a **0 ms** delay — a hot-loop risk. |
| `npm test` | A test of mine asserted p50 of `[100,120]` was 120; nearest-rank makes it 100. The test was wrong, the code was right. |
| `tsc` | A type error in a test file that **passed at runtime**, because Vitest does not typecheck. |
| `next lint` | An unused parameter introduced by the fix for that. |

### Corpus (offline)

`npm run corpus` routes all 60 prompts with no network and no key, printing the
distribution and the five tracked misroutes. `-- --live` sends them to a running
server.

---

## 4. Known limitations

Ordered by how much they would matter in production.

1. **Answer quality is entirely unverified.** The router's core premise — that
   the cheap tier is good enough for "simple" prompts — has no eval behind it.
   Nothing checks that escalation produces a better answer. **The largest
   accepted risk.**
2. **Schema repair is unmeasured on live traffic.** Control flow is covered by
   mocked tests; its real hit rate is unknown, so "cheaper than escalating" is
   reasoned, not demonstrated.
3. **The savings figure rests on 4 shadow samples.** Wide uncertainty.
4. **The logprob gate has never been observed firing.** 0 of 8 escalations used
   it at τ = −1.0. Diagnosed as an uncalibrated threshold, not a wiring bug: 0 of
   116 fast-path rows show the doubled token counts that absent logprobs would
   have caused, and there are 0 `inconsistent` escalations.
5. **Classifier overfits.** 100% train against 86.7% holdout on 149 examples,
   below the 200–500 the design targets. Five misroutes are tracked in
   `KNOWN_MISROUTES`, with a diagnosed cause: every complex training example
   opens with an imperative, so the model learned "imperative ⇒ complex".
6. **Retry semantics differ by provider.** OpenAI and Gemini share
   `postWithRetry`; Anthropic inherits its SDK's policy. Deliberate, but not
   uniform — and the Anthropic path is untested end to end.
7. **Pricing is hand-entered.** Anthropic rates from a published table; OpenAI
   and Google unchecked. Tests confirm the arithmetic, never the inputs.
8. **The request log assumes a persistent filesystem.** A serverless deploy
   needs a real datastore in place of `logger.ts`.
9. **No concurrency or load testing.** The retry jitter's purpose — desyncing
   concurrent callers — is therefore unproven.

---

## 5. Reproducible demo

### Setup

```bash
git clone https://github.com/Ghasanjaber/LLM-Evaluation-Platform.git
cd LLM-Evaluation-Platform
npm install
cp .env.example .env.local      # add OPENAI_API_KEY
npm run train:classifier        # writes classifier-weights.json
npm run dev
```

`OPENAI_API_KEY` is the only key the router needs; both tiers are OpenAI.
Requires Node 18+ (developed on Node 24).

### Offline demo — no key, no spend

```bash
npm test          # 136 tests, ~250 ms
npm run corpus    # routing over 60 prompts, prints the 5 tracked misroutes
```

### Live demo

```bash
npm run dev                       # terminal 1
npm run corpus -- --live          # terminal 2 — ~$0.03, ~5 min at 3 RPM
```

Then at <http://localhost:3000/router>:

| Prompt | Expected path |
|---|---|
| `What is the capital of Norway?` | Tier 1 fast path |
| `Write a function that reverses a list` | Stage 1 → Tier 2, Tier 1 never called |
| `Give the ISO code for Norway` + regex `^[A-Z]{2}$` | schema fail → constrained retry → repaired or escalated |

The dashboard shows tier distribution, p50/p95/p99 by path, escalation rate by
reason, and the savings figure **with its `shadow-sampled, n=5%` label visible**.

### Reset

```bash
rm -rf .data        # clears the request log; the dashboard then claims no baseline
```

---

## 6. Where to read the reasoning

- `docs/architecture/cascade-router.md` — the design document. §5 carries the
  remedy-by-signal amendment; §11 lists **eleven** points where the
  implementation diverges from the spec, each with its reason.
- `README.md` — setup, measured results with caveats, testing strategy, and the
  "not tested, and why" table.
