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
  const text = item.text;
  const send = job.steer;
  const pending = Promise.resolve().then(async () => {
    await send(text);
    queue.acknowledge(sessionId, item.id);
    (job.steeredPrompts ??= []).push(text);
  });
  job.pendingSteer = pending;
  try { await pending; return text; }
  finally { if (job.pendingSteer === pending) job.pendingSteer = undefined; }
}
