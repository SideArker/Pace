import type { Config, Route, Session } from "../types.js";
import type { CodexRunner, Progress } from "../integrations/codex.js";
import { VexRouter } from "../integrations/vex.js";
import { policyRoute, selectRoute } from "./router.js";
import { routeRequest } from "../integrations/vex.js";
import { PaceStore } from "./sessions.js";
import { artifactSnapshot, changedArtifacts } from "./artifacts.js";
import { validRoute } from "../config.js";
export type TurnOutcome = { session: Session; result: string; note: string; route: Route; durationMs: number; artifacts: string[]; usage?: Awaited<ReturnType<CodexRunner['run']>>['usage'] };
export class VexUnavailableError extends Error {
  constructor(cause: unknown) { super(`Vex MCP unavailable: ${String(cause)}`); }
}
export class Orchestrator {
  constructor(
    readonly store: PaceStore,
    readonly runner: CodexRunner,
    readonly vex: Pick<VexRouter, 'choose'> & Partial<Pick<VexRouter, 'verify'>> = new VexRouter(),
  ) {}
  async turn(
    prompt: string,
    session: Session,
    config: Config,
    onProgress: (progress: Progress) => void,
    signal?: AbortSignal,
  ): Promise<TurnOutcome> {
    const startedAt = performance.now();
    // Keep MCP availability mandatory for every coding turn.
    try { await this.vex.verify?.(); }
    catch (error) { throw new VexUnavailableError(error); }
    const enabled = config.models.filter(model => model.enabled !== false);
    if (config.models.length && !enabled.length) throw new Error('No models enabled. Open /models and enable one before running a turn.');
    if (session.threadId && session.routingMode === "manual" && !session.route.model && config.models.length) throw new Error('Saved thread used the Codex default model, which Pace cannot identify. Use /auto or /new to apply your enabled model list.');
    if (session.threadId && session.routingMode === "manual" && session.route.model && !enabled.some(model => model.model === session.route.model)) throw new Error(`Model ${session.route.model} is disabled. Enable it in /models or use /auto.`);
    if (session.threadId && session.routingMode === "manual" && !validRoute(session.route, enabled)) throw new Error(`Saved route ${session.route.model ?? "Codex default"}/${session.route.effort ?? "default"} is no longer enabled. Use /models to restore it or /auto.`);
    const usableConfig = { ...config, models: enabled, defaultRoute: config.models.length && (!config.defaultRoute.model || !enabled.some(model => model.model === config.defaultRoute.model))
      ? { model: enabled[0]?.model, effort: enabled[0]?.defaultEffort ?? enabled[0]?.efforts[0] } : config.defaultRoute };
    const save = async () => {
      try {
        await this.store.save(session);
      } catch (error) {
        onProgress({
          kind: "error",
          text: `Pace session was not saved: ${String(error)}`,
        });
      }
    };
    let route: Route;
    let note: string;
    if (session.threadId && session.routingMode === "manual") {
      route = session.route;
      note = "Continuing manual route";
    } else {
      let suggestion: unknown;
      const routeCount = enabled.reduce((count, model) => count + model.efforts.length, 0);
      if (session.routingMode === "auto" && routeCount >= 2 && routeCount <= 12) {
        onProgress({ kind: "status", text: "Routing…" });
        try { suggestion = await this.vex.choose(prompt, enabled); }
        catch (error) { throw new VexUnavailableError(error); }
      }
      const routeContext = routeRequest(prompt, enabled).context;
      const selected = selectRoute(
        { ...usableConfig, routingMode: session.routingMode },
        suggestion,
        session.routingMode === "manual"
          ? session.route.model
            ? session.route
            : undefined
          : undefined,
        session.routingMode === "auto" && routeCount >= 2 && routeCount <= 12
          ? policyRoute(routeContext, usableConfig)
          : undefined,
      );
      route = selected.route;
      note = selected.note;
      if (session.routingMode === "auto" && routeCount < 2)
        note = "Auto needs two configured routes; using configured default";
      if (session.routingMode === "auto" && routeCount > 12)
        note = "Vex supports at most 12 routes; using configured default";
      session.route = route;
      await save();
    }
    onProgress({ kind: "route", route });
    onProgress({
      kind: "status",
      text: `${note}: ${route.model ?? "Codex default"}${route.effort ? ` · ${route.effort}` : ""}`,
    });
    try {
      const artifactsBefore = await artifactSnapshot(session.projectPath).catch(() => new Map<string, number>());
      const execution = await this.runner.run(
        prompt,
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
      );
      const artifactsAfter = await artifactSnapshot(session.projectPath).catch(() => new Map<string, number>());
      const artifacts = changedArtifacts(artifactsBefore, artifactsAfter);
      const durationMs = Math.round(performance.now() - startedAt);
      if (execution.threadId) session.threadId = execution.threadId;
      session.turns = [
        ...session.turns,
        {
          prompt: prompt.slice(0, 180),
          result: execution.result.slice(0, 500),
          at: new Date().toISOString(),
          route,
          routeNote: note,
          durationMs,
          artifacts,
          usage: execution.usage,
        },
      ].slice(-20);
      await save();
      return { session, result: execution.result, note, route, durationMs, artifacts, usage: execution.usage };
    } catch (error) {
      session.turns = [
        ...session.turns,
        {
          prompt: prompt.slice(0, 180),
          result: String(error).slice(0, 500),
          at: new Date().toISOString(),
          route,
          routeNote: note,
          durationMs: Math.round(performance.now() - startedAt),
          failed: true,
        },
      ].slice(-20);
      await save();
      throw error;
    }
  }
}
