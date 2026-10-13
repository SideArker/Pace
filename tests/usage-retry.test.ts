import { expect, it, vi } from "vitest";
import { isUsageLimitError, networkReachable, transientRetryAt, transientRetryReason, usageRetryAt } from "../src/core/usage-retry.js";

it("recognizes a Codex usage limit without treating unrelated failures as retryable", () => {
  expect(isUsageLimitError("You've hit your usage limit. Try again at 8:21 PM.")).toBe(true);
  expect(isUsageLimitError("Rate limit exceeded")).toBe(true);
  expect(isUsageLimitError("Codex stream ended without turn.completed")).toBe(false);
});

it("uses the latest exhausted account window reset before retrying", () => {
  const now = new Date("2026-10-05T17:00:00Z");
  const retry = usageRetryAt("usage limit", {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now.getTime() / 1000 + 600 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now.getTime() / 1000 + 1200 },
  }, now);
  expect(retry.toISOString()).toBe("2026-10-05T17:20:05.000Z");
});

it("uses the error time when account reset data is unavailable", () => {
  const now = new Date(2026, 9, 5, 19, 0);
  const retry = usageRetryAt("Try again at 8:21 PM", undefined, now);
  expect(retry.getHours()).toBe(20);
  expect(retry.getMinutes()).toBe(21);
  expect(usageRetryAt("usage limit", undefined, now).getTime() - now.getTime()).toBe(5 * 60_000);
});

it("classifies connection and capacity failures and backs off capacity retries", () => {
  expect(transientRetryReason("Error: internet connection down")).toBe("network");
  expect(transientRetryReason("Error: fetch failed")).toBe("network");
  expect(transientRetryReason("Error: model at capacity")).toBe("capacity");
  expect(transientRetryReason("Invalid model selection")).toBeUndefined();
  const now = new Date("2026-10-13T00:00:00Z");
  expect(transientRetryAt("network", 8, now).getTime() - now.getTime()).toBe(15_000);
  expect(transientRetryAt("capacity", 1, now).getTime() - now.getTime()).toBe(10_000);
  expect(transientRetryAt("capacity", 8, now).getTime() - now.getTime()).toBe(120_000);
});

it("requires an HTTP response before retrying a connection failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await networkReachable()).toBe(false);
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch;
    expect(await networkReachable()).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
