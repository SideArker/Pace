import { randomUUID } from "node:crypto";
import type { Config, Session } from "../shared/types.js";
import type { Progress } from "../integrations/codex-types.js";
import type { Orchestrator, TurnOutcome, RoutingRecord } from "./orchestrator.js";
import { loadRoutingPrompts } from "./routing/routing-prompts.js";
import { stageRequest } from "./vex/requests.js";
import { chosenRoute, validateDecision } from "./routing/router.js";
import { awaitRouting } from "./orchestrator-helpers.js";
import { durableRunner, requiredSave, TransitionSaveError } from "./task-execution.js";
import { costForUsage } from "./routing/pricing.js";

/** Separate read-only context snapshot; never transfers ownership of the main task. */
export async function runAside(orchestrator: Orchestrator, question: string, source: Session, config: Config, progress: (event: Progress) => void, signal?: AbortSignal, activate: boolean | (() => boolean) = true): Promise<TurnOutcome> {
  if (!question.trim()) throw new Error("Type /btw <question> to ask a side question.");
  const session = structuredClone(source);
  const snapshotAt = new Date().toISOString();
  const prompts = loadRoutingPrompts(orchestrator.store.baseDir);
  const enabled = config.models.filter(model => model.enabled !== false && model.efforts.length);
  if (!enabled.length) throw new Error("No allowed route is available for a side answer.");
  const request = stageRequest(question, session.turns, enabled, prompts.side.objective, undefined, enabled, prompts, { activeTask: session.activeTask, previousRoute: session.route, hasCodexThread: !!session.threadId });
  const started = performance.now();
  const routing: RoutingRecord[] = [];
  let failure: unknown;
  let route: ReturnType<typeof chosenRoute> | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const decision = validateDecision(await awaitRouting(orchestrator.vex.choose(request), signal), request.options);
      route = chosenRoute(decision.choice, enabled);
      routing.push({ objective: prompts.side.objective, ...decision, attempts: attempt });
      session.controlDecisions = [...(session.controlDecisions ?? []), { id: randomUUID(), taskId: session.activeTask?.id, role: "aside", stage: "aside", objective: prompts.side.objective, choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, durationMs: Math.round(performance.now() - started), at: snapshotAt, source: "vex", contextAction: "continue" }];
      await requiredSave(orchestrator.store, session, activate);
      break;
    } catch (error) { if (error instanceof TransitionSaveError || signal?.aborted) throw error; failure = error; }
  }
  if (!route) throw new Error(`Vex could not choose a side route after two attempts: ${String(failure)}`);
  const id = randomUUID();
  const firstAttempt = session.attempts?.length ?? 0;
  const snapshot = {
    snapshotAt, scope: "Retained exchanges, task brief and recorded observations; not the full tool history",
    turns: session.turns, task: session.activeTask, tasks: session.tasks,
    attempts: session.attempts?.filter(item => item.taskId === session.activeTask?.id).slice(-6).map(item => ({ id: item.id, role: item.role, status: item.status, observations: item.observations, result: item.result })),
  };
  progress({ kind: "route", route, role: "aside", taskId: session.activeTask?.id });
  try {
    const execution = await durableRunner(orchestrator.runner, orchestrator.store, session, "aside", "aside", activate).run(
      `${prompts.side.instruction}\n\nContext snapshot:\n${JSON.stringify(snapshot)}\n\nUser side question:\n${question}`,
      session.projectPath, route, undefined, progress, signal, "side", [], config.approvalMode,
    );
    const attempt = session.attempts!.slice(firstAttempt).find(item => item.role === "aside")!;
    session.sideAnswers = [...(session.sideAnswers ?? []), { id, taskId: session.activeTask?.id, attemptId: attempt.id, question, snapshotAt, route, result: execution.result, threadId: execution.threadId }];
    await requiredSave(orchestrator.store, session, activate);
    // Refresh the caller through its concrete changes, preserving any main work
    // made while this isolated snapshot was running.
    await requiredSave(orchestrator.store, source, activate);
    return { session, role: "aside", result: execution.result, note: `Side answer ${id}; lead remains ${session.route.model ?? "default"} ${session.route.effort ?? "default"}`, route, durationMs: Math.round(performance.now() - started), artifacts: [], usage: execution.usage, estimatedCostUsd: costForUsage(route, execution.usage), stages: [{ objective: prompts.side.objective, route, durationMs: attempt.durationMs ?? 0, usage: execution.usage, estimatedCostUsd: costForUsage(route, execution.usage) }], routing };
  } catch (error) {
    if (error instanceof TransitionSaveError) throw error;
    const attempt = session.attempts!.slice(firstAttempt).find(item => item.role === "aside");
    if (attempt) { session.sideAnswers = [...(session.sideAnswers ?? []), { id, taskId: session.activeTask?.id, attemptId: attempt.id, question, snapshotAt, route, error: String(error), threadId: attempt.threadId }]; await requiredSave(orchestrator.store, session, activate); }
    throw error;
  }
}
