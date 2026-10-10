import type { Usage } from "@openai/codex-sdk";
import type { Config, Route, Session } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import type { UserAnswers } from "../integrations/codex-types.js";
import {
  VexRouter,
  shapeRequest,
  stageRequest,
  taskRelationRequest,
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
import { addUsage, awaitRouting, retainedConversationPrompt } from "./orchestrator-helpers.js";
import { runPlanningStage } from "./workflow-stages.js";
import { checkpointHandoff } from "./checkpoint.js";
import { artifactSnapshot, changedArtifacts } from "./system/artifacts.js";
import { validRoute } from "../shared/config.js";
import { existingFolder } from "./system/folders.js";
import {
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
  async turn(
    prompt: string,
    session: Session,
    config: Config,
    onProgress: (progress: Progress) => void,
    signal?: AbortSignal,
    activateOnSave: boolean | (() => boolean) = true,
  ): Promise<TurnOutcome> {
    const startedAt = performance.now();
    const prompts =
      session.routingMode === "auto"
        ? loadRoutingPrompts(this.store.baseDir)
        : DEFAULT_ROUTING_PROMPTS;
    if (
      /^(?:stop caveman|normal mode)$/i.test(prompt.trim()) &&
      session.activeSkills?.includes("caveman")
    ) {
      session.activeSkills = session.activeSkills.filter(
        (name) => name !== "caveman",
      );
      if (session.skillOptions) delete session.skillOptions.caveman;
      await this.store.save(session, activateOnSave);
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
        await this.store.save(session, activateOnSave);
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
    const priorTask = retainedTask(session);
    let taskRelation: TaskRelation = "replace";
    let relationResolved = !priorTask && !session.turns.length;
    const routingState = {
      previousRoute: session.route,
      openTasks: (session.tasks ?? []).filter(task => !task.completed).map(task => task.text),
      hasCodexThread: !!session.threadId,
      activeTask: priorTask,
    };
    const save = async () => {
      try {
        await this.store.save(session, activateOnSave);
      } catch (error) {
        onProgress({
          kind: "error",
          text: `Pace session was not saved: ${String(error)}`,
        });
      }
    };
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
          return decision;
        } catch (error) {
          signal?.throwIfAborted();
          failure = error;
        }
      }
      throw new VexUnavailableError(failure, "decision");
    };
    let route: Route = session.route;
    let note = "Manual route";
    let shape = "single";
    let usedThreadForClarification = false;
    let handoff: string | undefined;
    let userClarification: string | undefined;
    let auto = session.routingMode === "auto";
    const manualWorkflow = !auto ? session.manualWorkflow : undefined;
    const delegated = !!manualWorkflow && Object.values(manualWorkflow.routes).some(value => value === "vex");
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
        session.routingMode === "manual" && !manualWorkflow &&
        !validRoute(session.route, enabled)
      )
        throw new Error(
          "Saved manual route is no longer enabled. Use /models or /auto.",
        );
      if (manualWorkflow) {
        shape = manualWorkflow.shape;
        note = `Manual ${shape} workflow`;
        for (const selected of Object.values(manualWorkflow.routes)) {
          if (selected !== "vex" && !validRoute(selected, enabled))
            throw new Error("A manual workflow route is no longer enabled. Reopen /manual.");
        }
        if (delegated) {
          await awaitRouting(refreshVersionManifest(), signal);
          pricedModels(enabled);
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
        if (priorTask || session.turns.length) {
          onProgress({ kind: "status", text: "Resolving conversation..." });
          taskRelation = (await choose(taskRelationRequest(request, routingTurns, routingState, prompts), "task relation")).choice as TaskRelation;
          relationResolved = true;
        }
        onProgress({ kind: "status", text: "Choosing workflow..." });
        const workflowRequest = shapeRequest(request, routingTurns, enabled, prompts, routingState);
        if (taskRelation === "continue" && !priorTask && session.threadId)
          workflowRequest.options = workflowRequest.options.filter(option => option.id === "single");
        else if (taskRelation === "continue" && priorTask)
          workflowRequest.options = workflowRequest.options.filter(option => option.id !== "clarify");
        shape = (
          await choose(
            workflowRequest,
            "workflow",
          )
        ).choice;
        if (shape === "clarify" && session.threadId) {
          shape = "single";
          usedThreadForClarification = true;
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
              ...(enabled.some((m) => m.model === "gpt-6-luna")
                ? [
                    {
                      label: "Scout codebase first",
                      description: "Read-only exploration to find files and report context",
                    },
                  ]
                : []),
              {
                label: "Plan & execute",
                description: "Create an implementation plan first, then execute",
              },
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
                  } else if (val === "Plan & execute") {
                    resolve({ choice: "plan_execute" });
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
            try {
              shape = (
                await choose(
                  shapeRequest(request, routingTurns, enabled, prompts, routingState),
                  "workflow",
                )
              ).choice;
              if (shape === "clarify") shape = "single";
            } catch {
              shape = "single";
            }
          } else {
            const result =
              taskRelation === "continue"
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
      const artifactsBefore = await artifactSnapshot(session.projectPath).catch(
        () => new Map<string, number>(),
      );
      const trustedFolders = await Promise.all(
        (config.trustedFolders ?? []).map(existingFolder),
      );
      signal?.throwIfAborted();
      if ((auto || manualWorkflow) && ["scout", "plan_execute", "scout_plan_execute", "plan_verify"].includes(shape)) {
        const firstShape = shape === "scout_plan_execute" ? "scout" : shape as "scout" | "plan_execute";
        const firstStage = firstShape === "scout" ? "scout" : "plan";
        const firstHandoff = await runPlanningStage({
          shape: firstShape, request, routingTurns, enabled, prompts, routingState, choose, runner: this.runner,
          session, signal, onProgress, stages,
          routeOverride: manualWorkflow?.routes[firstStage] === "vex" ? undefined : manualWorkflow?.routes[firstStage],
        });
        handoff = firstHandoff;
        if (shape === "scout_plan_execute") {
          const planHandoff = await runPlanningStage({
            shape: "plan_execute", request, routingTurns, enabled, prompts, routingState, choose, runner: this.runner,
            session, signal, onProgress, stages, priorHandoff: firstHandoff,
            routeOverride: manualWorkflow?.routes.plan === "vex" ? undefined : manualWorkflow?.routes.plan,
          });
          handoff = `Scout report:\n${firstHandoff}\n\nPlanning report:\n${planHandoff}`;
        }
      }
      if (auto || manualWorkflow) {
        const objective = shape === "plan_verify" ? "Review the read-only plan and return a corrected final plan without implementing it" : completionObjective(shape, prompts);
        const selected = manualWorkflow?.routes.final;
        if (!auto && selected && selected !== "vex") route = selected;
        else {
        route = chosenRoute(
          (
            await choose(
              stageRequest(
                request,
                routingTurns,
                enabled,
                objective,
                handoff,
                enabled,
                prompts,
                routingState,
              ),
              objective,
            )
          ).choice,
          enabled,
        );
        }
        if (auto) note = usedThreadForClarification ? "Vex clarification delegated to existing Codex thread" : `Vex chose ${shape} workflow`;
      }
      signal?.throwIfAborted();
      session.route = route;
      await save();
      onProgress({ kind: "route", route });
      onProgress({
        kind: "status",
        text: `${note}: ${route.model ?? "Codex default"} · ${route.effort ?? "default"}`,
      });
      const basePrompt = userClarification
        ? `${prompt}\n\nClarification: ${userClarification}`
        : prompt;
      const resumedAfterLimit = session.deferredTurn?.prompt === prompt;
      const resolvedPrompt = taskRelation === "continue" && priorTask && !session.threadId
        ? `${basePrompt}\n\nPace's saved task brief (verify against conversation): ${priorTask.originalRequest}\nLater instructions: ${JSON.stringify(priorTask.instructions)}\nLast outcome: ${priorTask.latestOutcome ?? "Unknown"}\n${prompts.execution.savedTaskInstruction}`
        : (taskRelation === "continue" || usedThreadForClarification) && session.threadId
          ? `${basePrompt}\n\n${prompts.execution.existingThreadInstruction}`
          : basePrompt;
      const safePrompt = resumedAfterLimit
        ? `${resolvedPrompt}\n\n${prompts.execution.usageRetryInstruction}`
        : resolvedPrompt;
      const executionPrompt = handoff
        ? `${skillPrompt(safePrompt, skills, session.activeSkills, session.skillOptions)}${shape === "plan_execute" || shape === "scout_plan_execute" ? `\n\n${prompts.handoff.planExecutionInstruction}` : shape === "plan_verify" ? "\n\nReview the planning report against the repository. Return a final corrected plan and your verification findings. Work read only; do not implement." : ""}\n\n${prompts.handoff.reportInstruction}\n${handoff}`
        : skillPrompt(
            safePrompt,
            skills,
            session.activeSkills,
            session.skillOptions,
          );
      const checkpoint = session.checkpoint?.threadId === session.threadId &&
        session.turns.some(turn => turn.at === session.checkpoint?.sourceTurnAt)
        ? session.checkpoint : undefined;
      const runThreadId = checkpoint ? undefined : session.threadId;
      const checkpointTurn = checkpoint ? session.turns.findIndex(turn => turn.at === checkpoint.sourceTurnAt) : -1;
      const promptWithHistory = checkpoint
        ? checkpointHandoff(checkpoint.note, session.turns.slice(checkpointTurn + 1).slice(-3).map(turn => ({ user: turn.prompt.slice(0, 1000), assistant: turn.result.slice(0, 1000) })), executionPrompt)
        : retainedConversationPrompt(executionPrompt, session);
      if (checkpoint) onProgress({ kind: "status", text: "Starting fresh thread from checkpoint…" });
      const stageStart = performance.now();
      const execution = await this.runner.run(
        promptWithHistory,
        session.projectPath,
        route,
        runThreadId,
        async (progress) => {
          if (progress.kind === "thread") {
            session.threadId = progress.text;
            if (progress.text !== runThreadId) session.threadTurnCount = 0;
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
        "main",
        trustedFolders,
        config.approvalMode,
      );
      signal?.throwIfAborted();
      stages.push({
        objective: shape === "plan_verify" ? "Verify plan" : "Complete request",
        route,
        durationMs: Math.round(performance.now() - stageStart),
        usage: execution.usage,
        estimatedCostUsd: costForUsage(route, execution.usage),
      });
      if (execution.threadId) session.threadId = execution.threadId;
      if (checkpoint && session.threadId === checkpoint.threadId) {
        session.threadId = undefined;
        onProgress({ kind: "error", text: "Fresh Codex thread ID was unavailable; the next turn will use retained conversation history." });
      }
      session.threadTurnCount = runThreadId && session.threadId === runThreadId
        ? (session.threadTurnCount ?? session.turns.length) + 1 : 1;
      if (session.threadId) {
        session.contextByThread ??= {};
        if (execution.context) session.contextByThread[session.threadId] = execution.context;
        else delete session.contextByThread[session.threadId];
      }
      const artifacts = changedArtifacts(
        artifactsBefore,
        await artifactSnapshot(session.projectPath).catch(
          () => new Map<string, number>(),
        ),
      );
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
      if (relationResolved && (priorTask || taskRelation === "replace"))
        session.activeTask = advanceTask(priorTask, taskRelation, prompt, execution.result, false);
      if (resumedAfterLimit) session.deferredTurn = undefined;
      await save();
      return {
        session,
        result: execution.result,
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
      const cancelled = !!signal?.aborted;
      session.turns = [
        ...session.turns,
        {
          prompt,
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
      if (relationResolved && (priorTask || taskRelation === "replace"))
        session.activeTask = advanceTask(priorTask, taskRelation, prompt, String(error), true);
      await save();
      throw error;
    }
  }
}
