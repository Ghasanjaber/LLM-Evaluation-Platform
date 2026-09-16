import { DENSE_PROMPT_ASKS, LONG_PROMPT_CHARS } from "./config";
import type { HeuristicSignal, Stage1Result } from "./types";

/**
 * Stage 1 — heuristic rules.
 *
 * Deterministic, sub-millisecond, zero-cost checks on the raw prompt. A match
 * on code / multi-step / math short-circuits straight to Tier 2, so an
 * obviously complex prompt never pays for a Tier 1 call it was never going to
 * use. Everything else falls through to Stage 2.
 */

interface Rule {
  signal: HeuristicSignal;
  patterns: RegExp[];
}

/** Any match here routes direct to Tier 2. */
const DIRECT_T2_RULES: Rule[] = [
  {
    signal: "code",
    patterns: [
      /```/,
      /\bwrite\s+(?:a|an|the)?\s*(?:function|class|method|script|program|query)\b/i,
      /\b(?:def|func|function|class|import|#include|public\s+static|=>)\b/,
      /\b(?:refactor|debug|compile|stack\s?trace|regex|SQL|API\s+endpoint)\b/i,
    ],
  },
  {
    signal: "multi_step",
    patterns: [
      /\bstep[-\s]by[-\s]step\b/i,
      /\bfirst\b[\s\S]{0,80}\bthen\b/i,
      /\b(?:explain\s+your\s+reasoning|show\s+your\s+work|walk\s+me\s+through)\b/i,
      // Numbered sub-questions: "1. ... 2. ..."
      /(?:^|\n)\s*1[.)]\s+[\s\S]*?(?:\n)\s*2[.)]\s+/,
    ],
  },
  {
    signal: "math",
    patterns: [
      /\b(?:solve|prove|calculate|compute|derive|integrate|differentiate)\b/i,
      /\b(?:theorem|equation|derivative|integral|probability|matrix)\b/i,
      // Arithmetic between numerals, e.g. "12 * 4", "3^8", "(5+2)/7"
      /\d\s*[-+*/^]\s*\d/,
    ],
  },
];

/** Counts distinct asks, used only to mark a prompt structurally dense. */
function countAsks(prompt: string): number {
  const questionMarks = (prompt.match(/\?/g) ?? []).length;
  const bullets = (prompt.match(/(?:^|\n)\s*[-*•]\s+\S/g) ?? []).length;
  return questionMarks + bullets;
}

export function classifyStage1(prompt: string): Stage1Result {
  for (const rule of DIRECT_T2_RULES) {
    for (const pattern of rule.patterns) {
      const match = prompt.match(pattern);
      if (match) {
        return {
          route: "direct_t2",
          signal: rule.signal,
          matched: match[0].slice(0, 60),
        };
      }
    }
  }

  // Long or structurally dense prompts are not decided here — they are only
  // flagged, and the classifier makes the call.
  if (
    prompt.length > LONG_PROMPT_CHARS ||
    countAsks(prompt) >= DENSE_PROMPT_ASKS
  ) {
    return { route: "passed", signal: "long_or_dense", matched: null };
  }

  return { route: "passed", signal: "none", matched: null };
}
