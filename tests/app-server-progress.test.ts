import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerProgress } from "../src/integrations/app-server-progress.js";
import { AppServerRunner } from "../src/integrations/app-server-runner.js";
import { durableRunner } from "../src/core/task-execution.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { taskSummary } from "../src/core/tasks.js";
import type { CodexRunner, Progress } from "../src/integrations/codex-types.js";
import { serverArgs } from "../src/integrations/app-server-process.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("planning retains native plan events and interactive questions inside the artifact-only sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-native-planning-")); roots.push(root);
  let requestHandler: (message: any) => void = () => {};
  const calls: { method: string; params: any }[] = [], progress: Progress[] = [], replies: unknown[] = [];
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler(handler) { requestHandler = handler; }, notify() {}, kill() {},
    respond(_id, value) {
      replies.push(value);
      queueMicrotask(() => onMessage({ method: "turn/completed", params: { threadId: "planning-thread", turn: { id: "planning-turn", status: "completed" } } }));
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "planning-thread" } };
      if (method === "turn/start") {
        queueMicrotask(() => {
          onMessage({ method: "turn/plan/updated", params: { threadId: "planning-thread", turnId: "planning-turn", plan: [{ step: "Inspect dependencies", status: "inProgress" }] } });
          requestHandler({ id: 9, method: "item/tool/requestUserInput", params: { questions: [{ id: "scope", question: "Which deployment target?", options: [{ label: "Local", description: "Local project" }] }] } });
        });
        return { turn: { id: "planning-turn" } };
      }
      return {};
    },
  }));
  await runner.run("Write a plan", process.cwd(), { model: "gpt-6.1-sol", effort: "medium" }, undefined, event => {
    progress.push(event);
    if (event.kind === "question") event.respond({ scope: { answers: ["Local"] } });
  }, undefined, "planning", [process.cwd()], "full-access", root);
  expect(progress.find(event => event.kind === "tasks")).toEqual({ kind: "tasks", items: [{ text: "Inspect dependencies", completed: false }] });
  expect(progress.some(event => event.kind === "question")).toBe(true);
  expect(replies).toEqual([{ answers: { scope: { answers: ["Local"] } } }]);
  expect(calls.find(call => call.method === "turn/start")?.params).toMatchObject({ cwd: root, approvalPolicy: "never", sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true } });
  expect(serverArgs()).toContain("default_mode_request_user_input");
});

it("streams a message snapshot under one ID and uses the completed text as authoritative", () => {
  const events = new AppServerProgress("/project");
  events.observe("item/started", { item: { id: "message", type: "agentMessage", text: "" } });
  expect(events.observe("item/agentMessage/delta", { itemId: "message", delta: "Checking " })).toEqual({ kind: "message", id: "message", text: "Checking ", completed: false });
  expect(events.observe("item/agentMessage/delta", { itemId: "message", delta: "files" })).toMatchObject({ text: "Checking files", completed: false });
  expect(events.observe("item/completed", { item: { id: "message", type: "agentMessage", text: "Checked files." } })).toEqual({ kind: "message", id: "message", text: "Checked files.", completed: true });
});

it("appends command output without losing its command and reconciles final output and exit status", () => {
  const events = new AppServerProgress("/project");
  events.observe("item/started", { item: { type: "commandExecution", id: "command", command: "npm test", status: "inProgress", aggregatedOutput: null } });
  expect(events.observe("item/commandExecution/outputDelta", { itemId: "command", delta: "first\n" })).toMatchObject({ id: "command", title: "Running: npm test", detail: "first\n", completed: false, outcome: undefined });
  expect(events.observe("item/commandExecution/outputDelta", { itemId: "command", delta: "second\n" })).toMatchObject({ detail: "first\nsecond\n" });
  expect(events.observe("item/completed", { item: { type: "commandExecution", id: "command", command: "npm test", aggregatedOutput: "final output", status: "failed", exitCode: 1 } })).toMatchObject({ title: "Failed: npm test (exit 1)", detail: "final output", completed: true, outcome: "failure" });
});

it("accumulates indexed summary sections, ignores raw reasoning, and accepts final string arrays", () => {
  const events = new AppServerProgress("/project");
  events.observe("item/started", { item: { type: "reasoning", id: "thinking", summary: ["First"], content: ["Raw reasoning must stay hidden"] } });
  events.observe("item/reasoning/summaryPartAdded", { itemId: "thinking", summaryIndex: 1 });
  events.observe("item/reasoning/summaryTextDelta", { itemId: "thinking", summaryIndex: 1, delta: "Second section" });
  expect(events.observe("item/reasoning/summaryTextDelta", { itemId: "thinking", summaryIndex: 0, delta: " section" })).toMatchObject({ id: "thinking", detail: "First section\n\nSecond section", completed: false });
  expect(events.observe("item/reasoning/textDelta", { itemId: "thinking", delta: "Raw reasoning" })).toBeUndefined();
  expect(events.observe("item/completed", { item: { type: "reasoning", id: "thinking", summary: ["Final section"], content: ["Raw reasoning"] } })).toMatchObject({ category: "thinking", detail: "Final section", completed: true });
});

it("reads structured summary text without using content or unknown summary types", () => {
  const events = new AppServerProgress("/project");
  expect(events.observe("item/completed", { item: { type: "reasoning", id: "thinking", summary: [
    { type: "summary_text", text: "Readable summary" }, { type: "reasoning_text", text: "Hidden" },
  ], content: ["Hidden"] } })).toMatchObject({ detail: "Readable summary" });
  for (const summaryIndex of [-1, 0.5, Infinity, "0"]) {
    expect(events.observe("item/reasoning/summaryTextDelta", { itemId: "thinking", summaryIndex, delta: "Invalid" })).toBeUndefined();
  }
});

