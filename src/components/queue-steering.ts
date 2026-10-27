import { randomUUID } from "node:crypto";
import type { PromptQueue } from "../core/prompt-queue.js";
import { validateOperationTarget } from "../core/operations.js";
import type { TurnJob } from "./turn-runner.js";

/** Keep the operation queued until the active turn confirms receipt. */
export async function steerQueuedPrompt(
  sessionId: string,
  index: number,
  jobs: ReadonlyMap<string, TurnJob>,
  queue: PromptQueue,
): Promise<string> {
  const job = jobs.get(sessionId);
  const item = queue.operations(sessionId)[index];
  if (!item) throw new Error("This queued prompt is no longer available.");
  if (!job?.steer || job.controller.signal.aborted) throw new Error("Wait for an active agent turn before steering. The prompt remains queued.");
  if (job.pendingSteer) throw new Error("A steering message is already being sent.");
  if (job.operationId === item.id) throw new Error("This queued prompt is already running.");
  if (item.intent || item.role !== "main" || item.text.trimStart().startsWith("/"))
    throw new Error("Only regular prompts can steer a turn. Queued commands keep their original action.");
  validateOperationTarget(job.session, item);
  if (!job.persistSteering) throw new Error("Steering persistence is unavailable. The prompt remains queued.");
  const text = item.text;
  const send = job.steer;
  const persist = job.persistSteering;
  const pending = Promise.resolve().then(async () => {
    const current = () => job.session.steeringRecords!.find(record => record.id === item.id)!;
    const existing = job.session.steeringRecords?.find(record => record.id === item.id);
    if (existing && (existing.state !== "pending" || existing.text !== text))
      throw new Error(`Steering delivery is ${existing.state}; it will not be sent again automatically. Review the saved record before submitting a new message.`);
    if (existing && existing.taskId !== job.session.activeTask?.id)
      throw new Error("This unsent steering belongs to a different task. Review it before submitting a new message.");
    if (existing) {
      job.turnKey ??= randomUUID();
      Object.assign(existing, { turnKey: job.turnKey, attemptId: job.steerAttemptId, role: job.steerRole ?? "main" });
    }
    if (!existing) {
      job.turnKey ??= randomUUID();
      const attempt = job.session.attempts?.find(record => record.id === job.steerAttemptId);
      (job.session.steeringRecords ??= []).push({
        version: 1, id: item.id, sessionId, taskId: job.session.activeTask?.id,
        turnKey: job.turnKey, attemptId: job.steerAttemptId, threadId: attempt?.threadId,
        role: job.steerRole ?? "main", text, state: "pending", createdAt: new Date().toISOString(),
      });
    }
    await persist();
    // Write ahead of the non-idempotent runner call. A crash from this point
    // leaves an uncertain delivery, never an operation eligible for auto retry.
    current().state = "unknown";
    await persist();
    try {
      await send(text);
      current().state = "delivered";
      current().deliveredAt = new Date().toISOString();
      await persist();
    } catch (error) {
      current().state = "unknown";
      current().deliveredAt = undefined;
      current().error = String(error);
      await persist().catch(() => {}); // The write-ahead unknown record is durable.
      throw new Error(`Steering delivery is unknown: ${String(error)}. Review the saved record before submitting a new message.`, { cause: error });
    }
    queue.acknowledge(sessionId, item.id);
    (job.steeredPrompts ??= []).push(text);
  });
  job.pendingSteer = pending;
  try { await pending; return text; }
  finally { if (job.pendingSteer === pending) job.pendingSteer = undefined; }
}
