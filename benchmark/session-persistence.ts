import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { newSession, PaceStore } from "../src/core/sessions.js";

// Local synthetic profiling only: no model calls and no writes to user sessions.
const iterations = Number(process.argv[2] ?? 12);
if (!Number.isSafeInteger(iterations) || iterations < 2 || iterations > 100) throw new Error("Iterations must be 2..100");
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
const root = await mkdtemp(join(tmpdir(), "pace-persistence-profile-"));
try {
  for (const count of [10, 100, 500]) {
    const store = new PaceStore(join(root, String(count)));
    const session = newSession(root, "auto");
    session.attempts = Array.from({ length: count }, (_, index) => ({
      id: `attempt-${index}`, taskId: "task", generation: 1, stage: "final", role: "main", status: "completed",
      route: {}, startedAt: "2026-10-22T00:00:00Z", result: "Result ".repeat(128),
      observations: Array.from({ length: 8 }, (_, item) => ({ kind: "activity", text: `${index}/${item}: ${"command output ".repeat(512)}` })),
    }));
    await store.saveChanges(session, false);
    const path = join(store.sessionDir(root), `${session.id}.json`);
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore, cloneCalls = 0, cloneMs = 0;
    const originalClone = globalThis.structuredClone;
    globalThis.structuredClone = (value, options) => {
      const started = performance.now();
      try { return originalClone(value, options); }
      finally { cloneCalls++; cloneMs += performance.now() - started; }
    };
    const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
    await new Promise(resolve => setImmediate(resolve));
    const cpuBefore = process.cpuUsage();
    const samples: number[] = [];
    try {
      for (let index = 0; index < iterations; index++) {
        const started = performance.now();
        session.attempts!.at(-1)!.observations.push({ kind: "activity", text: `Progress ${index}` });
        // A stale UI/side snapshot races a main progress save, as in production.
        const side = { ...session, sideAnswers: [...(session.sideAnswers ?? []), {
          id: `side-${index}`, attemptId: session.attempts![0]!.id, question: "Question", snapshotAt: "now", route: {}, result: "Answer",
        }] };
        await Promise.all([store.saveChanges(session, false), store.saveChanges(side, false)]);
        samples.push(performance.now() - started);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }
    } finally { globalThis.structuredClone = originalClone; }
    const cpu = process.cpuUsage(cpuBefore);
    await new Promise(resolve => setImmediate(resolve)); delay.disable();
    globalThis.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    const summariesStarted = performance.now();
    const summaries = await store.listSummaries(root);
    const summaryMs = performance.now() - summariesStarted;
    const saved = (await store.load(root, session.id))!;
    assert.equal(saved.attempts?.length, count);
    assert.equal(saved.sideAnswers?.length, iterations);
    assert.equal(saved.attempts?.at(-1)?.observations.length, 8 + iterations);
    assert.equal(saved.revision, 1 + iterations * 2);
    assert.equal(summaries.length, 1);
    console.log(JSON.stringify({ attempts: count, iterations, sessionBytes: (await stat(path)).size,
      sessionWrites: iterations * 2, pairP50Ms: percentile(samples, .5), pairP95Ms: percentile(samples, .95),
      cpuMs: (cpu.user + cpu.system) / 1000, cloneCalls, cloneMs,
      heapGrowthBytes: heapAfter - heapBefore, observedPeakHeapGrowthBytes: peakHeap - heapBefore,
      eventLoopP95Ms: delay.percentile(95) / 1e6, eventLoopMaxMs: delay.max / 1e6, summaryMs,
      gcAvailable: typeof globalThis.gc === "function", assertionsPassed: true }));
  }
} finally { await rm(root, { recursive: true, force: true }); }
