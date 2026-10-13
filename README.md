# LLM Evaluation Platform

Compare LLM responses side by side, and route prompts through a two-tier
cost-aware cascade.

Next.js 15 (App Router) · TypeScript · Tailwind CSS.

## What's here

Two independent paths, deliberately kept separate:

| Path | Route | What it does |
|---|---|---|
| **Side-by-side comparison** | `/` → `POST /api/evaluate` | Sends one prompt to every selected model in parallel and shows each response with its latency. |
| **Cascade Router** | `/router` → `POST /api/route` | Sends one prompt through a two-tier router that sends most traffic to a cheap model and escalates to an expensive one only on objective signals. Reports cost, latency percentiles and escalation rate. |

The router is opt-in and does not replace comparison mode — see
[docs/architecture/cascade-router.md](docs/architecture/cascade-router.md) for
the design, including the implementation map and a list of where the code
deviates from the spec.

Comparison mode fans out to `claude-opus-5` (Anthropic), `gpt-4o`,
`gpt-4o-mini` (OpenAI) and `gemini-1.5-pro` (Google).

The router's tiers are `gpt-4o-mini` → `gpt-4o` — a 16.7x list-price ratio, and
OpenAI exposes token logprobs, which keeps the escalation gate's free
`logprob_low` signal available. Note `gpt-4` is deliberately not a tier: it is
listed by `/v1/models` but returns 404 to project-scoped (`sk-proj-…`) keys, so
the tiers were chosen by probing the key directly.

Pointing a tier at a Claude model is a one-line change in
`src/lib/cascade/config.ts`, but it costs you that free signal: Anthropic's
Messages API exposes no logprobs, so every gate check falls through to
self-consistency and pays one extra Tier 1 call.

## Setup

Requires Node.js 18+ (developed on Node 24).

```bash
npm install
cp .env.example .env.local   # then add your keys
npm run dev
```

Open <http://localhost:3000>.

### API keys

Both are optional, but a model with no key returns an error in its result card
rather than a response.

| Variable | Needed for | Get one |
|---|---|---|
| `OPENAI_API_KEY` | the Cascade Router (both tiers), plus `gpt-4` and `gpt-3.5-turbo` in comparison mode | <https://platform.openai.com/api-keys> |
| `ANTHROPIC_API_KEY` | `claude-opus-5` in comparison mode | <https://console.anthropic.com/settings/keys> |
| `GOOGLE_API_KEY` | `gemini-1.5-pro` in comparison mode | <https://aistudio.google.com/apikey> |

`OPENAI_API_KEY` is the one to set first — without it the router cannot run at
all, since both of its tiers are OpenAI models.

`.env.local` is gitignored. Don't commit real keys.

### Train the Stage 2 classifier

The Cascade Router's classifier ships untrained. Without weights it reports
cold start and conservatively routes everything to Tier 2 — correct behaviour,
but it means near-zero measured savings. To fit the seed model:

```bash
npm run train:classifier
```

This writes `src/lib/cascade/classifier-weights.json` from the labeled prompts
in `src/lib/cascade/training/seed-prompts.json`. It is deterministic — the same
seed set yields the same weights. Add your own labeled examples to that file and
re-run to improve it; the design document targets 200–500 examples and the seed
set currently has ~150.

## Measured results

From **155 real requests** against the OpenAI API on 13 Oct 2026, tiers
`gpt-4o-mini` → `gpt-4o`. Every figure is labelled by how it was obtained.

| Result | Value | Status |
|---|---|---|
| Routed spend | $0.0318 | **measured** |
| Naive always-Tier-2 baseline | $0.0523 | **extrapolated from 4 shadow samples** |
| Cost saving | **roughly 40%** | **estimate** — see caveat below |
| Fast-path share, distinct corpus | **52%** (31 of 60 prompts) | **measured** |
| Escalation rate | 6.5% (8 of 124 Tier 1 attempts) | **measured** |
| Latency p50 / p95 — fast path | 856 / 1461 ms | **measured** |
| Latency p50 / p95 — escalated | 1499 / 1821 ms | **measured** |
| Latency p50 / p95 — blended | 908 / 1673 ms | **measured** |

**The savings figure is an estimate, not a measurement.** It rests on **four**
shadow samples extrapolated across 116 fast-path requests. The direction is
sound; the precision is not. Quote it as "roughly 40%", never as 39.1%.

**Use 52% for the fast-path share, not the 74.8% the dashboard shows.** The
logged 155 requests include three repeated passes over the 30 simple prompts,
run deliberately to make 5% shadow sampling fire at all. That repetition skews
the live distribution toward the fast path. 52% is the share over the distinct
60-prompt corpus and is the honest number.

