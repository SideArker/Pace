import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainedConversationPrompt } from "../src/core/orchestrator-helpers.js";
import { afterEach, expect, it, vi } from "vitest";
import { steerQueuedPrompt } from "../src/components/queue-steering.js";
import type { TurnJob } from "../src/components/turn-runner.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { operation } from "../src/core/operations.js";
import { PaceStore, newSession } from "../src/core/sessions.js";

function fixture() {
  const session = newSession(process.cwd(), "manual");
  const other = newSession(process.cwd(), "manual");
  const queue = new PromptQueue();
  queue.add(session.id, "first"); queue.add(session.id, "focus on tests"); queue.add(other.id, "other conversation");
  const job: TurnJob = { session, controller: new AbortController(), prompt: "work", persistSteering: vi.fn(async () => {}), steer: vi.fn(async () => {}) };
  const jobs = new Map([[session.id, job]]);
  return { session, other, queue, job, jobs };
}

it("steers the selected prompt and preserves FIFO order and other conversations", async () => {
  const { session, other, queue, job, jobs } = fixture();
  expect(await steerQueuedPrompt(session.id, 1, jobs, queue)).toBe("focus on tests");
  expect(job.steer).toHaveBeenCalledExactlyOnceWith("focus on tests");
  expect(queue.list(session.id)).toEqual(["first"]);
  expect(queue.list(other.id)).toEqual(["other conversation"]);
  expect(job.steeredPrompts).toEqual(["focus on tests"]);
});

it("retains the prompt until acknowledgement and prevents duplicate sends", async () => {
  const { session, queue, job, jobs } = fixture();
  let accept!: () => void;
  job.steer = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
  const pending = steerQueuedPrompt(session.id, 1, jobs, queue);
  await vi.waitFor(() => expect(job.steer).toHaveBeenCalledOnce());
  expect(queue.list(session.id)).toEqual(["first", "focus on tests"]);
  await expect(steerQueuedPrompt(session.id, 1, jobs, queue)).rejects.toThrow("already being sent");
  // Moving the selected index must not acknowledge a different operation.
  queue.remove(session.id, 0); queue.add(session.id, "later");
  accept(); await pending;
  expect(queue.list(session.id)).toEqual(["later"]);
  expect(job.pendingSteer).toBeUndefined();
});

it("keeps ambiguous steering queued and blocks automatic or repeated delivery", async () => {
  const { session, queue, job, jobs } = fixture();
  job.steer = vi.fn().mockRejectedValueOnce(new Error("turn ended")).mockResolvedValue(undefined);
  await expect(steerQueuedPrompt(session.id, 1, jobs, queue)).rejects.toThrow("turn ended");
  expect(queue.list(session.id)).toEqual(["first", "focus on tests"]);
  expect(job.steeredPrompts).toBeUndefined();
  await expect(steerQueuedPrompt(session.id, 1, jobs, queue)).rejects.toThrow("will not be sent again");
  expect(job.steer).toHaveBeenCalledOnce();
  expect(session.steeringRecords?.[0]?.state).toBe("unknown");
});

it("leaves idle, starting, cancelled, and background-only conversations queued", async () => {
  for (const state of ["idle", "starting", "cancelled", "background"]) {
    const { session, other, queue, job, jobs } = fixture();
    if (state === "idle") jobs.clear();
    if (state === "starting") job.steer = undefined;
    if (state === "cancelled") job.controller.abort();
    if (state === "background") { jobs.delete(session.id); jobs.set(other.id, job); }
    await expect(steerQueuedPrompt(session.id, 1, jobs, queue)).rejects.toThrow("active agent turn");
    expect(queue.list(session.id)).toEqual(["first", "focus on tests"]);
  }
});

it("preserves commands and operations addressed to another task", async () => {
  for (const item of [
    { text: "/execute" }, { text: "/verify", intent: "verify_plan" as const, role: "verifier" as const },
    { text: "old task", taskId: "different-task" },
  ]) {
    const { session, queue, job, jobs } = fixture();
    queue.restore(session.id, [{ ...operation(item.text, session.id), ...item }]);
    await expect(steerQueuedPrompt(session.id, 0, jobs, queue)).rejects.toThrow();
    expect(job.steer).not.toHaveBeenCalled();
    expect(queue.list(session.id)).toEqual([item.text]);
  }
});

