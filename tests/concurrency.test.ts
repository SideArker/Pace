import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PaceStore, newSession } from "../src/core/sessions.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import type { CodexRunner, Execution } from "../src/integrations/codex.js";

let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("runs separate conversations concurrently and keeps background saves from changing the selected conversation", async () => {
  directory = await mkdtemp(join(tmpdir(), "pace-concurrency-"));
  const store = new PaceStore(join(directory, "storage"));
  const config = { ...DEFAULT_CONFIG, skillFolder: null };
  const first = newSession(directory, "manual");
  const second = newSession(directory, "manual");
  first.route = { model: "gpt-6-sol", effort: "high" };
  second.route = { ...first.route };

  const pending = new Map<string, (value: Execution) => void>();
  let firstReady!: () => void;
  const firstStarted = new Promise<void>(resolve => { firstReady = resolve; });
  let started!: () => void;
  const bothStarted = new Promise<void>(resolve => { started = resolve; });
  const runner: CodexRunner = {
    run(prompt) {
      return new Promise<Execution>(resolve => {
        pending.set(prompt, resolve);
        if (prompt === "first") firstReady();
        if (pending.size === 2) started();
      });
    },
  };
  const orchestrator = new Orchestrator(store, runner, { choose: async () => { throw new Error("Manual routing must not call Vex"); } });
  let selected = first.id;
  const firstTurn = orchestrator.turn("first", first, config, () => {}, undefined, () => selected === first.id);
  await Promise.race([firstStarted, firstTurn.then(() => { throw new Error("First turn ended before Codex started"); })]);

  selected = second.id;
  await store.save(second);
  const secondTurn = orchestrator.turn("second", second, config, () => {}, undefined, () => selected === second.id);
  await Promise.race([bothStarted, secondTurn.then(() => { throw new Error("Second turn ended before Codex started"); })]);
  pending.get("first")!({ result: "first done", completed: true });
  await firstTurn;
  expect((await store.latest(directory))?.id).toBe(second.id);

  pending.get("second")!({ result: "second done", completed: true });
  await secondTurn;
  expect((await store.list(directory)).map(session => session.turns.at(-1)?.result).sort()).toEqual(["first done", "second done"]);
  expect((await store.latest(directory))?.id).toBe(second.id);
});

it("cancels one conversation without stopping another", async () => {
  directory = await mkdtemp(join(tmpdir(), "pace-concurrency-"));
  const store = new PaceStore(join(directory, "storage"));
  const config = { ...DEFAULT_CONFIG, skillFolder: null };
  const first = newSession(directory, "manual");
  const second = newSession(directory, "manual");
  first.route = { model: "gpt-6-sol", effort: "high" };
  second.route = { ...first.route };
  const controller = new AbortController();
  let ready!: () => void;
  const bothStarted = new Promise<void>(resolve => { ready = resolve; });
  let completeSecond!: (value: Execution) => void;
  let started = 0;
  const runner: CodexRunner = {
    run(prompt, _project, _route, _thread, _progress, signal) {
      return new Promise<Execution>((resolve, reject) => {
        if (prompt === "second") completeSecond = resolve;
        if (prompt === "first") signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        if (++started === 2) ready();
      });
    },
  };
  const orchestrator = new Orchestrator(store, runner, { choose: async () => { throw new Error("Manual routing must not call Vex"); } });
  const firstTurn = orchestrator.turn("first", first, config, () => {}, controller.signal);
  const secondTurn = orchestrator.turn("second", second, config, () => {});
  await bothStarted;
  controller.abort();
  await expect(firstTurn).rejects.toMatchObject({ name: "AbortError" });
  completeSecond({ result: "second done", completed: true });
  await expect(secondTurn).resolves.toMatchObject({ result: "second done" });
  expect((await store.list(directory)).find(session => session.id === first.id)?.turns.at(-1)?.failed).toBe(true);
});
