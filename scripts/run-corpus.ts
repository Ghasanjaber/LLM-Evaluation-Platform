/**
 * Drives the 60-prompt corpus through the Cascade Router.
 *
 *   npm run corpus          dry run  — local routing decisions, no network, no cost
 *   npm run corpus -- --live live run — POSTs each prompt to a running /api/route
 *
 * The dry run needs no API key, because Stage 1 and Stage 2 make no network
 * calls. Use it to confirm the mix still exercises every path before spending
 * anything. The live run needs `npm run dev` up and OPENAI_API_KEY set.
 */

import corpus from "../src/lib/cascade/testing/corpus.json";
import { classifyStage1 } from "../src/lib/cascade/heuristics";
import { classifyStage2 } from "../src/lib/cascade/classifier";

type Path = "tier1" | "tier2_direct" | "tier2_classified";

interface Prompt {
  text: string;
  expect: Path;
  schema?: { type: "json"; required?: string[] };
}

const prompts = corpus.prompts as Prompt[];
const live = process.argv.includes("--live");
const BASE = process.env.CORPUS_BASE_URL ?? "http://localhost:3000";

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

async function dryRun() {
  console.log(`\nDRY RUN — ${prompts.length} prompts, no network calls\n`);

  const tally = { tier1: 0, tier2_direct: 0, tier2_classified: 0 };
  const misrouted: string[] = [];
  let stage2Total = 0;
  let stage2Count = 0;

  for (const prompt of prompts) {
    const stage1 = classifyStage1(prompt.text);
    let actual: Path;
    let detail: string;

    if (stage1.route === "direct_t2") {
      actual = "tier2_direct";
      detail = `S1:${stage1.signal}`;
    } else {
      const stage2 = await classifyStage2(prompt.text);
      stage2Total += stage2.latency_ms;
      stage2Count += 1;
      actual = stage2.route === "simple" ? "tier1" : "tier2_classified";
      detail = `S2:${stage2.route} p=${stage2.score?.toFixed(2) ?? "—"}`;
    }

    tally[actual] += 1;
    const ok = actual === prompt.expect;
    if (!ok) misrouted.push(`${prompt.text.slice(0, 56)} → ${actual}`);

    console.log(
      `  ${ok ? " " : "!"} ${pad(actual, 17)} ${pad(detail, 20)} ${prompt.text.slice(0, 50)}`,
    );
  }

  const n = prompts.length;
  console.log(`\n  Distribution`);
  for (const [key, count] of Object.entries(tally)) {
    console.log(`    ${pad(key, 18)} ${String(count).padStart(2)}  (${((count / n) * 100).toFixed(0)}%)`);
  }
  console.log(`    mean Stage 2 time  ${(stage2Total / Math.max(1, stage2Count)).toFixed(2)} ms`);

  const schemaCount = prompts.filter((p) => p.schema).length;
  console.log(`\n  Escalation-gate coverage`);
  console.log(`    ${schemaCount} prompts declare a JSON schema (feeds schema_fail)`);
  console.log(`    logprob_low fires opportunistically — Tier 1 is an OpenAI model`);

  if (misrouted.length) {
    console.log(`\n  ${misrouted.length} routed against intent (see KNOWN_MISROUTES in routing.golden.test.ts):`);
    for (const line of misrouted) console.log(`    ${line}`);
  }

  const covered = Object.values(tally).every((count) => count > 0);
  console.log(
    covered
      ? `\n  Mix exercises all three pre-model paths.\n`
      : `\n  WARNING: mix does not cover all three paths.\n`,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Seconds to wait from a 429 body. New OpenAI projects sit at 3 requests per
 * minute on the larger models, which the first live run hit on 4 of 60
 * prompts. The provider states a retry delay; honour it rather than guessing.
 */
function retryDelayMs(message: string): number {
  const stated = message.match(/try again in ([\d.]+)s/i);
  return stated ? Math.ceil(Number(stated[1]) * 1000) + 500 : 20_000;
}

async function liveRun() {
  console.log(`\nLIVE RUN — ${prompts.length} prompts against ${BASE}/api/route\n`);

  interface RouteResult {
    tier_called: number;
    escalated: boolean;
    escalation_reason: string | null;
    latency_ms: number;
    cost_usd: number;
  }

  const results: RouteResult[] = [];
  let failed = 0;
  let retries = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const label = `[${String(i + 1).padStart(2)}/${prompts.length}]`;

    let res: Response | undefined;
    let body: Record<string, unknown> | undefined;

    // Up to 4 attempts, waiting as long as the provider asks.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(`${BASE}/api/route`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.text,
            ...(prompt.schema ? { schema: prompt.schema } : {}),
            max_tokens: 120,
          }),
        });
        body = await res.json();
      } catch (error) {
        failed += 1;
        console.log(`  ${label} failed: ${error instanceof Error ? error.message : error}`);
        break;
      }

      const message = typeof body?.error === "string" ? body.error : "";

      // A missing or rejected key fails identically every time — stop rather
      // than write 60 copies of the same failure into the request log.
      if (message.includes("API_KEY")) {
        console.log(`\n  Aborting: ${message}\n`);
        process.exit(1);
      }

      if (res.ok || !message.includes("429")) break;

      const wait = retryDelayMs(message);
      retries += 1;
      console.log(`  ${label} rate limited, waiting ${(wait / 1000).toFixed(0)}s…`);
      await sleep(wait);
    }

    try {
      if (!res || !body) continue;

      if (!res.ok) {
        failed += 1;
        console.log(`  ${label} HTTP ${res.status}  ${body?.error ?? "unknown"}`);
        continue;
      }

      const result = body as unknown as RouteResult;
      results.push(result);
      console.log(
        `  ${label} tier ${result.tier_called}` +
          (result.escalated ? ` esc(${result.escalation_reason})` : "            ") +
          `  ${String(result.latency_ms).padStart(5)}ms  $${result.cost_usd.toFixed(6)}  ` +
          prompt.text.slice(0, 40),
      );
    } catch (error) {
      failed += 1;
      console.log(`  ${label} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  const spent = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const escalations = results.filter((r) => r.escalated).length;
  console.log(
    `\n  ${results.length} succeeded, ${failed} failed, ${retries} rate-limit retries.`,
  );
  console.log(`  ${escalations} escalated. $${spent.toFixed(5)} spent.`);
  console.log(`  Aggregated views: ${BASE}/api/metrics and ${BASE}/router\n`);
}

// Wrapped rather than top-level await: tsx transforms this file as CommonJS,
// which rejects top-level await.
(live ? liveRun() : dryRun()).catch((error) => {
  console.error(error);
  process.exit(1);
});
