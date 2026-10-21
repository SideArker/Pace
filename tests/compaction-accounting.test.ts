import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { compactSession, taskAccounting } from "../src/core/task-execution.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 };
for (const outcome of ["completed", "failed", "cancelled"] as const) it(`retains ${outcome} compaction subtotal while placeholder leaves full task cost unknown`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-compaction-ledger-")); roots.push(root);
  const store = new PaceStore(root); const session = newSession("/example/project", "manual");
  session.route = { model: "gpt-6.1-sol", effort: "medium" }; session.threadId = "main";
  const controller = new AbortController();
  const result = await compactSession(store, session, { compact: async () => {
    if (outcome === "cancelled") controller.abort();
    return { outcome, threadId: "main", turnId: "compaction", route: session.route, durationMs: 100, knownUsage: usage, usageComplete: false, ...(outcome === "failed" ? { error: "compaction failed" } : {}) };
  } }, () => {}, controller.signal);
  expect(result.outcome).toBe(outcome);
  const saved = (await store.load(session.projectPath, session.id))!;
  expect(saved.attempts).toHaveLength(1);
  expect(saved.compactions?.[0]).toMatchObject({ attemptId: saved.attempts![0]!.id, knownUsage: usage, usageComplete: false });
  expect(saved.attempts?.[0]?.pricing?.processing).toBe("standard");
  expect(taskAccounting(saved)).toMatchObject({ complete: false, totalUsd: undefined });
  expect(taskAccounting(saved).knownSubtotalUsd).toBeGreaterThan(0);
});

it("legacy turns keep full historical cost unknown after new measured attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-legacy-ledger-")); roots.push(root);
  const store = new PaceStore(root); const session = newSession("/example/project", "manual");
  session.turns = [{ prompt: "Earlier", result: "Done", at: "before ledger" }];
  await store.save(session);
  expect(session.accountingIncomplete).toBe(true);
  session.attempts = [{ id: "measured", taskId: "task", generation: 1, role: "main", stage: "final", status: "completed", route: {}, startedAt: "now", observations: [], usage, usageComplete: true, estimatedCostUsd: 1 }];
  expect(taskAccounting(session)).toMatchObject({ complete: false, knownSubtotalUsd: 1, totalUsd: undefined });
});
