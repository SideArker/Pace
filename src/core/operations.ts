import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Config, ManualWorkflow, QueuedOperation, Route, Session, WorkflowShape } from "../shared/types.js";
import { newSession, type PaceStore } from "./sessions.js";
import { artifactPath } from "./system/artifacts.js";
import { executePlanPrompt, tryReadPlanFile } from "./orchestrator-helpers.js";

export function operation(value: string | QueuedOperation, sessionId: string, taskId?: string): QueuedOperation {
  return typeof value === "string" ? { id: randomUUID(), text: value, sessionId, taskId, role: "main" } : { ...value };
}
export function validOperation(value: unknown): value is QueuedOperation {
  if (!value || typeof value !== "object") return false;
  const item = value as QueuedOperation;
  return typeof item.id === "string" && /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.text === "string" &&
    typeof item.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(item.sessionId) &&
    (item.taskId === undefined || typeof item.taskId === "string") &&
    (item.sourceSideId === undefined || typeof item.sourceSideId === "string") &&
    ["main", "scout", "verifier", "aside", "status"].includes(item.role) &&
    (item.intent === undefined || ["verify_plan", "execute_plan", "revise_plan", "continue_verify", "aside", "adopt_side"].includes(item.intent));
}
/** Explicit user selections update task ownership without interpreting user prose. */
export function manualSelection(source: Session, selection: Route | ManualWorkflow): Session {
  const session = structuredClone(source);
  session.routingMode = "manual";
  let choice: string;
  if ("shape" in selection) {
    session.manualWorkflow = selection;
    const shape: WorkflowShape = selection.shape === "scout_plan_execute" ? "scout_plan" : ["plan_execute", "plan_verify"].includes(selection.shape) ? "plan" : selection.shape as WorkflowShape;
    if (session.activeTask) session.activeTask.workflow = {
      version: 1, generation: (source.activeTask?.workflow?.generation ?? 0) + 1, shape,
      stage: shape === "scout" || shape === "scout_plan" ? "scout" : shape === "plan" ? "plan" : "final", source: "user",
    };
    choice = shape;
  } else {
    session.route = { ...selection }; session.manualWorkflow = undefined;
    if (session.activeTask?.workflow) { session.activeTask.workflow.mainRoute = { ...selection }; session.activeTask.workflow.source = "user"; }
    choice = `${selection.model ?? "default"}:${selection.effort ?? "default"}`;
  }
  session.controlDecisions = [...(session.controlDecisions ?? []), { id: randomUUID(), taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage, role: "main", objective: "shape" in selection ? "manual workflow" : "manual route", choice, confidence: 1, probabilities: { [choice]: 1 }, durationMs: 0, at: new Date().toISOString(), source: "user", contextAction: "continue" }];
  return session;
}
export async function currentPlan(store: PaceStore, source: Session): Promise<string | undefined> {
  if (source.planArtifact) return readFile(artifactPath(store, source, source.planArtifact), "utf8");
  return source.plan;
}
export async function preparePlanExecution(store: PaceStore, source: Session, config: Config, argument?: string, operationId?: string) {
  if (operationId) {
    const existing = (await store.list(source.projectPath)).find(item => item.executionSource?.sessionId === source.id && item.executionSource.operationId === operationId);
    if (existing) return { session: existing, prompt: executePlanPrompt(existing.executionSource!.plan), completed: existing.turns.some(turn => turn.operation?.id === operationId && !turn.failed) };
  }
  let plan = await currentPlan(store, source);
  let artifact = source.planArtifact;
  let extra: string | undefined;
  if (argument?.trim()) {
    const text = argument.trim();
    const whole = tryReadPlanFile(text, source.projectPath);
    const parts = text.split(/\s+/);
    const first = whole ?? tryReadPlanFile(parts[0]!, source.projectPath);
    if (first) { plan = first.content; artifact = first.path; extra = whole ? undefined : parts.slice(1).join(" "); }
    else extra = text;
  }
  if (!plan?.trim()) throw new Error("No plan found to execute. Provide a plan file or create one with /plan.");
  const session = newSession(source.projectPath, "auto", "normal", config.autoLaunchSkills);
  session.title = artifact ? `Exec: ${basename(artifact)}` : `Exec: ${source.title ?? "Plan Execution"}`;
  session.executionSource = { sessionId: source.id, taskId: source.activeTask?.id, artifact, plan, ...(operationId ? { operationId } : {}) };
  await store.saveChanges(session);
  return { session, prompt: executePlanPrompt(plan) + (extra ? `\n\nAdditional user instructions:\n${extra}` : ""), completed: false };
}
export function adoptedSidePrompt(session: Session, sourceSideId: string): string {
  const answer = session.sideAnswers?.find(item => item.id === sourceSideId);
  if (!answer?.result || answer.error) throw new Error("Side answer is unavailable or failed.");
  if (answer.taskId && answer.taskId !== session.activeTask?.id) throw new Error("Side answer belongs to a different task. Select that task before forwarding it.");
  return `Use this explicitly selected side answer as evidence for the active task. Verify relevant findings before acting.\nSource side answer: ${answer.id}; attempt: ${answer.attemptId}; snapshot: ${answer.snapshotAt}; author: ${answer.route.model} ${answer.route.effort}\nQuestion: ${answer.question}\nAnswer:\n${answer.result}`;
}
