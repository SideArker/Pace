import { tracedRunner, redactTrace, promptChange, type PromptTrace } from "./prompt-trace.js";
import { randomUUID } from "node:crypto";
import type { Config, Route, Session, AgentRole, OperationIntent, QueuedOperation, WorkflowShape, Usage } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import type { UserAnswers } from "../integrations/codex-types.js";
import {
  VexRouter,
  shapeRequest,
  stageRequest,
  controlRequest,
} from "./vex/client.js";
import {
  chosenRoute,
} from "./routing/router.js";
import { costForUsage, pricedModels, refreshVersionManifest } from "./routing/pricing.js";
import { advanceTask, retainedTask, type TaskRelation } from "./active-task.js";
import { PaceStore } from "./sessions.js";
import { verifyPlanPrompt, tryReadPlanFile, structuredHandoff, addUsage, awaitRouting, loadPlanningInstructions, planningPrompt } from "./orchestrator-helpers.js";
import { createTurnRouting, VexUnavailableError } from "./orchestrator-routing.js";
export { VexUnavailableError } from "./orchestrator-routing.js";
import { runPlanningStage } from "./workflow-stages.js";
import { durableRunner, ensureTask, requiredSave, TransitionSaveError } from "./task-execution.js";
import { operation, preparePlanExecution, adoptedSidePrompt, currentPlan, validateOperationTarget } from "./operations.js";
import { runAside } from "./side-answers.js";
import { beginFileEdits } from "./file-edits.js";
import { artifactSnapshot, changedArtifacts } from "./system/artifacts.js";
import { validRoute } from "../shared/config.js";
import { existingFolder } from "./system/folders.js";
import { prepareTurnPrompt, prepareRunnerPrompt } from "./orchestrator-prompts.js";
import { loadMemory } from './memory/config.js';
import { prepareTurnArtifacts, finishPlanArtifact } from "./orchestrator-artifacts.js";
import { requestWorkflowClarification } from "./orchestrator-clarification.js";
import { prepareTurnSkills } from "./orchestrator-skills.js";
import {
  completionObjective,
  loadRoutingPrompts,
} from "./routing/routing-prompts.js";

