import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { OperationIntent, Route, Session } from "../shared/types.js";
import type { TaskRelation } from "./active-task.js";
import type { PaceStore } from "./sessions.js";
import { artifactDirectory, artifactPath, artifactSnapshot, planArtifactReference } from "./system/artifacts.js";

export async function prepareTurnArtifacts({
  store, session, prompt, intent, taskRelation, save,
}: {
  store: PaceStore;
  session: Session;
  prompt: string;
  intent?: OperationIntent;
  taskRelation: TaskRelation;
  save: () => Promise<void>;
}) {
  const conversationArtifacts = artifactDirectory(store, session);
  await mkdir(conversationArtifacts, { recursive: true });
  const planningTurn = session.kind === "planning" && (intent === "revise_plan" || !intent);
  const pendingPlanBeforeTurn = session.pendingPlanArtifact;
  const separatePlan = planningTurn && !!session.planArtifact && !pendingPlanBeforeTurn && taskRelation === "replace";
  const planReference = planningTurn ? planArtifactReference(session.id, prompt, session.pendingPlanArtifact ?? session.planArtifact, separatePlan) : undefined;
  const planPath = planReference ? artifactPath(store, session, planReference) : undefined;
  if (planReference && planReference !== session.planArtifact && session.pendingPlanArtifact !== planReference) {
    session.pendingPlanArtifact = planReference;
    await save();
  }
  let planBefore: string | undefined;
  if (planPath) {
    try { planBefore = await readFile(planPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (planBefore === undefined && session.plan && !separatePlan && (!pendingPlanBeforeTurn || planReference === session.planArtifact)) {
      planBefore = session.plan;
      await writeFile(planPath, planBefore, "utf8");
    }
  }
  const artifactsBefore = await artifactSnapshot(conversationArtifacts).catch(
    () => new Map<string, number>(),
  );
  return { conversationArtifacts, planningTurn, planReference, planPath, planBefore, artifactsBefore };
}

export async function finishPlanArtifact({
  session, route, planPath, planBefore, planReference, systemMessage,
}: {
  session: Session;
  route: Route;
  planPath: string;
  planBefore: string | undefined;
  planReference: string | undefined;
  systemMessage: (text: string) => void;
}): Promise<boolean> {
  let planChanged = false;
  let planAfter: string | undefined;
  try { planAfter = await readFile(planPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (planAfter !== undefined && !planAfter.trim() && planBefore?.trim()) {
    await writeFile(planPath, planBefore, "utf8");
    planAfter = planBefore;
  }
  if (planAfter?.trim() && planAfter !== planBefore) {
    planChanged = true;
    session.plan = planAfter;
    session.planArtifact = planReference;
    session.planRoute = route;
    delete session.pendingPlanArtifact;
    systemMessage(`Plan saved: ${planPath}`);
  }
  return planChanged;
}
