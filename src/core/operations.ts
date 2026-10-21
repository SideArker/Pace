import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Config, QueuedOperation, Session } from "../shared/types.js";
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
export async function currentPlan(store: PaceStore, source: Session): Promise<string | undefined> {
  if (source.planArtifact) return readFile(artifactPath(store, source, source.planArtifact), "utf8");
  return source.plan;
}
export async function preparePlanExecution(store: PaceStore, source: Session, config: Config, argument?: string) {
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
  session.executionSource = { sessionId: source.id, taskId: source.activeTask?.id, artifact, plan };
  await store.saveChanges(session);
  return { session, prompt: executePlanPrompt(plan) + (extra ? `\n\nAdditional user instructions:\n${extra}` : "") };
}
export function adoptedSidePrompt(session: Session, sourceSideId: string): string {
  const answer = session.sideAnswers?.find(item => item.id === sourceSideId);
  if (!answer?.result || answer.error) throw new Error("Side answer is unavailable or failed.");
  if (answer.taskId && answer.taskId !== session.activeTask?.id) throw new Error("Side answer belongs to a different task. Select that task before forwarding it.");
  return `Use this explicitly selected side answer as evidence for the active task. Verify relevant findings before acting.\nSource side answer: ${answer.id}; attempt: ${answer.attemptId}; snapshot: ${answer.snapshotAt}; author: ${answer.route.model} ${answer.route.effort}\nQuestion: ${answer.question}\nAnswer:\n${answer.result}`;
}