export type StageRecord = {
  objective: string;
  route: Route;
  durationMs: number;
  usage?: Usage;
  estimatedCostUsd?: number;
  handoff?: string;
};
export type RoutingRecord = {
  objective: string;
  choice: string;
  choiceLabel?: string;
  confidence: number;
  probabilities: Record<string, number>;
  attempts: number;
};
export type TurnOutcome = {
  role?: AgentRole;
  session: Session;
  result: string;
  note: string;
  route: Route;
  durationMs: number;
  artifacts: string[];
  usage?: Usage;
  stages: StageRecord[];
  routing: RoutingRecord[];
  estimatedCostUsd?: number;
};
export class Orchestrator {
  constructor(
    readonly store: PaceStore,
    readonly runner: CodexRunner,
    readonly vex: Pick<VexRouter, "choose"> &
      Partial<Pick<VexRouter, "verify">> = new VexRouter(),
  ) {}
  async aside(question: string, session: Session, config: Config, onProgress: (progress: Progress) => void, signal?: AbortSignal, activate: boolean | (() => boolean) = true): Promise<TurnOutcome> {
    return runAside(this, question, session, config, onProgress, signal, activate);
  }
  async turn(
    prompt: string,
    session: Session,
    config: Config,
    onProgress: (progress: Progress) => void,
    signal?: AbortSignal,
    activateOnSave: boolean | (() => boolean) = true,
    intent?: OperationIntent,
    displayPrompt?: string,
    queuedOperation?: QueuedOperation,
  ): Promise<TurnOutcome> {
    const startedAt = performance.now();
    const prompts = loadRoutingPrompts(this.store.baseDir);
    if (!intent && !queuedOperation && /^\/adopt(?:\s|$)/.test(prompt)) {
      queuedOperation = { ...operation(prompt, session.id, session.activeTask?.id), intent: "adopt_side", sourceSideId: prompt.replace(/^\/adopt(?:\s+|$)/, "").trim() };
      intent = "adopt_side";
    }
    if (queuedOperation) {
      if (session.steeringRecords?.some(record => record.id === queuedOperation?.id))
        throw new Error("This queued operation is already recorded as steering; review delivery before submitting a new message.");
      validateOperationTarget(session, queuedOperation);
      const operationId = queuedOperation.id;
      const completed = session.turns.find(turn => turn.operation?.id === operationId && !turn.failed);
      if (completed) return { session, role: completed.intent === "verify_plan" || completed.intent === "continue_verify" ? "verifier" : "main", result: completed.result, note: "Operation already completed", route: completed.route ?? session.route, durationMs: 0, artifacts: [], stages: [], routing: [] };
    }
    if (!queuedOperation && !intent && /^\/btw(?:\s|$)/.test(prompt)) return this.aside(prompt.replace(/^\/btw\s*/, ""), session, config, onProgress, signal, activateOnSave);
    if (!queuedOperation && !intent && /^\/(?:execute|run-plan)(?:\s|$)/.test(prompt)) {
      queuedOperation = { ...operation(prompt, session.id, session.activeTask?.id), intent: "execute_plan" }; intent = "execute_plan";
    }
    if (!queuedOperation && !intent && /^\/verify(?:\s|$)/.test(prompt)) {
      queuedOperation = { ...operation(prompt, session.id, session.activeTask?.id), intent: "verify_plan", role: "verifier" }; intent = "verify_plan";
    }
    if (intent === "execute_plan" && !session.executionSource && (session.kind === "planning" || session.plan || session.planArtifact)) {
      const argument = (queuedOperation?.text ?? prompt).replace(/^\/(?:execute|run-plan)(?:\s+|$)/, "").trim();
      const execution = await preparePlanExecution(this.store, session, config, argument || undefined, queuedOperation?.id);
      return this.turn(execution.prompt, execution.session, config, onProgress, signal, activateOnSave, intent, displayPrompt, queuedOperation);
    }
    if (intent === "verify_plan" && queuedOperation?.text.startsWith("/verify")) {
      const argument = queuedOperation.text.replace(/^\/verify(?:\s+|$)/, "").trim();
      const parts = argument.split(/\s+/); const file = argument ? tryReadPlanFile(parts[0]!, session.projectPath) : undefined;
      const plan = file?.content ?? await currentPlan(this.store, session);
      if (!plan?.trim()) throw new Error("No saved plan to verify");
      prompt = verifyPlanPrompt(plan, session.activeTask?.originalRequest, file ? parts.slice(1).join(" ") : argument || undefined);
    }
    if (queuedOperation) validateOperationTarget(session, queuedOperation);
    if (intent === "aside") return this.aside(prompt.replace(/^\/btw(?:\s+|$)/, ""), session, config, onProgress, signal, activateOnSave);
    if (intent === "adopt_side") {
      if (!queuedOperation?.sourceSideId) throw new Error("Choose the source side answer before forwarding it");
      await requiredSave(this.store, session, activateOnSave);
      prompt = adoptedSidePrompt(session, queuedOperation.sourceSideId);
      const side = session.sideAnswers!.find(item => item.id === queuedOperation.sourceSideId)!;
      side.adopted = true;
    }
    if (intent === "execute_plan" && session.executionSource) displayPrompt ??= "Executing saved plan in a fresh agent session.";
    const verifierTurn = intent === "verify_plan" || intent === "continue_verify";
    // A stale or concurrent attempt record must never gate a new prompt. Live
    // executions are already owned by their runner; new turns can proceed on
    // the saved thread and the ledger keeps each attempt's outcome separately.
    await this.store.recoverInterruptedAttempts(session, activateOnSave);
    const preparedSkills = await prepareTurnSkills({ prompt, session, config, store: this.store, activateOnSave, startedAt });
    if ("outcome" in preparedSkills) return preparedSkills.outcome;
    const { skills, routingTurns } = preparedSkills;
    let { request } = preparedSkills;
    const enabled = config.models.filter((model) => model.enabled !== false);
    const savedTask = retainedTask(session);
    // Legacy data supplies evidence, never a guessed workflow or completed scout.
    if (!session.activeTask && savedTask) session.activeTask = savedTask;
    const priorTask = savedTask;
    let taskRelation: TaskRelation = "replace";
    let relationResolved = !priorTask && !session.turns.length;
    const routingState = {
      previousRoute: session.route,
      openTasks: (session.tasks ?? []).filter(task => !task.completed).map(task => task.text),
      hasCodexThread: !!session.threadId,
      activeTask: priorTask,
    };
    const save = () => requiredSave(this.store, session, activateOnSave);
    const stages: StageRecord[] = [];
    const routing: RoutingRecord[] = [];
    const trace: PromptTrace = { version: 1, request: redactTrace(prompt), sections: [], calls: [], vex: [] };
    const runner = tracedRunner(this.runner, trace);
    const secretValues: string[] = [];
    const systemMessages: string[] = [];
    const answeredQuestions: { question: string; answer: string }[] = [];
    const systemMessage = (text: string) => {
      systemMessages.push(text);
      onProgress({ kind: "system", text });
    };
    const { choose, assess } = createTurnRouting({
      vex: this.vex, session, prompts, verifierTurn, routing, save, onProgress, signal, trace,
    });
    const previousPlanRoute = intent === "verify_plan" && session.planRoute
      ? { ...session.planRoute }
      : intent === "continue_verify" && session.verifierThreadId
        ? session.turns.find(turn => turn.intent === "verify_plan")?.route ?? { ...session.route }
        : session.planRoute ? { ...session.planRoute } : { ...session.route };
    let route: Route = intent === "continue_verify" ? session.verifier?.route ?? previousPlanRoute : intent === "revise_plan" ? previousPlanRoute : session.route;
    let note = "Manual route";
    let shape = "single";
    let control = "replace";
    let preserveWorkflow = false;
    let preserveRoute = false;
    if (intent === "revise_plan") {
      taskRelation = "continue";
      relationResolved = true;
      preserveWorkflow = !!session.activeTask?.workflow;
      preserveRoute = !!session.activeTask?.workflow?.mainRoute;
      shape = session.activeTask?.workflow?.shape ?? "plan";
    }
    let usedThreadForClarification = false;
    let handoff: string | undefined;
    let userClarification: string | undefined;
    let fileEdits: string | undefined;
    let editCapture: Awaited<ReturnType<typeof beginFileEdits>> | undefined;
    const finishFileEdits = async () => {
      const capture = editCapture;
      editCapture = undefined;
      if (!capture) return;
      try {
        const recorded = await capture.finish();
        if (recorded.skipped) systemMessage(recorded.skipped);
        else fileEdits = recorded.id ?? "none";
      } catch (error) { systemMessage(`File undo unavailable: ${String(error)}`); }
    };
    let auto = session.routingMode === "auto" || intent === "verify_plan" || intent === "revise_plan";
    let workflowSource: "user" | "vex" = auto ? "vex" : "user";
    const manualWorkflow = !auto && intent !== "verify_plan" && intent !== "revise_plan" ? session.manualWorkflow : undefined;
    const delegated = !!manualWorkflow && Object.values(manualWorkflow.routes).some(value => value === "vex" || (value !== undefined && !value.effort));
    if (!auto) {
      taskRelation = priorTask ? "continue" : "replace";
      relationResolved = true;
    }
    try {
      if (auto || delegated) {
        try {
          await awaitRouting(Promise.resolve(this.vex.verify?.()), signal);
        } catch (error) {
          signal?.throwIfAborted();
          throw new VexUnavailableError(error, "connection");
        }
      }
      if (!enabled.length)
        throw new Error(
          "No models enabled. Open /models and enable one before running a turn.",
        );
      if (
        !auto && !manualWorkflow &&
        !validRoute(session.route, enabled)
      )
        throw new Error(
          "Saved manual route is no longer enabled. Use /models or /auto.",
        );
      if (manualWorkflow) {
        shape = manualWorkflow.shape === "scout_plan_execute" ? "scout_plan"
          : manualWorkflow.shape === "plan_execute" || manualWorkflow.shape === "plan_verify" ? "plan"
          : manualWorkflow.shape;
        note = `Manual ${shape} workflow`;
        for (const selected of Object.values(manualWorkflow.routes)) {
          if (selected !== "vex" && !validRoute(selected, enabled))
            throw new Error("A manual workflow route is no longer enabled. Reopen /manual.");
        }
        if (delegated) {
          await awaitRouting(refreshVersionManifest(), signal);
          pricedModels(enabled);
          if (Object.values(manualWorkflow.routes).includes("vex") && enabled.reduce((count, model) => count + model.efforts.length, 0) > 12)
            throw new Error("Vex routing supports at most 12 model and effort pairs. Narrow /models.");
        }
      }
      if (auto) {
        await awaitRouting(refreshVersionManifest(), signal);
        pricedModels(enabled);
        const choices = enabled.reduce(
          (count, model) => count + model.efforts.length,
          0,
        );
        if (choices > 12)
          throw new Error(
            "Auto routing supports at most 12 model and effort pairs. Narrow /models.",
          );
        if (!verifierTurn && intent !== "revise_plan" && (priorTask || session.turns.length) && intent !== "execute_plan") {
          control = intent === "adopt_side" ? "continue" : (await choose(controlRequest(request, session, prompts), "task control")).choice;
          if (control === "adopt_side") {
            const sources = (session.sideAnswers ?? []).filter(item => item.result && !item.error && item.taskId === session.activeTask?.id);
            const selected = await choose({ question: "Which side answer did the user select to pass to the main task?", constraints: "Select only the side finding referred to by the user. Do not forward every answer.", context: { request, sources }, options: sources.map(item => ({ id: item.id, description: item.question })), decisionType: "routing" }, "side source");
            const source = sources.find(item => item.id === selected.choice)!;
            source.adopted = true; request = adoptedSidePrompt(session, source.id); prompt = request; control = "continue";
          }
          taskRelation = control === "replace" ? "replace" : "continue";
          relationResolved = true;
          preserveWorkflow = ["continue", "reroute"].includes(control) && !!session.activeTask?.workflow;
          preserveRoute = control === "continue" && !!session.activeTask?.workflow?.mainRoute && validRoute(session.activeTask.workflow.mainRoute, enabled);
          if (control === "continue" && session.activeTask?.workflow?.mainRoute && !preserveRoute)
            throw new Error("The task lead route is unavailable. Choose an enabled manual route or ask Vex to reroute.");
          if (preserveWorkflow) { shape = session.activeTask!.workflow!.shape; route = session.activeTask!.workflow!.mainRoute ?? session.route; }
          if (control === "clarify") shape = "clarify";
        }
        if (!verifierTurn && intent !== "revise_plan" && !preserveWorkflow && control !== "clarify") {
          onProgress({ kind: "status", text: "Choosing workflow..." });
          const workflowRequest = shapeRequest(request, routingTurns, enabled, prompts, routingState);
          if (intent === "execute_plan") {
            workflowRequest.options = workflowRequest.options.filter(option => ["single", "scout"].includes(option.id));
            workflowRequest.constraints += "\n\nThe user invoked /execute on a saved plan. Implementation is authorized; select a completion route.";
          } else if (session.kind === "planning")
            workflowRequest.options = workflowRequest.options.filter(option => ["plan", "scout_plan", "clarify"].includes(option.id));
          else if (taskRelation === "continue" && !priorTask && session.threadId)
            workflowRequest.options = workflowRequest.options.filter(option => ["single", "plan", "scout_plan"].includes(option.id));
          else if (taskRelation === "continue" && priorTask)
            workflowRequest.options = workflowRequest.options.filter(option => option.id !== "clarify");
          shape = (await choose(workflowRequest, "workflow")).choice;
        }
        if (shape === "clarify") {
          shape = "single";
          systemMessage("Vex defaulted into single workflow because it was unsure about the deliverable.");
        } else if (!preserveWorkflow && intent !== "verify_plan" && intent !== "revise_plan") {
          systemMessage(`Vex chose ${shape} workflow.`);
        }
        if (shape === "clarify") {

          const clarification = requestWorkflowClarification(session, enabled, onProgress, signal);
          const userDecision = clarification ? await clarification : undefined;

          if (userDecision?.choice === "manual") {
            shape = "single";
            auto = false;
            route = session.route;
            note = `Manual route to ${session.route.model ?? "Codex default"}`;
            systemMessage("Bypassing Vex: running with manual route.");
            answeredQuestions.push({
              question: "Vex is unsure about the deliverable for this request. How would you like to proceed?",
              answer: "Use manual route",
            });
          } else if (userDecision?.choice) {
            workflowSource = "user";
            session.controlDecisions = [...(session.controlDecisions ?? []), { id: randomUUID(), taskId: session.activeTask?.id, role: "main", objective: "workflow clarification", choice: userDecision.choice, confidence: 1, probabilities: { [userDecision.choice]: 1 }, durationMs: 0, at: new Date().toISOString(), source: "user", contextAction: "continue" }];
            await save();
            shape = userDecision.choice;
            note = `User chose ${shape} workflow`;
            systemMessage(`User selected ${shape} workflow.`);
            answeredQuestions.push({
              question: "Vex is unsure about the deliverable for this request. How would you like to proceed?",
              answer: userDecision.choice,
            });
          } else if (userDecision?.clarification) {
            userClarification = userDecision.clarification;
            systemMessage(`Clarification provided: ${userClarification}`);
            request = `${request}\n\nUser clarification on deliverable: ${userClarification}`;
            answeredQuestions.push({
              question: "Vex is unsure about the deliverable for this request. How would you like to proceed?",
              answer: userClarification,
            });
            {
              shape = (
                await choose(
                  shapeRequest(request, routingTurns, enabled, prompts, routingState),
                  "workflow",
                )
              ).choice;
              if (shape === "clarify") throw new Error("Vex still requires clarification. Select a workflow or a manual route.");
            }
            systemMessage(`Vex chose ${shape} workflow.`);
          } else {
            const result =
              taskRelation === "continue" && priorTask
                ? "How should this message change the active task? Specify the requested outcome or select a workflow."
                : taskRelation === "continue"
                ? "I can't identify an earlier task from this conversation. Choose the other saved conversation in the conversation picker, or paste the original request or plan."
                : "What outcome would you like from this request? Please describe the deliverable.";
            const durationMs = Math.round(performance.now() - startedAt);
            session.turns = [
              ...session.turns,
              {
                prompt,
                result,
                at: new Date().toISOString(),
                routeNote: "Vex requested clarification",
                ...(systemMessages.length ? { systemMessages } : {}),
                durationMs,
              },
            ].slice(-20);
            if (session.activeTask?.workflow) session.activeTask.workflow.status = "awaiting_user";
            await save();
            return {
              session,
              result,
              note: "Vex requested clarification",
              route: {},
              durationMs,
              artifacts: [],
              stages,
              routing,
            };
          }
        }
      }
      signal?.throwIfAborted();
      if (!verifierTurn) {
        if (taskRelation === "replace" || !session.activeTask) session.activeTask = advanceTask(undefined, "replace", prompt, "", false);
        else session.activeTask = advanceTask(session.activeTask, "continue", prompt, session.activeTask.latestOutcome ?? "", !!session.activeTask.failed);
        if (control === "replan" && session.activeTask?.workflow) {
          const generation = session.activeTask.workflow.generation + 1;
          session.activeTask.workflow = undefined;
          ensureTask(session, shape as WorkflowShape, auto ? workflowSource : "user");
          session.activeTask.workflow!.generation = generation;
        } else ensureTask(session, shape as WorkflowShape, auto ? workflowSource : "user");
        if (!auto && session.activeTask?.workflow) {
          preserveWorkflow = taskRelation === "continue";
          shape = session.activeTask.workflow.shape;
          if (manualWorkflow && session.activeTask.workflow.mainRoute) {
            if (!validRoute(session.activeTask.workflow.mainRoute, enabled)) throw new Error("The saved manual task route is unavailable. Select a new manual route.");
            preserveRoute = true;
            route = session.activeTask.workflow.mainRoute;
          }
        }
        for (const record of session.controlDecisions ?? []) if (!record.taskId) record.taskId = session.activeTask?.id;
        await save();
      }
      if (shape === "plan" || shape === "scout_plan" || intent === "verify_plan" || intent === "revise_plan") {
        if (!verifierTurn) session.kind = "planning";
        await save();
        if (intent !== "verify_plan" && intent !== "revise_plan")
          systemMessage("Pace switched to planning mode. Only conversation artifacts are writable; use /verify or /execute after the plan is saved.");
      }
      const { conversationArtifacts, planningTurn, planReference, planPath, planBefore, artifactsBefore } = await prepareTurnArtifacts({
        store: this.store, session, prompt, intent, taskRelation, save,
      });
      const trustedFolders = await Promise.all(
        (config.trustedFolders ?? []).map(existingFolder),
      );
      trustedFolders.push(conversationArtifacts);
      signal?.throwIfAborted();
      const workflow = session.activeTask?.workflow;
      handoff = workflow?.scoutHandoff;
      if (!handoff && workflow && ["scout", "scout_plan"].includes(shape)) {
        const recovered = [...(session.attempts ?? [])].reverse().find(item => item.taskId === session.activeTask?.id && item.generation === workflow.generation && item.role === "scout" && item.status === "completed" && item.result);
        if (recovered) {
          try { handoff = structuredHandoff(recovered.result!); workflow.scoutHandoff = handoff; recovered.handoff = handoff; workflow.stage = shape === "scout_plan" ? "plan" : "final"; await save(); }
          catch (error) { if (error instanceof TransitionSaveError) throw error; }
        }
      }
      if (!verifierTurn && (auto || manualWorkflow) && ["scout", "scout_plan"].includes(shape) && !handoff) {
        let scoutAttemptId: string | undefined;
        const stageProgress = (progress: Progress) => {
          if (progress.kind === "system") systemMessages.push(progress.text);
          onProgress(progress);
        };
        const firstHandoff = await runPlanningStage({
          request, routingTurns, enabled, prompts, routingState, choose, runner: durableRunner(runner, this.store, session, "scout", "scout", activateOnSave, async id => { scoutAttemptId = id; }),
          session, signal, onProgress: stageProgress, stages, skills,
          routeOverride: manualWorkflow?.routes.scout,
        });
        handoff = firstHandoff;
        if (session.activeTask?.workflow) { session.activeTask.workflow.scoutHandoff = handoff; session.activeTask.workflow.stage = shape === "scout_plan" ? "plan" : "final"; session.activeTask.workflow.status = "pending"; }
        const attempt = session.attempts!.find(item => item.id === scoutAttemptId)!; attempt.handoff = handoff;
        await save();
        await assess(attempt.id, false);
      }
      if (handoff) onProgress({ kind: "handoff", text: handoff });
      if ((auto || manualWorkflow) && !preserveRoute && intent !== "continue_verify") {
        const objective = intent === "verify_plan"
          ? "Independently verify the saved implementation plan against the repository. Identify concrete errors, missing steps, risks, and propose precise plan changes. Do not edit or save the plan."
          : intent === "revise_plan"
            ? "Revise the saved implementation plan using the user's accepted verification findings. Inspect the repository and save the complete revised plan."
          : session.kind === "planning" ? prompts.objectives.plan : completionObjective(shape, prompts);
        const selected = manualWorkflow?.routes.final ?? (shape === "plan" ? manualWorkflow?.routes.plan : undefined);
        if (!auto && selected && selected !== "vex" && selected.effort) route = selected;
        else {
          const candidates = enabled;
          const available = selected && selected !== "vex" && selected.model
            ? candidates.filter(model => model.model === selected.model) : candidates;
          route = chosenRoute(
            (
              await choose(
                stageRequest(request, routingTurns, available, objective, handoff, available, prompts, routingState),
                objective,
              )
            ).choice,
            available,
          );
          if (auto || (selected && (selected === "vex" || !selected.effort))) {
            systemMessage(`Vex routed to ${route.model ?? "Codex default"} at ${route.effort ?? "default"} reasoning`);
          }
        }
      if (auto && !preserveRoute) note = usedThreadForClarification ? "Vex clarification delegated to existing Codex thread" : `Vex chose ${shape} workflow`;
      }
      signal?.throwIfAborted();
      if (preserveRoute) note = "Vex retained the task stage and lead route";
      if (intent !== "verify_plan" && intent !== "revise_plan" && intent !== "continue_verify") session.route = route;
      if (verifierTurn) session.verifier = { ...(session.verifier ?? {}), route: { ...route } };
      else if (session.activeTask?.workflow) { session.activeTask.workflow.mainRoute = { ...route }; session.activeTask.workflow.needsAssessment = false; }
      await save();
      onProgress({ kind: "route", route, role: verifierTurn ? "verifier" : "main", taskId: session.activeTask?.id });
      onProgress({
        kind: "status",
        text: `${note}: ${route.model ?? "Codex default"} · ${route.effort ?? "default"}`,
      });
      const { promptWithHandoff, resumingDeferred, sections: turnSections } = prepareTurnPrompt({
        prompt, session, intent, userClarification, taskRelation, priorTask,
        usedThreadForClarification, prompts, skills, handoff,
      });
      const executionPrompt = intent === "verify_plan" || intent === "continue_verify"
        ? `${promptWithHandoff}\n\nIndependently verify the plan. Propose precise changes for every finding. Work read-only; do not edit or save the plan.`
        : planningTurn ? planningPrompt(promptWithHandoff, session.projectPath, planPath!, planBefore ?? session.plan, await loadPlanningInstructions(), intent === "revise_plan" ? session.turns.at(-1)?.result : undefined) : promptWithHandoff;
      const memoryConfig = (await loadMemory(session.projectPath, this.store.baseDir)).config;
      const memoryRevision = memoryConfig?.revision ?? 'unconfigured';
      if (!verifierTurn && session.memoryRevision !== memoryRevision && (memoryConfig || session.memoryRevision)) {
        session.threadId = undefined;
        session.memoryRevision = memoryRevision;
        systemMessage('Memory settings changed. Starting a fresh agent thread with retained conversation history.');
      }
      const { runnerPrompt, runThreadId, checkpoint, sections: runnerSections } = prepareRunnerPrompt({
        executionPrompt, session, intent, verifierTurn, planningTurn, skills,
      });
      trace.workflow = shape;
      trace.sections = redactTrace([...turnSections, ...promptChange("Pace planning / verifier instructions", promptWithHandoff, executionPrompt), ...runnerSections]);
      if (checkpoint) onProgress({ kind: "status", text: "Starting fresh thread from checkpoint…" });
      const stageStart = performance.now();
      if (!verifierTurn) session.undoneTurns = undefined;
      if (!planningTurn && !verifierTurn && intent !== "revise_plan") {
        try { editCapture = await beginFileEdits(this.store, session); }
        catch (error) { systemMessage(`File undo unavailable: ${String(error)}`); }
      }
      const role = verifierTurn ? "verifier" : "main";
      let completedAttemptId: string | undefined;
      const execution = await durableRunner(runner, this.store, session, role, verifierTurn ? "verify" : planningTurn ? "plan" : "final", activateOnSave, async id => { completedAttemptId = id; }).run(
        runnerPrompt,
        session.projectPath,
        route,
        runThreadId,
        async (progress) => {
          if (progress.kind === "thread") {
            if (verifierTurn) { session.verifierThreadId = progress.text; session.verifier!.threadId = progress.text; }
            else session.threadId = progress.text;
            if (progress.text !== runThreadId) { if (verifierTurn) session.verifier!.threadTurnCount = 0; else session.threadTurnCount = 0; }
            if (intent !== "verify_plan" && intent !== "continue_verify" && !planningTurn && session.autoLaunchSkills?.length) session.autoLaunchThreadId = progress.text;
          } else if (progress.kind === "question") {
            onProgress({ ...progress, respond: (answers: UserAnswers) => {
              for (const item of progress.questions) {
                const answer = answers[item.id]?.answers[0];
                if (item.isSecret) secretValues.push(item.question, item.header, ...item.options.flatMap(option => [option.label, option.description]), ...(answers[item.id]?.answers ?? []));
                Object.assign(trace, redactTrace(trace, secretValues));
                if (answer) answeredQuestions.push({ question: item.isSecret ? "[hidden]" : item.question, answer: item.isSecret ? "[hidden]" : answer });
              }
              progress.respond(answers);
            } });
          } else onProgress(progress);
        },
        signal,
        intent === "verify_plan" || intent === "continue_verify" ? "side" : planningTurn ? "planning" : "main",
        trustedFolders,
        config.approvalMode,
        conversationArtifacts,
        { recallQuery: taskRelation === 'replace' || !runThreadId ? prompt : undefined },
      );
      await finishFileEdits();
      signal?.throwIfAborted();
      stages.push({
        objective: intent === "verify_plan" ? "Verify plan" : intent === "continue_verify" ? "Continue plan verification" : intent === "revise_plan" ? "Revise plan" : session.kind === "planning" ? "Draft plan" : "Complete request",
        route,
        durationMs: Math.round(performance.now() - stageStart),
        usage: execution.usage,
        estimatedCostUsd: costForUsage(route, execution.usage),
      });
      if (execution.threadId) {
        if (verifierTurn) { session.verifierThreadId = execution.threadId; session.verifier!.threadId = execution.threadId; }
        else session.threadId = execution.threadId;
        if (!verifierTurn && intent !== "revise_plan" && !planningTurn && session.autoLaunchSkills?.length) session.autoLaunchThreadId = execution.threadId;
      }
      const planChanged = planningTurn
        ? await finishPlanArtifact({ session, route, planPath: planPath!, planBefore, planReference, systemMessage })
        : false;
      if (checkpoint && session.threadId === checkpoint.threadId) {
        session.threadId = undefined;
        onProgress({ kind: "error", text: "Fresh Codex thread ID was unavailable; the next turn will use retained conversation history." });
      }
      if (verifierTurn) {
        session.verifier!.threadTurnCount = runThreadId && execution.threadId === runThreadId ? (session.verifier!.threadTurnCount ?? 0) + 1 : 1;
        session.verifier!.context = execution.context;
      } else {
        session.threadTurnCount = runThreadId && session.threadId === runThreadId ? (session.threadTurnCount ?? session.turns.length) + 1 : 1;
        if (session.threadId) {
          session.contextByThread ??= {};
          if (execution.context) session.contextByThread[session.threadId] = execution.context;
          else delete session.contextByThread[session.threadId];
        }
        if (session.activeTask?.workflow) session.activeTask.workflow.mainThreadId = session.threadId;
      }
      const artifacts = changedArtifacts(
        artifactsBefore,
        await artifactSnapshot(conversationArtifacts).catch(
          () => new Map<string, number>(),
        ),
      );
      if (planChanged && planReference && !artifacts.includes(planReference)) artifacts.push(planReference);
      if (intent === "revise_plan") session.route = previousPlanRoute;

      const durationMs = Math.round(performance.now() - startedAt);
      const usage = addUsage(stages);
      const estimatedCostUsd = stages.every(
        (stage) => stage.estimatedCostUsd !== undefined,
      )
        ? stages.reduce((sum, stage) => sum + stage.estimatedCostUsd!, 0)
        : undefined;
      session.turns = [
        ...session.turns,
        {
          prompt,
          ...(intent ? { intent } : {}),
          ...(queuedOperation ? { operation: queuedOperation } : {}),
          ...(fileEdits ? { fileEdits } : {}),
          ...(displayPrompt ? { displayPrompt } : {}),
          result: execution.result,
          memoryAttemptId: completedAttemptId,
          at: new Date().toISOString(),
          route,
          routeNote: note,
          ...(systemMessages.length ? { systemMessages } : {}),
          ...(handoff ? { scoutHandoff: handoff } : {}),
          promptTrace: redactTrace(trace, secretValues),
          questions: answeredQuestions,
          durationMs,
          artifacts,
          usage,
          stages,
          routing,
          estimatedCostUsd,
        },
      ].slice(-20);
      const completedAttempt = session.attempts!.find(item => item.id === completedAttemptId)!;
      completedAttempt.observations.push({ kind: "artifacts", paths: artifacts });
      if (!verifierTurn && session.activeTask) { session.activeTask.latestOutcome = execution.result.slice(0, 2000); session.activeTask.failed = false; session.activeTask.assessment = "unknown"; }
      await save();
      await assess(completedAttempt.id, !verifierTurn);
      session.turns.at(-1)!.promptTrace = redactTrace(trace, secretValues);
      if (resumingDeferred) session.deferredTurn = undefined;
      await save();
      return {
        session,
        result: execution.result,
        role: verifierTurn ? "verifier" : "main",
        note,
        route,
        durationMs,
        artifacts,
        usage,
        stages,
        routing,
        estimatedCostUsd,
      };
    } catch (error) {
      await finishFileEdits();
      if (error instanceof TransitionSaveError) throw error;
      const cancelled = !!signal?.aborted;
      const previousFailure = session.turns.at(-1);
      const repeatedFailure = previousFailure?.failed && !previousFailure.cancelled && previousFailure.prompt === prompt;
      // A retry with no new edits can reuse the previous snapshot. Changed retries keep separate history.
      if (repeatedFailure && fileEdits === "none" && previousFailure.fileEdits) fileEdits = previousFailure.fileEdits;
      const retainedTurns = repeatedFailure &&
        (!previousFailure.fileEdits || previousFailure.fileEdits === "none" || fileEdits === previousFailure.fileEdits)
        ? session.turns.slice(0, -1) : session.turns;
      session.turns = [
        ...retainedTurns,
        {
          prompt,
          ...(fileEdits ? { fileEdits } : {}),
          ...(displayPrompt ? { displayPrompt } : {}),
          ...(intent ? { intent } : {}),
          ...(queuedOperation ? { operation: queuedOperation } : {}),
          result: cancelled ? "Turn cancelled by user" : String(error),
          at: new Date().toISOString(),
          route,
          routeNote: note,
          ...(systemMessages.length ? { systemMessages } : {}),
          ...(handoff ? { scoutHandoff: handoff } : {}),
          promptTrace: redactTrace(trace, secretValues),
          questions: answeredQuestions,
          durationMs: Math.round(performance.now() - startedAt),
          failed: true,
          cancelled,
          stages,
          routing,
        },
      ].slice(-20);
      if (!verifierTurn && relationResolved && session.activeTask) { session.activeTask.latestOutcome = String(error).slice(0, 2000); session.activeTask.failed = true; session.activeTask.assessment = "unknown"; }
      await save();
      throw error;
    }
  }
}