### Two findings from the live run

**The log-probability gate is implemented but was never observed firing.**
Across 155 requests no answer was ever uncertain enough to trip τ = −1.0; all 8
escalations were `schema_fail`. This was diagnosed as a *threshold* problem, not
a wiring bug: had logprobs been absent, the gate would have fallen through to
self-consistency on every fast-path request and doubled the Tier 1 calls, but
0 of 116 fast-path rows show doubled token counts and there are 0 `inconsistent`
escalations. The values were present and read, and simply never fell below τ.
**τ is uncalibrated for this model and workload** and has been left unchanged
pending calibration.

**Escalation did not reliably repair schema failures.** Asked for output
matching `^[A-Z]{2}$`, `gpt-4o` returned
`The ISO 3166-1 alpha-2 code for Norway is "NO".` — prose, exactly as the small
model had. A format miss is not a capability gap, so a larger model is the wrong
remedy — the router was paying the expensive tier to reproduce the same failure.
(`gpt-4o` : `gpt-4o-mini` is a 16.7x *list-price* ratio; that is not a measured
per-request cost.)

**Remediation now implemented:** on a `schema_fail`, the router makes **one**
bounded constrained retry at Tier 1 — temperature 0, the constraint restated as
a system instruction, and `response_format: json_object` where the model
supports it — before escalating. Success is recorded as `schema_repaired: true`
and no Tier 2 call is made; failure escalates as before with
`schema_repaired: false`. Bounded by `SCHEMA_REPAIR_ATTEMPTS` (default 1) so a
model that cannot satisfy a schema cannot drive an unbounded spend loop.

This control flow is **covered by mocked tests only.** Whether a real model
obeys the repair instruction often enough to pay for itself is **not yet
measured** — the live numbers above predate the change.

### Rate-limit handling

The first live run lost 4 of 60 prompts to a 3-requests-per-minute cap on
`gpt-4o`; the raw-`fetch` adapters had no retry at all. They now retry with
bounded backoff:

- At most **3 attempts** per request.
- `Retry-After` is honoured, as either delta-seconds or an HTTP date, capped at 30s.
- Otherwise exponential backoff with jitter (1s, 2s, 4s + jitter), capped at 30s.
- **Only `429` and `5xx` are retried.** Network errors and timeouts are not: a
  timed-out request may have been received and billed, so repeating it risks a
  duplicate charge. A `429` is an outright rejection, so repeating it is safe. A
  `5xx` usually means the work was not done, but that is not guaranteed — the
  3-attempt bound is what caps the duplicate-charge exposure, rather than
  eliminating it.
- Exhausted retries return the provider's own final response, so the reported
  error stays specific rather than becoming "retries exhausted".

Verified by unit tests against the delay policy. **Not re-verified against a
live 429** — the original failure is what motivated the code, and reproducing it
on purpose would mean deliberately burning rate limit.

## Testing

```bash
npm test          # 136 tests, ~250ms, no network, no API key
npm run corpus    # routing decisions over the 60-prompt corpus, also offline
```

Four layers, each covering what the one below it cannot.

| Layer | Files | What it covers |
|---|---|---|
| **Unit** | `heuristics`, `embedding`, `classifier`, `escalation`, `pricing`, `metrics`, `retry` `.test.ts` | Pure logic in isolation: every Stage 1 rule in both directions, embedder determinism and L2 normalisation, sigmoid overflow, each escalation signal, cost arithmetic, percentile edge cases, and the retry delay policy including `Retry-After` parsing and bounds. |
| **Behavioural** | `escalation.test.ts` | Signal *ordering*. Free checks must settle the decision before self-consistency runs, because that one costs a second Tier 1 call. Asserted with a spy that fails the test if it is reached. |
| **Golden output** | `routing.golden.test.ts` | The aggregate routing distribution over all 60 prompts, pinned to `{31, 15, 14}`. Cost follows directly from those three numbers, so a drift in routing is a drift in the savings claim. |
| **Integration** | `router.test.ts`, `repair.test.ts` | The orchestrator with the provider layer mocked: decision → correct model called, every caused call billed, exactly one log row per path, the log field set checked against the design document, and the full schema-repair control flow (success, failure, boundedness, and the cases where repair must not fire). |

**All failure scenarios are mocked.** No test contacts a provider, so none of
them cost credits, and none of them constitute evidence about live model
behaviour.

Two properties the suite is built around:

