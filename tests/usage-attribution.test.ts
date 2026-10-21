import { describe, expect, it } from "vitest";
import { AppServerRunner } from "../src/integrations/app-server-runner.js";
import { CodexRunError, type Progress } from "../src/integrations/codex-types.js";
import type { Route } from "../src/shared/types.js";

type Message = { method: string; params: unknown };
const route: Route = { model: "gpt-6-sol", effort: "medium" };
const billing = (inputTokens = 100, outputTokens = 20) => ({
  totalTokens: inputTokens + outputTokens,
  inputTokens, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens, reasoningOutputTokens: 2,
});
const reading = (total = 120, input = 100, output = 20, turnId: unknown = "current", threadId: unknown = "thread") => ({
  method: "thread/tokenUsage/updated", params: { threadId, turnId,
    tokenUsage: { total: { totalTokens: total }, last: billing(input, output), modelContextWindow: 1000 } },
});
const completed = (id = "current", status = "completed", extra: Record<string, unknown> = {}): Message => ({
  method: "turn/completed", params: { threadId: "thread", turn: { id, status, ...extra } },
});
const started = (id = "current"): Message => ({ method: "turn/started", params: { threadId: "thread", turn: { id } } });
function fixture(events: Message[], options: { response?: unknown; resume?: Message[]; previousTurns?: string[]; afterStart?: (emit: (message: Message) => void) => void; compact?: boolean } = {}) {
  const requests: { method: string; params: unknown }[] = [];
  const runner = new AppServerRunner(emit => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") {
        for (const message of options.resume ?? []) emit(message);
        return { thread: { id: "thread", turns: options.previousTurns?.map(id => ({ id })) ?? [] } };
      }
      if (method === "turn/start" || method === "thread/compact/start") {
        // Emitting synchronously exercises notifications before RPC resolution.
        for (const message of events) emit(message);
        if (options.afterStart) setImmediate(() => options.afterStart!(emit));
        return options.response ?? (options.compact ? {} : { turn: { id: "current" } });
      }
      return {};
    },
  }));
  return { runner, requests };
}
const run = (runner: AppServerRunner, selected = route, signal?: AbortSignal, progress: Progress[] = []) =>
  runner.run("work", process.cwd(), selected, "thread", event => { progress.push(event); }, signal);

