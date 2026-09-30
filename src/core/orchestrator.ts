import type { Usage } from "@openai/codex-sdk";
import type { Config, Route, Session } from "../shared/types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import {
  VexRouter,
  shapeChoices,
  shapeRequest,
  stageRequest,
  type VexRequest,
} from "./vex/client.js";
import {
  chosenRoute,
  validateDecision,
  type RoutingDecision,
} from "./routing/router.js";
import { costForUsage, pricedModels } from "./routing/pricing.js";
import { PaceStore } from "./sessions.js";
import { addUsage, awaitRouting, handoffPrompt, retainedConversationPrompt, structuredHandoff } from "./orchestrator-helpers.js";
import { runPlanningStage } from "./workflow-stages.js";
import { artifactSnapshot, changedArtifacts } from "./system/artifacts.js";
import { validRoute } from "../shared/config.js";
import { existingFolder } from "./system/folders.js";
import {
  configuredSkills,
  enabledSkills,
  skillCommand,
  skillMention,
  skillOption,
  skillPrompt,
  skillRequest,
} from "./system/skills.js";
import {
  DEFAULT_ROUTING_PROMPTS,
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
    const request = invoked ? skillRequest(prompt, invoked) : prompt;
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
    const systemMessage = (text: string) => {
      systemMessages.push(text);
      onProgress({ kind: "system", text });
    };
    const routeMessage = (selected: Route, stage?: string) => {
      const model =
        selected.model?.replace(
          /^gpt-(\d+)-(.+)$/,
          (_match, version: string, name: string) =>
            `GPT-${version} ${name[0]!.toUpperCase()}${name.slice(1)}`,
        ) ?? "Codex default";
      systemMessage(
        `${session.routingMode === "auto" ? "Vex routed" : "Manual route"}${stage ? ` ${stage}` : ""} to ${model}${selected.effort ? ` ${selected.effort[0]!.toUpperCase()}${selected.effort.slice(1)}` : ""}.`,
      );
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
    let handoff: string | undefined;
    const auto = session.routingMode === "auto";
    try {
      if (auto) {
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
        session.routingMode === "manual" &&
        !validRoute(session.route, enabled)
      )
        throw new Error(
          "Saved manual route is no longer enabled. Use /models or /auto.",
        );
      if (auto) {
        pricedModels(enabled);
        const choices = enabled.reduce(
          (count, model) => count + model.efforts.length,
          0,
        );
        if (choices > 12)
          throw new Error(
            "Auto routing supports at most 12 model and effort pairs. Narrow /models.",
          );
        onProgress({ kind: "status", text: "Choosing workflow..." });
        shape = (
          await choose(
            shapeRequest(request, routingTurns, enabled, prompts),
            "workflow",
          )
        ).choice;
        if (shape === "clarify") {
          const result =
            "What outcome would you like from this request? Please describe the deliverable.";
          const durationMs = Math.round(performance.now() - startedAt);
          session.turns = [
            ...session.turns,
            {
              prompt,
              result,
              at: new Date().toISOString(),
              routeNote: "Vex requested clarification",
              systemMessages,
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
      signal?.throwIfAborted();
      const artifactsBefore = await artifactSnapshot(session.projectPath).catch(
        () => new Map<string, number>(),
      );
      const trustedFolders = await Promise.all(
        (config.trustedFolders ?? []).map(existingFolder),
      );
      signal?.throwIfAborted();
      if (auto && (shape === "scout" || shape === "plan_execute")) {
        handoff = await runPlanningStage({
          shape, request, routingTurns, enabled, prompts, choose, runner: this.runner,
          session, signal, onProgress, routeMessage, systemMessage, stages,
        });
      }
      if (auto) {
        const objective =
          shape === "single"
            ? prompts.objectives.single
            : prompts.objectives.afterHandoff;
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
              ),
              objective,
            )
          ).choice,
          enabled,
        );
        note = `Vex chose ${shape} workflow`;
      }
      signal?.throwIfAborted();
      if (session.threadId && session.route.model !== route.model) {
        systemMessage("Model changed. Continuing the existing Codex thread.");
      }
      session.route = route;
      await save();
      onProgress({ kind: "route", route });
      routeMessage(route, shape === "single" ? undefined : "completion");
      const mentioned = skillMention(prompt, skills);
      const turnSkills = skills.filter(
        (skill) =>
          session.activeSkills?.includes(skill.name) ||
          skill.name === invoked?.name ||
          skill.name === mentioned?.name,
      );
      systemMessage(
        turnSkills.length
          ? `Active skills: ${turnSkills.map((skill) => `/${skill.name}`).join(", ")}.`
          : "No skills are active for this conversation.",
      );
      onProgress({
        kind: "status",
        text: `${note}: ${route.model ?? "Codex default"} · ${route.effort ?? "default"}`,
      });
      const executionPrompt = handoff
        ? `${skillPrompt(prompt, skills, session.activeSkills, session.skillOptions)}\n\n${prompts.handoff.reportInstruction}\n${handoff}`
        : skillPrompt(
            prompt,
            skills,
            session.activeSkills,
            session.skillOptions,
          );
      const promptWithHistory = retainedConversationPrompt(
        executionPrompt,
        session,
      );
      const stageStart = performance.now();
      const execution = await this.runner.run(
        promptWithHistory,
        session.projectPath,
        route,
        session.threadId,
        async (progress) => {
          if (progress.kind === "thread") {
            session.threadId = progress.text;
            await save();
          } else onProgress(progress);
        },
        signal,
        "main",
        trustedFolders,
      );
      signal?.throwIfAborted();
      stages.push({
        objective: "Complete request",
        route,
        durationMs: Math.round(performance.now() - stageStart),
        usage: execution.usage,
        estimatedCostUsd: costForUsage(route, execution.usage),
      });
      if (execution.threadId) session.threadId = execution.threadId;
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
          systemMessages,
          durationMs,
          artifacts,
          usage,
          stages,
          routing,
          estimatedCostUsd,
        },
      ].slice(-20);
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
          systemMessages,
          durationMs: Math.round(performance.now() - startedAt),
          failed: true,
          cancelled,
          stages,
          routing,
        },
      ].slice(-20);
      await save();
      throw error;
    }
  }
}