it("maps published turn plans, including an empty replacement plan, to task snapshots", () => {
  const events = new AppServerProgress("/project");
  expect(events.observe("turn/plan/updated", { plan: [
    { step: "Inspect code", status: "completed" }, { step: "Implement", status: "inProgress" }, { step: "Verify", status: "pending" },
  ] })).toEqual({ kind: "tasks", items: [
    { text: "Inspect code", completed: true }, { text: "Implement", completed: false }, { text: "Verify", completed: false },
  ] });
  expect(events.observe("turn/plan/updated", { plan: [] })).toEqual({ kind: "tasks", items: [] });
  expect(events.observe("turn/plan/updated", { plan: null })).toBeUndefined();
});

it("forwards buffered streaming events only for the active turn and returns the completed message", async () => {
  const progress: Progress[] = [];
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method) {
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") {
        const identity = { threadId: "thread", turnId: "turn" };
        const send = (method: string, params: object) => onMessage({ method, params: { ...identity, ...params } });
        send("item/agentMessage/delta", { threadId: "another-thread", itemId: "message", delta: "Wrong thread" });
        send("item/agentMessage/delta", { turnId: "old-turn", itemId: "message", delta: "Old turn" });
        send("item/agentMessage/delta", { itemId: "message", delta: "Partial" });
        send("turn/plan/updated", { plan: [{ step: "Inspect", status: "inProgress" }] });
        send("item/completed", { item: { type: "agentMessage", id: "message", text: "Final" } });
        send("turn/completed", { turn: { id: "turn", status: "completed" } });
        return { turn: { id: "turn" } };
      }
      return {};
    },
  }));
  const result = await runner.run("Work", process.cwd(), {}, undefined, event => { progress.push(event); });
  expect(result.result).toBe("Final");
  expect(progress.filter(event => event.kind === "message")).toEqual([
    { kind: "message", id: "message", text: "Partial", completed: false },
    { kind: "message", id: "message", text: "Final", completed: true },
  ]);
  expect(progress).toContainEqual({ kind: "tasks", items: [{ text: "Inspect", completed: false }] });
});

for (const role of ["main", "verifier"] as const) it(`persists coalesced progress and the ${role} plan without changing another role's tasks`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-streaming-record-")); roots.push(root);
  const session = newSession(root, "manual");
  session.tasks = [{ id: "old", text: "Main plan", completed: false, source: "agent" }];
  const store = new PaceStore(join(root, "storage"));
  const events = new AppServerProgress(root);
  const runner: CodexRunner = { async run(_prompt, _project, _route, _thread, output) {
    const send = async (method: string, params: object) => {
      const event = events.observe(method, params);
      if (event) await output(event);
    };
    await send("item/started", { item: { type: "commandExecution", id: "command", command: "build", status: "inProgress" } });
    for (let index = 0; index < 100; index++) await send("item/commandExecution/outputDelta", { itemId: "command", delta: "x" });
    await send("item/completed", { item: { type: "commandExecution", id: "command", command: "build", aggregatedOutput: "Build passed", exitCode: 0, status: "completed" } });
    await send("item/reasoning/summaryTextDelta", { itemId: "thinking", summaryIndex: 0, delta: "Checking" });
    await send("item/completed", { item: { type: "reasoning", id: "thinking", summary: ["Checked build"] } });
    await send("item/agentMessage/delta", { itemId: "message", delta: "Do" });
    await send("item/completed", { item: { type: "agentMessage", id: "message", text: "Done" } });
    await send("turn/plan/updated", { plan: [{ step: "Build", status: "inProgress" }] });
    await send("turn/plan/updated", { plan: [{ step: "Build", status: "completed" }] });
    return { completed: true, result: "Done" };
  } };
  await durableRunner(runner, store, session, role, "final", false).run("Work", root, {}, undefined, () => {});
  const loaded = (await new PaceStore(store.baseDir).load(root, session.id))!;
  expect(loaded.attempts![0]!.observations).toEqual([
    { kind: "activity", text: "command: Ran: build (exit 0)\nBuild passed\nOutcome: success" },
    { kind: "activity", text: "thinking: Thinking\nChecked build" },
    { kind: "answer", text: "Done" },
    { kind: "tasks", items: [{ text: "Build", completed: true }] },
  ]);
  expect(taskSummary(role === "main" ? loaded.tasks : loaded.verifier!.tasks)).toBe("1. ✓ Build");
  if (role === "verifier") expect(loaded.tasks).toEqual(session.tasks);
});

it("retains the latest partial answer in a failed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-partial-record-")); roots.push(root);
  const store = new PaceStore(join(root, "storage")); const session = newSession(root, "manual");
  const runner: CodexRunner = { async run(_prompt, _project, _route, _thread, output) {
    await output({ kind: "message", id: "message", text: "Partial", completed: false });
    await output({ kind: "message", id: "message", text: "Partial answer", completed: false });
    throw new Error("Stream interrupted");
  } };
  await expect(durableRunner(runner, store, session, "main", "final", false).run("Work", root, {}, undefined, () => {})).rejects.toThrow("Stream interrupted");
  const loaded = (await store.load(root, session.id))!;
  expect(loaded.attempts![0]).toMatchObject({ status: "failed", observations: [{ kind: "answer", text: "Partial answer" }] });
});