describe("App Server usage attribution", () => {
  it("binds early events to response turn and ignores delayed previous-turn usage", async () => {
    const { runner } = fixture([
      reading(1000, 800, 200, "previous"), completed("previous"),
      reading(1120), completed(),
    ], { resume: [reading(1000, 800, 200, "previous")] });
    const result = await run(runner);
    expect(result).toMatchObject({ threadId: "thread", turnId: "current", route,
      usageComplete: true, usage: { input_tokens: 100, output_tokens: 20 } });
    expect(result.context).toEqual({ tokens: 120, windowTokens: 1000, model: route.model });
  });

  it("does not charge delayed Sol usage to Luna or delayed Luna usage to Sol", async () => {
    const routes: Route[] = [route, { model: "gpt-6-luna", effort: "low" }, route];
    const results = [];
    for (const [index, selected] of routes.entries()) {
      const { runner, requests } = fixture([reading(5000 + index, 1000, 200, "previous"), reading(6000 + index), completed()]);
      results.push(await run(runner, selected));
      expect(requests.find(request => request.method === "turn/start")?.params).toMatchObject({ model: selected.model, threadId: "thread" });
      expect(requests.some(request => request.method === "thread/start")).toBe(false);
    }
    expect(results.map(result => result.route)).toEqual(routes);
    for (const result of results) expect(result.usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });

  it("deduplicates requests, preserves equal-sized distinct calls and replaces updated readings", async () => {
    const { runner } = fixture([
      reading(120), reading(120), reading(240),
      reading(240, 90, 30), // corrected reading for same cumulative request
      completed(),
    ]);
    const result = await run(runner);
    expect(result.usage).toMatchObject({ input_tokens: 190, output_tokens: 50 });
    expect(result.knownUsage).toEqual(result.usage);
  });

  it("preserves out-of-order distinct model requests without replacing newest context", async () => {
    const { runner } = fixture([reading(240, 200, 40), reading(120), completed()]);
    const result = await run(runner);
    expect(result.usage).toMatchObject({ input_tokens: 300, output_tokens: 60 });
    expect(result.context?.tokens).toBe(240);
  });

  it("ignores events identified with a different thread", async () => {
    const { runner } = fixture([reading(5000, 4000, 1000, "current", "other"), reading(), completed()]);
    expect((await run(runner)).usage).toMatchObject({ input_tokens: 100 });
  });

  it.each([
    [undefined, "thread"], ["current", undefined], [null, "thread"], [7, "thread"], ["current", 7],
  ])("keeps subtotal but full cost unknown with malformed identity %j/%j", async (turnId, threadId) => {
    const bad = reading(240, 200, 40);
    bad.params.turnId = turnId;
    bad.params.threadId = threadId;
    const { runner } = fixture([reading(), bad, completed()]);
    const result = await run(runner);
    expect(result.usage).toBeUndefined();
    expect(result.usageComplete).toBe(false);
    expect(result.knownUsage).toMatchObject({ input_tokens: 100 });
  });

  it.each(["cachedInputTokens", "cacheWriteInputTokens", "inputTokens", "outputTokens", "reasoningOutputTokens"])(
    "does not invent zero for missing billing field %s", async key => {
      const bad = reading(240, 200, 40);
      delete (bad.params.tokenUsage.last as Record<string, unknown>)[key];
      const { runner } = fixture([reading(), bad, completed()]);
      const result = await run(runner);
      expect(result.usage).toBeUndefined();
      expect(result.knownUsage).toMatchObject({ input_tokens: 100 });
      expect(result.usageComplete).toBe(false);
    },
  );

  it.each([-1, NaN, Infinity, "240"])("rejects unusable cumulative total %j", async total => {
    const bad = reading(240);
    (bad.params.tokenUsage.total as Record<string, unknown>).totalTokens = total;
    const { runner } = fixture([reading(), bad, completed()]);
    expect(await run(runner)).toMatchObject({ usageComplete: false, knownUsage: { input_tokens: 100 } });
  });

  it("leaves measurement unknown when no usage arrives", async () => {
    const result = await run(fixture([completed()]).runner);
    expect(result.usage).toBeUndefined();
    expect(result.knownUsage).toBeUndefined();
    expect(result.usageComplete).toBe(false);
  });

  it("uses matching completion fallback once when no request usage exists", async () => {
    const { runner } = fixture([completed("current", "completed", { usage: billing() })]);
    expect(await run(runner)).toMatchObject({ usageComplete: true, usage: { input_tokens: 100, output_tokens: 20 } });
  });

  it("does not add completion fallback to already observed requests", async () => {
    const { runner } = fixture([reading(), completed("current", "completed", { usage: billing(900, 100) })]);
    expect((await run(runner)).usage).toMatchObject({ input_tokens: 100, output_tokens: 20 });
  });

  it.each(["failed", "interrupted"])("retains attempt identities, route and usage after %s", async status => {
    const { runner } = fixture([reading(), completed("current", status, { error: { message: "stopped" } })]);
    await expect(run(runner)).rejects.toMatchObject({ message: "stopped", usage: { input_tokens: 100 },
      accounting: { threadId: "thread", turnId: "current", route, usageComplete: true, knownUsage: { input_tokens: 100 } } });
  });

  it("retains known subtotal on failure with incomplete measurement", async () => {
    const badRunner = fixture([reading(), { method: "thread/tokenUsage/updated", params: { threadId: "thread" } }, completed("current", "failed")]).runner;
    try { await run(badRunner); throw new Error("Expected failure"); } catch (error) {
      expect(error).toBeInstanceOf(CodexRunError);
      expect(error).toMatchObject({ accounting: { usageComplete: false, knownUsage: { input_tokens: 100 } } });
      expect((error as CodexRunError).usage).toBeUndefined();
    }
  });

  it("retains observed usage on cancellation and interrupts identified thread", async () => {
    const controller = new AbortController();
    const { runner, requests } = fixture([], { afterStart: emit => {
      emit(reading());
      controller.abort(new Error("cancelled"));
    } });
    await expect(run(runner, route, controller.signal)).rejects.toMatchObject({ message: "cancelled", usage: { input_tokens: 100 },
      accounting: { turnId: "current", route, usageComplete: true } });
    expect(requests.find(request => request.method === "turn/interrupt")?.params).toMatchObject({ threadId: "thread" });
  });

  it("does not terminate for errors belonging to other turns or retryable errors", async () => {
    const { runner } = fixture([
      { method: "error", params: { threadId: "thread", turnId: "previous", error: { message: "old" } } },
      { method: "error", params: { threadId: "thread", turnId: "current", error: { message: "retry" }, willRetry: true } },
      reading(), completed(),
    ]);
    expect((await run(runner)).completed).toBe(true);
  });

  it("does not price backend model rerouting using requested model rates", async () => {
    const { runner } = fixture([reading(),
      { method: "model/rerouted", params: { threadId: "thread", turnId: "current", fromModel: route.model, toModel: "other" } },
      reading(240), completed(),
    ]);
    const result = await run(runner);
    expect(result).toMatchObject({ usageComplete: false, knownUsage: { input_tokens: 100 } });
    expect(result.usage).toBeUndefined();
  });

  it("fails closed without turn/start identity", async () => {
    await expect(run(fixture([reading(), completed()], { response: {} }).runner)).rejects.toThrow("did not return a turn id");
  });

  it("rejects identity-free completion instead of treating it as success", async () => {
    const { runner } = fixture([{ method: "turn/completed", params: { turn: { status: "completed" } } }]);
    await expect(run(runner)).rejects.toThrow("missing thread or turn identity");
  });

  it("keeps source route snapshot when caller changes route later", async () => {
    const selected: Route = { ...route };
    const { runner } = fixture([], { afterStart: emit => { selected.model = "gpt-6-luna"; emit(reading()); emit(completed()); } });
    expect((await run(runner, selected)).route).toEqual(route);
  });
});

describe("identified native compaction accounting", () => {
  const item: Message = { method: "item/completed", params: { threadId: "thread", turnId: "current", item: { type: "contextCompaction", id: "compact" } } };
  it("binds usage before started notification and ignores previous turn", async () => {
    const { runner } = fixture([reading(1000, 800, 200, "previous"), reading(1120), started(), reading(1240), item, completed()], { compact: true });
    expect(await runner.compact("thread", process.cwd(), route, () => {})).toMatchObject({
      outcome: "completed", turnId: "current", route, usageComplete: true,
      usage: { input_tokens: 200, output_tokens: 40 },
    });
  });

  it("does not bind a delayed lifecycle event from resumed history", async () => {
    const { runner } = fixture([started("previous"), reading(1000, 800, 200, "previous"),
      started(), reading(1120), item, completed()], { compact: true, previousTurns: ["previous"] });
    const result = await runner.compact("thread", process.cwd(), route, () => {});
    expect(result).toMatchObject({ outcome: "completed", turnId: "current", usage: { input_tokens: 100 } });
  });

  it("keeps positive-context zero-billing placeholder unknown and preserves known subtotal", async () => {
    const placeholder = reading(200, 0, 0);
    placeholder.params.tokenUsage.last = { ...billing(0, 0), totalTokens: 100, cachedInputTokens: 0, reasoningOutputTokens: 0 };
    const { runner } = fixture([started(), reading(), placeholder, item, completed()], { compact: true });
    const result = await runner.compact("thread", process.cwd(), route, () => {});
    expect(result).toMatchObject({ outcome: "completed", usageComplete: false, knownUsage: { input_tokens: 100 } });
    expect(result.usage).toBeUndefined();
  });

  it("records cancellation subtotal without assigning previous-turn usage", async () => {
    const controller = new AbortController();
    const { runner } = fixture([started(), reading(1000, 800, 200, "previous"), reading(1120)], {
      compact: true, afterStart: () => controller.abort(),
    });
    const result = await runner.compact("thread", process.cwd(), route, () => {}, controller.signal);
    expect(result).toMatchObject({ outcome: "cancelled", turnId: "current", usageComplete: true, knownUsage: { input_tokens: 100 } });
  });
});
