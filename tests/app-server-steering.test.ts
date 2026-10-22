import { expect, it, vi } from "vitest";
import { AppServerRunner } from "../src/integrations/app-server-runner.js";
import type { Progress } from "../src/integrations/codex-types.js";

function fixture(reply: () => Promise<unknown> = async () => ({ turnId: "turn-1" })) {
  let emit!: (message: { method: string; params: unknown }) => void;
  const requests: { method: string; params: unknown }[] = [];
  const kill = vi.fn();
  const runner = new AppServerRunner(onMessage => {
    emit = onMessage;
    return {
      setRequestHandler() {}, notify() {}, respond() {}, kill,
      async request(method, params) {
        requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "thread-1" } };
        if (method === "turn/start") return { turn: { id: "turn-1" } };
        if (method === "turn/steer") return reply();
        return {};
      },
    };
  });
  const events: Progress[] = [];
  let steer: ((prompt: string) => Promise<void>) | undefined;
  const controller = new AbortController();
  const done = runner.run("work", process.cwd(), {}, undefined, event => {
    events.push(event);
    if (event.kind === "steering" && event.steer) steer = event.steer;
  }, controller.signal);
  return { requests, events, kill, done, controller,
    async ready() { await vi.waitFor(() => expect(steer).toBeTypeOf("function")); return steer!; },
    complete() { emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } }); },
  };
}

it("sends steering over the existing connection with thread and turn identity and image input", async () => {
  const env = fixture(); const steer = await env.ready();
  const prompt = "Inspect this [Pace image: /tmp/screenshot.png]";
  await steer(prompt);
  expect(env.requests.find(item => item.method === "turn/steer")?.params).toEqual({
    threadId: "thread-1", expectedTurnId: "turn-1",
    input: [{ type: "text", text: prompt }, { type: "localImage", path: "/tmp/screenshot.png" }],
  });
  expect(env.requests.filter(item => item.method === "turn/start")).toHaveLength(1);
  env.complete(); expect((await env.done).completed).toBe(true);
  expect(env.events.at(-1)).toEqual({ kind: "steering" });
  await expect(steer("too late")).rejects.toThrow("no longer accepting");
  expect(env.kill).toHaveBeenCalledOnce();
});

it("rejects steering when Codex declines or confirms a different turn", async () => {
  for (const reply of [async () => { throw new Error("no active turn"); }, async () => ({ turnId: "other-turn" })]) {
    const env = fixture(reply); const steer = await env.ready();
    await expect(steer("focus")).rejects.toThrow();
    env.complete(); await env.done;
  }
});

it("waits for in-flight steering acknowledgement when the turn completes first", async () => {
  let accept!: (value: unknown) => void;
  const env = fixture(() => new Promise(resolve => { accept = resolve; }));
  const steer = await env.ready();
  const pending = steer("focus"); env.complete();
  await Promise.resolve();
  expect(env.kill).not.toHaveBeenCalled();
  accept({ turnId: "turn-1" }); await pending; await env.done;
  expect(env.kill).toHaveBeenCalledOnce();
});

it("rejects steering after cancellation", async () => {
  const env = fixture(); const steer = await env.ready();
  const finished = expect(env.done).rejects.toThrow();
  env.controller.abort();
  await expect(steer("focus")).rejects.toThrow("no longer accepting");
  await finished;
});
