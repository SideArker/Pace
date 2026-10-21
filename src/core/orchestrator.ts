import { randomUUID } from "node:crypto";
import type { Usage } from "@openai/codex-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Config, Route, Session, AgentRole, OperationIntent, QueuedOperation, WorkflowShape, TaskAssessment } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import type { UserAnswers } from "../integrations/codex-types.js";
import {
  VexRouter,
  shapeRequest,
  stageRequest,
  controlRequest,
  assessmentRequest,
  type VexRequest,
} from "./vex/client.js";
import {
  chosenRoute,
  validateDecision,
  type RoutingDecision,
} from "./routing/router.js";
import { costForUsage, pricedModels, refreshVersionManifest } from "./routing/pricing.js";
import { advanceTask, retainedTask, type TaskRelation } from "./active-task.js";
import { PaceStore } from "./sessions.js";
import { retryableTurn } from "./session-model.js";
import { verifyPlanPrompt, tryReadPlanFile, structuredHandoff, addUsage, awaitRouting, loadPlanningInstructions, planningPrompt, retainedConversationPrompt } from "./orchestrator-helpers.js";
import { runPlanningStage } from "./workflow-stages.js";
import { durableRunner, ensureTask, requiredSave, TransitionSaveError, UncertainAttemptError } from "./task-execution.js";
import { operation, preparePlanExecution, adoptedSidePrompt, currentPlan } from "./operations.js";
import { runAside } from "./side-answers.js";
import { checkpointHandoff } from "./checkpoint.js";
import { beginFileEdits } from "./file-edits.js";
import { artifactDirectory, artifactPath, artifactSnapshot, changedArtifacts, planArtifactReference } from "./system/artifacts.js";
import { validRoute } from "../shared/config.js";
import { existingFolder } from "./system/folders.js";
import {
  autoLaunchPrompt,
  configuredSkills,
  enabledSkills,
  skillCommand,
  skillOption,
  skillPrompt,
  skillRequest,
} from "./system/skills.js";
import {
  DEFAULT_ROUTING_PROMPTS,
  completionObjective,
  loadRoutingPrompts,
  type RoutingPrompts,
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
export class VexUnavailableError extends Error {
  constructor(
    cause: unknown,
    readonly source: "connection" | "decision",
  ) {
    super(`Vex routing failed: ${String(cause)}`);
  }
}
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
    if (queuedOperation) {
      const target = session.executionSource?.sessionId ?? session.id;
      if (queuedOperation.sessionId !== target || (queuedOperation.taskId && !session.executionSource && queuedOperation.taskId !== session.activeTask?.id)) throw new Error("Queued operation belongs to another task or session");
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
    if (queuedOperation) {
      const target = session.executionSource?.sessionId ?? session.id;
      if (queuedOperation.sessionId !== target) throw new Error("Queued operation belongs to another session");
      if (queuedOperation.taskId && !session.executionSource && queuedOperation.taskId !== session.activeTask?.id)
        throw new Error("Queued operation belongs to another task; resolve its target before running it");
    }
    if (intent === "aside") return this.aside(prompt.replace(/^\/btw(?:\s+|$)/, ""), session, config, onProgress, signal, activateOnSave);
    if (intent === "adopt_side") {
      if (!queuedOperation?.sourceSideId) throw new Error("Choose the source side answer before forwarding it");
      await requiredSave(this.store, session, activateOnSave);
      prompt = adoptedSidePrompt(session, queuedOperation.sourceSideId);
      const side = session.sideAnswers!.find(item => item.id === queuedOperation.sourceSideId)!;
      side.adopted = true;
    }
    const verifierTurn = intent === "verify_plan" || intent === "continue_verify";
    const uncertain = (session.attempts ?? []).filter(item => ["running", "awaiting_user"].includes(item.status) && (verifierTurn ? item.role === "verifier" : item.role === "main" || item.role === "scout"));
    if (uncertain.length) throw new UncertainAttemptError(uncertain);
    if (
      /^(?:stop caveman|normal mode)$/i.test(prompt.trim()) &&
      session.activeSkills?.includes("caveman")
    ) {
      session.activeSkills = session.activeSkills.filter(
        (name) => name !== "caveman",
      );
      if (session.skillOptions) delete session.skillOptions.caveman;
      await this.store.saveChanges(session, activateOnSave);
      return {
        session,
        result: "/caveman disabled for this conversation.",
        note: "Skill command",
        route: session.route,
        durationMs: Math.round(performance.now() - startedAt),
        artifacts: [],
        stages: [],
        routing: [],
      };
    }
    const skills = enabledSkills(await configuredSkills(config), config);
    const invoked = skillCommand(prompt, skills);
    let request = invoked ? skillRequest(prompt, invoked) : prompt;
    const option = invoked ? skillOption(invoked, request) : undefined;
    if (invoked) {
      const active = session.activeSkills ?? [];
      session.activeSkills =
        request === "off"
          ? active.filter((name) => name !== invoked.name)
          : [...new Set([...active, invoked.name])];
      session.skillOptions ??= {};
      if (!request || request === "off")
        delete session.skillOptions[invoked.name];
      else if (option) session.skillOptions[invoked.name] = option;
      if (!request || request === "off" || option) {
        await this.store.saveChanges(session, activateOnSave);
        const result =
          "/" +
          invoked.name +
          (option ? " " + option : "") +
          " " +
          (request === "off" ? "disabled" : "active") +
          " for this conversation.";
        return {
          session,
          result,
          note: "Skill command",
          route: session.route,
          durationMs: Math.round(performance.now() - startedAt),
          artifacts: [],
          stages: [],
          routing: [],
        };
      }
    }
    const routingTurns = session.turns.map((turn) => {
      const previousSkill = skillCommand(turn.prompt, skills);
      return previousSkill
        ? { ...turn, prompt: skillRequest(turn.prompt, previousSkill) }
        : turn;
    });
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
    const systemMessages: string[] = [];
    const answeredQuestions: { question: string; answer: string }[] = [];
    const systemMessage = (text: string) => {
      systemMessages.push(text);
      onProgress({ kind: "system", text });
    };
    const choose = async (
      request: VexRequest,
      objective: string,
    ): Promise<RoutingDecision> => {
      let failure: unknown;
      const decisionStarted = performance.now();
      for (let attempt = 1; attempt <= 2; attempt++) {
        signal?.throwIfAborted();
        try {
          const decision = validateDecision(
            await awaitRouting(this.vex.choose(request), signal),
            request.options,
          );
          signal?.throwIfAborted();
          routing.push({
            objective,
            choice: decision.choice,
            choiceLabel: request.options.find(option => option.id === decision.choice)?.description,
            confidence: decision.confidence,
            probabilities: decision.probabilities,
            attempts: attempt,
          });
          session.controlDecisions = [...(session.controlDecisions ?? []), {
            id: randomUUID(), taskId: session.activeTask?.id, stage: session.activeTask?.workflow?.stage,
            role: verifierTurn ? "verifier" : "main", objective, choice: decision.choice, confidence: decision.confidence,
            probabilities: decision.probabilities, durationMs: Math.round(performance.now() - decisionStarted), at: new Date().toISOString(), source: "vex", contextAction: "continue",
          }];
          await save();
          return decision;
        } catch (error) {
          if (error instanceof TransitionSaveError) throw error;
          signal?.throwIfAborted();
          failure = error;
        }
      }
      throw new VexUnavailableError(failure, "decision");
    };
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
    const assess = async (attemptId: string, updateTask: boolean) => {
      const attempt = session.attempts?.find(item => item.id === attemptId);
      if (!attempt) return;
      try {
        const decision = await choose(assessmentRequest(session, attemptId, prompts), "task completion assessment");
        const record = session.controlDecisions!.at(-1)!;
        record.attemptId = attemptId; record.taskId = attempt.taskId; record.role = attempt.role; record.stage = attempt.stage;
        const currentAttempt = session.attempts!.find(item => item.id === attemptId)!;
        currentAttempt.assessment = { value: decision.choice as TaskAssessment, evidence: currentAttempt.observations.length, decisionId: record.id };
        if (updateTask && session.activeTask) session.activeTask.assessment = decision.choice as TaskAssessment;
        await save();
      } catch (error) {
        if (error instanceof TransitionSaveError) throw error;
        if (updateTask && session.activeTask) session.activeTask.assessment = "unknown";
        onProgress({ kind: "error", text: `Task completion is unknown: ${String(error)}` });
        await save();
      }
    };
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
          if (control === "aside") return this.aside(prompt, session, config, onProgress, signal, activateOnSave);
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
        if (shape !== "clarify" && intent !== "verify_plan" && intent !== "revise_plan") {
          const desc = prompts.workflow.choices[shape as keyof typeof prompts.workflow.choices] ?? shape;
          systemMessage(`Vex chose ${shape}: ${desc}`);
        }
        if (shape === "clarify") {

          const isInteractive = (onProgress as { interactive?: boolean }).interactive === true;
          let userDecision: { choice?: string; clarification?: string; cancelled?: boolean } | undefined;

          if (isInteractive) {
            onProgress({ kind: "status", text: "Waiting for clarification..." });
            const formatRoute = (r?: Route) => {
              if (!r?.model) return "Codex default";
              const name = r.model.replace(
                /^gpt-(\d+)-(.+)$/,
                (_match, version: string, n: string) =>
                  `GPT-${version} ${n[0]!.toUpperCase()}${n.slice(1)}`,
              );
              return `${name}${r.effort ? ` ${r.effort[0]!.toUpperCase()}${r.effort.slice(1)}` : ""}`;
            };
            const defaultRouteDesc = formatRoute(session.route);
            const options = [
              {
                label: "Run as single agent",
                description: "Direct answer or action using the standard route",
              },
              ...(enabled.some(m => m.efforts.length > 0)
                ? [
                    {
                      label: "Scout codebase first",
                      description: "Read-only exploration to find files and report context",
                    },
                  ]
                : []),
              { label: "Plan only", description: "Save a plan in conversation artifacts; use /execute later" },
            ];
            if (session.route?.model) {
              options.push({
                label: `Use manual route (${defaultRouteDesc})`,
                description: `Bypass workflow and route stages directly to ${defaultRouteDesc}`,
              });
            }

            userDecision = await new Promise<{ choice?: string; clarification?: string; cancelled?: boolean }>((resolve) => {
              const questionId = `clarify-${Date.now()}`;
              const abortListener = () => resolve({ cancelled: true });
              signal?.addEventListener("abort", abortListener, { once: true });

              onProgress({
                kind: "question",
                id: questionId,
                questions: [
                  {
                    id: "workflow",
                    header: "Clarification Needed",
                    question: "Vex is unsure about the deliverable for this request. How would you like to proceed?",
                    options,
                    isOther: true,
                    isSecret: false,
                  },
                ],
                respond: (answers: UserAnswers) => {
                  signal?.removeEventListener("abort", abortListener);
                  const val = answers["workflow"]?.answers[0]?.trim();
                  if (!val) {
                    resolve({ cancelled: true });
                    return;
                  }
                  if (val === "Run as single agent") {
                    resolve({ choice: "single" });
                  } else if (val === "Scout codebase first") {
                    resolve({ choice: "scout" });
                  } else if (val === "Plan only") {
                    resolve({ choice: "plan" });
                  } else if (val.startsWith("Use manual route")) {
                    resolve({ choice: "manual" });
                  } else {
                    resolve({ clarification: val });
                  }
                },
              });
            });
          }

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
            const desc = prompts.workflow.choices[shape as keyof typeof prompts.workflow.choices] ?? shape;
            systemMessage(`Vex chose ${shape}: ${desc}`);
          } else {
            const result =
              taskRelation === "continue" && priorTask
                ? "How should this message change the active task? Specify the requested outcome or select a workflow."
                : taskRelation === "continue"
                ? "I can't identify an earlier task from this conversation. Open /resume if the work is in another saved conversation, or paste the original request or plan."
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
          ensureTask(session, shape as WorkflowShape, auto ? "vex" : "user");
          session.activeTask.workflow!.generation = generation;
        } else ensureTask(session, shape as WorkflowShape, auto ? "vex" : "user");
        if (!auto && session.activeTask?.workflow) {
          preserveWorkflow = taskRelation === "continue";
          shape = session.activeTask.workflow.shape;
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
      const conversationArtifacts = artifactDirectory(this.store, session);
      await mkdir(conversationArtifacts, { recursive: true });
      const planningTurn = session.kind === "planning" && (intent === "revise_plan" || !intent);
      const pendingPlanBeforeTurn = session.pendingPlanArtifact;
      const separatePlan = planningTurn && !!session.planArtifact && !pendingPlanBeforeTurn && taskRelation === "replace";
      const planReference = planningTurn ? planArtifactReference(session.id, prompt, session.pendingPlanArtifact ?? session.planArtifact, separatePlan) : undefined;
      const planPath = planReference ? artifactPath(this.store, session, planReference) : undefined;
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
          request, routingTurns, enabled, prompts, routingState, choose, runner: durableRunner(this.runner, this.store, session, "scout", "scout", activateOnSave, async id => { scoutAttemptId = id; }),
          session, signal, onProgress: stageProgress, stages,
          routeOverride: manualWorkflow?.routes.scout,
        });
        handoff = firstHandoff;
        if (session.activeTask?.workflow) { session.activeTask.workflow.scoutHandoff = handoff; session.activeTask.workflow.stage = shape === "scout_plan" ? "plan" : "final"; }
        const attempt = session.attempts!.find(item => item.id === scoutAttemptId)!; attempt.handoff = handoff;
        await save();
        await assess(attempt.id, false);
      }
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
        if (preserveRoute) note = "Vex retained the task stage and lead route";
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
      const basePrompt = userClarification
        ? `${prompt}\n\nClarification: ${userClarification}`
        : prompt;
      const resumingDeferred = session.deferredTurn?.prompt === prompt;
      const resumedAfterLimit = resumingDeferred && (!session.deferredTurn?.reason || session.deferredTurn.reason === "usage");
      const retryingFailure = retryableTurn(session)?.prompt === prompt;
      const resolvedPrompt = taskRelation === "continue" && priorTask && !session.threadId
        ? `${basePrompt}\n\nPace's saved task brief (verify against conversation): ${priorTask.originalRequest}\nLater instructions: ${JSON.stringify(priorTask.instructions)}\nLast outcome: ${priorTask.latestOutcome ?? "Unknown"}\n${prompts.execution.savedTaskInstruction}`
        : (taskRelation === "continue" || usedThreadForClarification) && session.threadId && intent !== "verify_plan" && intent !== "revise_plan"
          ? `${basePrompt}\n\n${prompts.execution.existingThreadInstruction}`
          : basePrompt;
      const safePrompt = resumedAfterLimit
        ? `${resolvedPrompt}\n\n${prompts.execution.usageRetryInstruction}`
        : retryingFailure
          ? `${resolvedPrompt}\n\nThis request was interrupted by an error. Inspect current files and prior conversation before editing. Continue only unfinished work. Report completed work, remaining work, and checks.`
          : resolvedPrompt;
      const baseExecutionPrompt = skillPrompt(
        `${safePrompt}\n\n${prompts.execution.coverageInstruction}`,
        skills,
        session.activeSkills,
        session.skillOptions,
      );
      const promptWithHandoff = handoff
        ? `${baseExecutionPrompt}\n\n${prompts.handoff.reportInstruction}\n${handoff}`
        : baseExecutionPrompt;
      const executionPrompt = intent === "verify_plan" || intent === "continue_verify"
        ? `${promptWithHandoff}\n\nIndependently verify the plan. Propose precise changes for every finding. Work read-only; do not edit or save the plan.`
        : planningTurn ? planningPrompt(promptWithHandoff, session.projectPath, planPath!, planBefore ?? session.plan, await loadPlanningInstructions(), intent === "revise_plan" ? session.turns.at(-1)?.result : undefined) : promptWithHandoff;
      const checkpoint = !verifierTurn && intent !== "revise_plan" && session.checkpoint?.threadId === session.threadId &&
        session.turns.some(turn => turn.at === session.checkpoint?.sourceTurnAt)
        ? session.checkpoint : undefined;
      const runThreadId = intent === "continue_verify" ? session.verifier?.threadId ?? session.verifierThreadId : checkpoint || intent === "verify_plan" ? undefined : session.threadId;
      const checkpointTurn = checkpoint ? session.turns.findIndex(turn => turn.at === checkpoint.sourceTurnAt) : -1;
      const promptWithHistory = checkpoint
        ? checkpointHandoff(checkpoint.note, session.turns.slice(checkpointTurn + 1).filter(turn => !turn.failed).slice(-3).map(turn => ({ user: turn.prompt.slice(0, 1000), assistant: turn.result.slice(0, 1000) })), executionPrompt)
        : retainedConversationPrompt(executionPrompt, intent === "verify_plan" || intent === "revise_plan" ? { ...session, threadId: undefined, turns: [] } : session);
      const selectedAutoSkills = !runThreadId && intent !== "verify_plan" && intent !== "revise_plan" && !planningTurn
        ? skills.filter(skill => session.autoLaunchSkills?.includes(skill.name)) : [];
      const runnerPrompt = autoLaunchPrompt(promptWithHistory, selectedAutoSkills);
      if (checkpoint) onProgress({ kind: "status", text: "Starting fresh thread from checkpoint…" });
      const stageStart = performance.now();
      session.undoneTurns = undefined;
      if (!planningTurn && intent !== "verify_plan" && intent !== "revise_plan") {
        try { editCapture = await beginFileEdits(this.store, session); }
        catch (error) { systemMessage(`File undo unavailable: ${String(error)}`); }
      }
      const role = verifierTurn ? "verifier" : "main";
      let completedAttemptId: string | undefined;
      const execution = await durableRunner(this.runner, this.store, session, role, verifierTurn ? "verify" : planningTurn ? "plan" : "final", activateOnSave, async id => { completedAttemptId = id; }).run(
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
            await save();
          } else if (progress.kind === "question") {
            onProgress({ ...progress, respond: (answers: UserAnswers) => {
              for (const item of progress.questions) {
                const answer = answers[item.id]?.answers[0];
                if (answer) answeredQuestions.push({ question: item.question, answer: item.isSecret ? "[hidden]" : answer });
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
        if (intent !== "verify_plan" && intent !== "revise_plan" && !planningTurn && session.autoLaunchSkills?.length) session.autoLaunchThreadId = execution.threadId;
      }
      let planChanged = false;
      if (planningTurn) {
        let planAfter: string | undefined;
        try { planAfter = await readFile(planPath!, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (planAfter !== undefined && !planAfter.trim() && planBefore?.trim()) {
          await writeFile(planPath!, planBefore, "utf8");
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
      }
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
          at: new Date().toISOString(),
          route,
          routeNote: note,
          ...(systemMessages.length ? { systemMessages } : {}),
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
