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

Supported models: `gpt-4`, `gpt-3.5-turbo` (OpenAI) and `gemini-1.5-pro`
(Google).

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
| `OPENAI_API_KEY` | `gpt-4`, `gpt-3.5-turbo` | <https://platform.openai.com/api-keys> |
| `GOOGLE_API_KEY` | `gemini-1.5-pro` | <https://aistudio.google.com/apikey> |

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

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server (Turbopack) |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run format:fix` | Prettier |
| `npm run train:classifier` | Fit and write the Stage 2 route classifier |

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
