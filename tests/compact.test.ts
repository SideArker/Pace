import { expect, it } from "vitest";
import { AppServerRunner } from "../src/integrations/codex.js";

const route = { model: "gpt-6-luna", effort: "low" } as const;

it("waits for the compaction item and completed turn, and accounts for its model calls", async () => {
  let emit!: (message: { method: string; params: unknown }) => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const requests: string[] = [];
  const runner = new AppServerRunner(onMessage => {
    emit = onMessage;
    return {
      setRequestHandler() {}, notify() {}, respond() {}, kill() {},
      async request(method: string) {
        requests.push(method);
        if (method === "thread/resume") return { thread: { id: "thread-1" } };
        if (method === "thread/compact/start") start();
        return {};
      },
    };
  });
  let settled = false;
  const pending = runner.compact("thread-1", process.cwd(), route, () => {}).then(result => {
    settled = true;
    return result;
  });
  await started;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(requests).toContain("thread/compact/start");
  emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-turn" } } });
  emit({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "compact-turn", tokenUsage: {
    total: { totalTokens: 120 }, last: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 1000,
  } } });
  emit({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "compact-turn", tokenUsage: {
    total: { totalTokens: 175 }, last: { inputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }, modelContextWindow: 1000,
  } } });
  emit({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-turn", item: { type: "contextCompaction", id: "compact-1" } } });
  await Promise.resolve();
  expect(settled).toBe(false);
  emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-turn", status: "completed" } } });
  const result = await pending;
  expect(result).toMatchObject({ threadId: "thread-1", outcome: "completed", usage: { input_tokens: 150, cached_input_tokens: 30, output_tokens: 15 } });
});

it("treats a completed turn without a compaction item as failed", async () => {
  let emit!: (message: { method: string; params: unknown }) => void;
  const runner = new AppServerRunner(onMessage => {
    emit = onMessage;
    return { setRequestHandler() {}, notify() {}, respond() {}, kill() {},
      async request(method: string) {
        if (method === "thread/resume") return { thread: { id: "thread-1" } };
        if (method === "thread/compact/start") queueMicrotask(() => {
          emit({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-turn" } } });
          emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-turn", status: "completed" } } });
        });
        return {};
      },
    };
  });
  const result = await runner.compact("thread-1", process.cwd(), route, () => {});
  expect(result.outcome).toBe("failed");
  expect(result.error).toContain("contextCompaction");
});

it("interrupts a cancelled compaction", async () => {
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const requests: string[] = [];
  const controller = new AbortController();
  const runner = new AppServerRunner(() => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      requests.push(method);
      if (method === "thread/resume") return { thread: { id: "thread-1" } };
      if (method === "thread/compact/start") start();
      return {};
    },
  }));
  const pending = runner.compact("thread-1", process.cwd(), route, () => {}, controller.signal);
  await started;
  controller.abort();
  expect((await pending).outcome).toBe("cancelled");
  expect(requests).toContain("turn/interrupt");
});