it("does not resend a queued operation that is already running", async () => {
  const { session, queue, job, jobs } = fixture();
  job.operationId = queue.operations(session.id)[0]!.id;
  await expect(steerQueuedPrompt(session.id, 0, jobs, queue)).rejects.toThrow("already running");
  expect(job.steer).not.toHaveBeenCalled();
  expect(queue.list(session.id)).toEqual(["first", "focus on tests"]);
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function durableFixture() {
  const env = fixture();
  const root = await mkdtemp(join(tmpdir(), "pace-steering-")); roots.push(root);
  const store = new PaceStore(root);
  env.session.activeTask = { id: "task", originalRequest: "Work", instructions: [] };
  env.session.queuedPrompts = [...env.queue.operations(env.session.id)];
  await store.saveChanges(env.session, false);
  env.job.persistSteering = () => store.saveChanges(env.session, false);
  return { ...env, store };
}

it("records delivery on disk before queue acknowledgement and survives restart before turn history", async () => {
  const env = await durableFixture();
  env.job.steer = vi.fn(async () => {
    const saved = await new PaceStore(env.store.baseDir).load(env.session.projectPath, env.session.id);
    expect(saved?.steeringRecords?.[0]).toMatchObject({ state: "unknown", role: "main", taskId: "task" });
    expect(env.queue.list(env.session.id)).toContain("focus on tests");
  });
  const acknowledge = env.queue.acknowledge.bind(env.queue);
  let savedAtAck = "";
  env.queue.acknowledge = (sessionId, id) => {
    savedAtAck = env.session.steeringRecords![0]!.state;
    acknowledge(sessionId, id);
  };
  await steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue);
  expect(savedAtAck).toBe("delivered");
  const loaded = (await new PaceStore(env.store.baseDir).load(env.session.projectPath, env.session.id))!;
  expect(loaded.steeringRecords?.[0]).toMatchObject({ version: 1, state: "delivered", id: env.session.steeringRecords![0]!.id });
  const replay = retainedConversationPrompt("Continue", loaded);
  expect(replay).toContain("focus on tests");
  loaded.threadId = "existing";
  expect(retainedConversationPrompt("Continue", loaded)).toBe("Continue");
});

it("never calls the runner when pending persistence fails, and allows retry of the known unsent record", async () => {
  const env = await durableFixture();
  env.job.persistSteering = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(() => env.store.saveChanges(env.session, false));
  await expect(steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue)).rejects.toThrow("disk full");
  expect(env.job.steer).not.toHaveBeenCalled();
  expect(env.queue.list(env.session.id)).toContain("focus on tests");
  await steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue);
  expect(env.job.steer).toHaveBeenCalledOnce();
});

for (const failure of ["write-ahead", "send", "delivered-save"]) it(`retains uncertain ${failure} across restart without a duplicate send`, async () => {
  const env = await durableFixture();
  let saves = 0;
  env.job.persistSteering = async () => {
    saves++;
    if ((failure === "write-ahead" && saves === 2) || (failure === "delivered-save" && saves >= 3)) throw new Error("disk full");
    await env.store.saveChanges(env.session, false);
  };
  if (failure === "send") env.job.steer = vi.fn(async () => { throw new Error("connection lost after receipt"); });
  await expect(steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue)).rejects.toThrow();
  const loaded = (await new PaceStore(env.store.baseDir).load(env.session.projectPath, env.session.id))!;
  expect(loaded.steeringRecords![0]!.state).toBe(failure === "write-ahead" ? "pending" : "unknown");
  expect(env.queue.list(env.session.id)).toContain("focus on tests");
  expect(retainedConversationPrompt("Continue", loaded)).not.toContain("focus on tests");
  await expect(steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue)).rejects.toThrow("will not be sent again");
  expect(env.job.steer).toHaveBeenCalledTimes(failure === "write-ahead" ? 0 : 1);
});

it("replays only delivered main steering for the active task and deduplicates linked history", async () => {
  const env = await durableFixture();
  await steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue);
  const record = env.session.steeringRecords![0]!;
  env.session.turns = [{ prompt: "Work", result: "Result", at: "now", steeringPrompts: [record.text], steeringRecordIds: [record.id] }];
  expect(retainedConversationPrompt("Continue", env.session).split(record.text)).toHaveLength(2);
  env.session.turns = [];
  for (const role of ["verifier", "aside", "scout"] as const) {
    record.role = role;
    expect(retainedConversationPrompt("Continue", env.session)).toBe("Continue");
  }
  record.role = "main"; record.taskId = "another-task";
  expect(retainedConversationPrompt("Continue", env.session)).toBe("Continue");
});

it("does not resurrect steering removed by undo/delete/rewind, and restores it with redo", async () => {
  const { undoConversationTurn, deleteConversationTurn, rewindConversation } = await import("../src/core/session-model.js");
  const { changeConversationHistory } = await import("../src/core/file-history.js");
  const env = await durableFixture();
  await steerQueuedPrompt(env.session.id, 1, env.jobs, env.queue);
  const record = env.session.steeringRecords![0]!;
  env.session.turns = [{ prompt: "Work", result: "Result", at: "now", steeringPrompts: [record.text], steeringRecordIds: [record.id] }];
  await env.store.saveChanges(env.session, false);
  for (const remove of [undoConversationTurn, (s: typeof env.session) => deleteConversationTurn(s, 0), (s: typeof env.session) => rewindConversation(s, 0)]) {
    const copy = structuredClone(env.session); remove(copy);
    expect(retainedConversationPrompt("Continue", copy)).not.toContain(record.text);
    expect(copy.steeringRecords![0]!.text).toBe(record.text);
  }
  await changeConversationHistory(env.store, env.session, "undo");
  expect(retainedConversationPrompt("Continue", env.session)).not.toContain(record.text);
  await changeConversationHistory(env.store, env.session, "redo");
  expect(retainedConversationPrompt("Continue", env.session).split(record.text)).toHaveLength(2);
});