- **No test touches a provider.** API keys are blanked in `vitest.config.mts`; a test that reaches the network is a failing test. The whole suite runs offline in under a second.
- **Cost-only regressions are catchable.** Verified by mutation: removing the escalation gate's short-circuit on healthy logprobs changes no output and doubles fast-path cost. Four tests across two files fail.

### The known classifier defect

`routing.golden.test.ts` carries a `KNOWN_MISROUTES` map of five prompts the
Stage 2 classifier routes against intent. Every complex example in the training
set opens with an imperative (*Compare, Assess, Evaluate, Discuss*), so the
model learned "imperative verb ⇒ complex" and trips on "Return", "List" and
"Fix". Holdout accuracy of 86.7% did not surface this; running the corpus did.

The map is deliberately not a relabelling of the corpus. The test fails on a
*new* misroute, and also fails when one is *fixed* — so the defect list and the
training data stay honest about each other.

### Not tested, and why

| Not covered | Why, and the risk accepted |
|---|---|
| Answer **quality** at either tier | The router's core premise — that the cheap tier is good enough for "simple" prompts — is **entirely unverified**. There is no eval of answer correctness, and no check that escalating produces a better answer. **The biggest accepted risk in the project.** |
| Whether schema repair actually works on live models | The control flow is covered by mocked tests. Its real-world success rate is **unmeasured**, so the claim that it is cheaper than escalating is reasoned, not demonstrated. |
| Live 429 behaviour | The retry policy is unit-tested; it has **not** been re-run against a real rate limit. Reproducing one deliberately would mean burning quota. |
| Provider adapters against real APIs | Would need recorded fixtures or live keys. **Risk:** a provider changing its response shape breaks parsing and nothing here catches it. Mitigated only by the adapters being thin and failing loudly. |
| Anthropic adapter end to end | Never exercised with a live key. Its retry comes from the SDK rather than `postWithRetry`, so the two providers have **different** retry semantics — an asymmetry that is deliberate but untested. |
| React pages | Exercised by hand against the running app. No component tests. |
| Concurrency and load | Single-request paths only. Nothing verifies parallel load, and the retry jitter's purpose (desynchronising concurrent callers) is therefore unproven. |
| `logger.ts` on a serverless filesystem | Assumed to work on a persistent disk; unverified elsewhere. A serverless deploy needs a real datastore. |
| Pricing accuracy | Anthropic rates came from a published table; OpenAI and Google rates are hand-entered and unchecked. A test can confirm the arithmetic, never the inputs. |
| Classifier quality beyond the corpus | 86.7% holdout on 149 examples, below the 200–500 the design targets, and it overfits (100% train). Five known misroutes are tracked in `KNOWN_MISROUTES`. |

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run format:fix` | Prettier |
| `npm run train:classifier` | Fit and write the Stage 2 route classifier |
| `npm test` | Full suite (136 tests, offline) |
| `npm run test:watch` | Suite in watch mode |
| `npm run corpus` | Routing decisions over the corpus; `-- --live` to hit a running server |

## Project layout

```
src/
  app/
    page.tsx                    side-by-side comparison UI
    router/page.tsx             cascade router console + metrics
    api/evaluate/route.ts       fan-out to every selected model
    api/route/route.ts          cascade router entry point
    api/metrics/route.ts        the four observability views
  lib/
    providers.ts                OpenAI + Gemini adapters (usage, logprobs)
    cascade/
      router.ts                 orchestration
      heuristics.ts             Stage 1 — deterministic rules
      embedding.ts              local hashing embedder
      classifier.ts             Stage 2 — logistic regression
      escalation.ts             schema / logprob / self-consistency gate
      metrics.ts                cost, latency, escalation, tier views
      logger.ts                 append-only request log
      config.ts                 tunables and pricing
      types.ts                  shared types + log schema
scripts/
  train-classifier.ts           classifier trainer
docs/architecture/
  cascade-router.md             design document
```

## Caveats

- **Pricing is hand-entered.** `src/lib/cascade/config.ts` carries
  per-million-token rates with a `PRICING_LAST_VERIFIED` marker that currently
  reads "not yet verified". Cost and savings figures inherit that caveat until
  you check the rates against the providers' pricing pages.
- **The request log is local JSONL** at `.data/requests.jsonl` (gitignored). It
  assumes a persistent filesystem; a serverless deploy needs a real datastore in
  place of `src/lib/cascade/logger.ts`.
- **The savings baseline is extrapolated** from 5% shadow sampling, not measured
  across all traffic. The console labels it as such.
