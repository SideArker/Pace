import type { Usage } from "@openai/codex-sdk";
import type { ApprovalMode, CheckpointNote, Session, CheckpointRecord, CheckpointGeneration } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import { CodexRunError } from "../integrations/codex-types.js";
import { costForUsage } from "./routing/pricing.js";
export type { CheckpointNote } from "../shared/types.js";

export const CHECKPOINT_MAX_CHARS = 10_000;

export function checkpointPrompt(): string {
  return `Create a checkpoint for continuing this coding task in a fresh Codex thread. Use the tool results and conversation still visible to you. Return exactly one JSON object, no Markdown fence, with these fields: complete (boolean), goal (string), constraints (string[]), findings ({detail,file?}[]), changes ({detail,file?}[]), checks ({command,outcome}[]), unfinished (string[]), questions (string[]), risks (string[]). Include exact user constraints, verified findings with file references, changes and check outcomes, and remaining work. Do not perform new work. Aim for roughly 2,000 tokens and keep the JSON under ${CHECKPOINT_MAX_CHARS} characters. Complete means this note faithfully captures all known relevant state; it does not mean the task is finished or that open questions are resolved. Set complete to false only if the state cannot fit or known relevant facts are missing; never silently omit them.`;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function entries(value: unknown): value is { detail: string; file?: string }[] {
  return Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.detail === "string" && item.detail.trim().length > 0 &&
    (item.file === undefined || typeof item.file === "string"));
}

export function parseCheckpoint(text: string): CheckpointNote {
  const source = text.trim();
  if (source.length > CHECKPOINT_MAX_CHARS) throw new Error(`Checkpoint exceeds ${CHECKPOINT_MAX_CHARS} characters`);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Checkpoint is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint must be an object");
  const note = value as Record<string, unknown>;
  if (note.complete !== true || typeof note.goal !== "string" || !note.goal.trim() ||
    !strings(note.constraints) || !entries(note.findings) || !entries(note.changes) ||
    !Array.isArray(note.checks) || !note.checks.every(item => item && typeof item === "object" &&
      typeof item.command === "string" && item.command.trim() &&
      typeof item.outcome === "string" && item.outcome.trim()) ||
    !strings(note.unfinished) || !strings(note.questions) || !strings(note.risks))
    throw new Error("Checkpoint is missing required structured fields");
  return note as CheckpointNote;
}

export function checkpointHandoff(note: CheckpointNote, recent: { user: string; assistant: string }[], request: string): string {
  return `Continue this coding task from the validated checkpoint. Verify any important repository state before editing.\n\nCheckpoint:\n${JSON.stringify(note)}\n\nRecent exchanges:\n${JSON.stringify(recent.slice(-3))}\n\nCurrent user request:\n${request}`;
}

export function checkpointDue(session: Session): boolean {
  if (!session.threadId || session.turns.length < 16) return false;
  const checkpoint = session.checkpoint;
  if (!checkpoint || checkpoint.threadId !== session.threadId) {
    const lastAttempt = [...(session.checkpointGenerations ?? [])].reverse()
      .find(item => item.threadId === session.threadId);
    if (!lastAttempt) return true;
    const source = session.turns.findIndex(turn => turn.at === lastAttempt.sourceTurnAt);
    return source < 0 || session.turns.length - source - 1 >= 4;
  }
  const source = session.turns.findIndex(turn => turn.at === checkpoint.sourceTurnAt);
  return source < 0 || session.turns.length - source - 1 >= 4;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

/** Generates inside the current Codex thread so its tool results remain visible. */
export async function createCheckpointIfDue(
  session: Session,
  runner: CodexRunner,
  onProgress: (progress: Progress) => void | Promise<void>,
  signal?: AbortSignal,
  approvalMode: ApprovalMode = "request-approval",
): Promise<CheckpointRecord | undefined> {
  if (!checkpointDue(session)) return undefined;
  const threadId = session.threadId!;
  const sourceTurnAt = session.turns.at(-1)!.at;
  let prompt = checkpointPrompt();
  let combinedUsage: Usage | undefined;
  let allUsageKnown = true;
  let totalDurationMs = 0;
  let totalCost = 0;
  let allCostsKnown = true;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = performance.now();
    let usage: Usage | undefined;
    let outcome: CheckpointGeneration["outcome"] = "failed";
    let error: string | undefined;
    let note: CheckpointNote | undefined;
    let answer: string | undefined;
    try {
      await onProgress({ kind: "status", text: attempt === 1 ? "Creating context checkpoint…" : "Correcting context checkpoint…" });
      const execution = await runner.run(prompt, session.projectPath, session.route, threadId, onProgress, signal, "main", [], approvalMode);
      if (execution.threadId !== threadId) throw new Error("Checkpoint changed Codex thread");
      usage = execution.usage;
      answer = execution.result;
      session.contextByThread ??= {};
      if (execution.context) session.contextByThread[threadId] = execution.context;
      else delete session.contextByThread[threadId];
      note = parseCheckpoint(answer);
      outcome = "valid";
    } catch (cause) {
      if (cause instanceof CodexRunError) {
        usage = cause.usage;
        if (cause.context) {
          session.contextByThread ??= {};
          session.contextByThread[threadId] = cause.context;
        }
      }
      error = String(cause);
      outcome = signal?.aborted ? "cancelled" : answer !== undefined ? "invalid" : "failed";
      if (session.contextByThread && answer === undefined && !(cause instanceof CodexRunError && cause.context)) delete session.contextByThread[threadId];
    }
    const durationMs = Math.round(performance.now() - started);
    totalDurationMs += durationMs;
    if (usage) combinedUsage = combinedUsage ? addUsage(combinedUsage, usage) : usage;
    else allUsageKnown = false;
    const cost = costForUsage(session.route, usage);
    if (cost === undefined) allCostsKnown = false;
    else totalCost += cost;
    const generation: CheckpointGeneration = {
      at: new Date().toISOString(), sourceTurnAt, threadId, route: session.route,
      durationMs, outcome, usage, estimatedCostUsd: cost, error,
    };
    session.checkpointGenerations = [...(session.checkpointGenerations ?? []), generation].slice(-50);
    if (note) {
      const checkpoint: CheckpointRecord = {
        createdAt: generation.at, sourceTurnAt, threadId, route: session.route, note,
        durationMs: totalDurationMs,
        usage: allUsageKnown ? combinedUsage : undefined,
        estimatedCostUsd: allCostsKnown ? totalCost : undefined,
      };
      session.checkpoint = checkpoint;
      return checkpoint;
    }
    if (outcome !== "invalid" || attempt === 2) return undefined;
    prompt = checkpointPrompt() + `\n\nPrevious note failed validation: ${error}. Rewrite it from the thread context. ${answer!.length <= CHECKPOINT_MAX_CHARS ? `Previous note:\n${answer}` : "The previous note exceeded the size limit; start over."}`;
  }
  return undefined;
}
