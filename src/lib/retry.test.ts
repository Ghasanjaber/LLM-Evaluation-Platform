import { describe, expect, it } from "vitest";
import { RETRY_MAX_ATTEMPTS, retryDelayMs } from "./providers";

/**
 * Unit tests — the retry delay policy.
 *
 * MOCKED, not live. The live run that motivated this code hit a real 3-RPM
 * limit on gpt-4o and lost 4 of 60 prompts; nothing here re-tests that against
 * the provider. These assert the delay arithmetic and the bounds only.
 */

describe("retryDelayMs — Retry-After as seconds", () => {
  it("honours an integer seconds header", () => {
    expect(retryDelayMs("20", 0)).toBe(20_000);
  });

  it("honours a fractional seconds header", () => {
    expect(retryDelayMs("0.5", 0)).toBe(500);
  });

  it("accepts zero as a legitimate instruction to retry immediately", () => {
    expect(retryDelayMs("0", 0)).toBe(0);
  });

  it("caps an absurd header rather than sleeping for an hour", () => {
    expect(retryDelayMs("3600", 0)).toBe(30_000);
  });

  it("ignores a negative header and falls back to backoff", () => {
    const delay = retryDelayMs("-5", 0);
    expect(delay).toBeGreaterThanOrEqual(1_000);
  });
});

describe("retryDelayMs — Retry-After as an HTTP date", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  it("computes the gap to a future date", () => {
    const delay = retryDelayMs("Tue, 13 Oct 2026 12:00:05 GMT", 0, now);
    expect(delay).toBe(5_000);
  });

  it("returns 0 for a date already in the past, never a negative sleep", () => {
    const delay = retryDelayMs("Tue, 13 Oct 2026 11:59:00 GMT", 0, now);
    expect(delay).toBe(0);
  });

  it("caps a far-future date", () => {
    const delay = retryDelayMs("Tue, 13 Oct 2026 23:00:00 GMT", 0, now);
    expect(delay).toBe(30_000);
  });
});

describe("retryDelayMs — exponential fallback when no header is sent", () => {
  it("grows with the attempt number", () => {
    // Jitter is bounded by one base delay, so the bands cannot overlap.
    const first = retryDelayMs(null, 0);
    const third = retryDelayMs(null, 2);
    expect(first).toBeGreaterThanOrEqual(1_000);
    expect(first).toBeLessThan(2_000);
    expect(third).toBeGreaterThanOrEqual(4_000);
    expect(third).toBeLessThan(5_000);
  });

  it("applies jitter, so concurrent callers do not resynchronise", () => {
    const samples = new Set(
      Array.from({ length: 24 }, () => retryDelayMs(null, 1)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });

  it("never exceeds the ceiling at high attempt counts", () => {
    expect(retryDelayMs(null, 20)).toBe(30_000);
  });

  it("ignores an unparseable header", () => {
    const delay = retryDelayMs("whenever you like", 0);
    expect(delay).toBeGreaterThanOrEqual(1_000);
    expect(delay).toBeLessThan(2_000);
  });
});

describe("retry bounds", () => {
  it("is bounded, so a persistently failing provider cannot loop forever", () => {
    expect(RETRY_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });

  it("has a worst-case wait that stays well inside a request timeout budget", () => {
    let worst = 0;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS - 1; attempt++) {
      worst += retryDelayMs(null, attempt);
    }
    expect(worst).toBeLessThan(10_000);
  });
});
