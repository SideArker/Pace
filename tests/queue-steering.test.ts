import { expect, it, vi } from "vitest";
import { steerQueuedPrompt } from "../src/components/queue-steering.js";
import type { TurnJob } from "../src/components/turn-runner.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { operation } from "../src/core/operations.js";
import { newSession } from "../src/core/sessions.js";

function fixture() {
  const session = newSession(process.cwd(), "manual");
  const other = newSession(process.cwd(), "manual");
  const queue = new PromptQueue();
  queue.add(session.id, "first"); queue.add(session.id, "focus on tests"); queue.add(other.id, "other conversation");
  const job: TurnJob = { session, controller: new AbortController(), prompt: "work", steer: vi.fn(async () => {}) };
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

it("keeps failed steering queued and permits a later retry", async () => {
  const { session, queue, job, jobs } = fixture();
  job.steer = vi.fn().mockRejectedValueOnce(new Error("turn ended")).mockResolvedValue(undefined);
  await expect(steerQueuedPrompt(session.id, 1, jobs, queue)).rejects.toThrow("turn ended");
  expect(queue.list(session.id)).toEqual(["first", "focus on tests"]);
  expect(job.steeredPrompts).toBeUndefined();
  await steerQueuedPrompt(session.id, 1, jobs, queue);
  expect(queue.list(session.id)).toEqual(["first"]);
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
