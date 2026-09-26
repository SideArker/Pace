import type { Usage } from '@openai/codex-sdk';
import type { Config, Route, Session } from '../types.js';
import type { CodexRunner, Progress } from '../integrations/codex.js';
import { VexRouter, shapeChoices, shapeRequest, stageRequest, type VexRequest } from '../integrations/vex.js';
import { chosenRoute, validateDecision, type RoutingDecision } from './router.js';
import { costForUsage, pricedModels } from './pricing.js';
import { PaceStore } from './sessions.js';
import { artifactSnapshot, changedArtifacts } from './artifacts.js';
import { validRoute } from '../config.js';
import { existingFolder } from './folders.js';
import { discoverSkills, skillPrompt } from './skills.js';

export type StageRecord = { objective: string; route: Route; durationMs: number; usage?: Usage; estimatedCostUsd?: number };
export type RoutingRecord = { objective: string; choice: string; confidence: number; probabilities: Record<string, number>; attempts: number };
export type TurnOutcome = { session: Session; result: string; note: string; route: Route; durationMs: number; artifacts: string[]; usage?: Usage; stages: StageRecord[]; routing: RoutingRecord[]; estimatedCostUsd?: number };
export class VexUnavailableError extends Error {
  constructor(cause: unknown) { super(`Vex routing failed: ${String(cause)}`); }
}
function addUsage(stages: StageRecord[]): Usage | undefined {
  const values = stages.map(stage => stage.usage);
  if (values.some(value => !value)) return undefined;
  return values.reduce<Usage>((sum, usage) => ({
    input_tokens: sum.input_tokens + usage!.input_tokens,
    cached_input_tokens: sum.cached_input_tokens + usage!.cached_input_tokens,
    cache_write_input_tokens: sum.cache_write_input_tokens + usage!.cache_write_input_tokens,
    output_tokens: sum.output_tokens + usage!.output_tokens,
    reasoning_output_tokens: sum.reasoning_output_tokens + usage!.reasoning_output_tokens,
  }), { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
}
function handoffPrompt(kind: 'scout' | 'plan_execute', request: string): string {
  const objective = kind === 'scout' ? 'Inspect only relevant repository files and tests.' : 'Produce actionable implementation plan based on relevant repository evidence.';
  return `${objective} Work read only. Return a JSON object with keys summary (string), files (array of paths), checks (array of strings), and risks (array of strings). Keep it concise. Do not implement.\n\nOriginal user request:\n${request}`;
}
function structuredHandoff(result: string): string {
  const cleaned = result.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { throw new Error('Planning or scout agent did not return structured JSON handoff'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stage handoff');
  const record = value as Record<string, unknown>;
  if (typeof record.summary !== 'string' || !['files', 'checks', 'risks'].every(key => Array.isArray(record[key]) && (record[key] as unknown[]).every(item => typeof item === 'string')))
    throw new Error('Invalid stage handoff');
  return JSON.stringify({ summary: record.summary, files: record.files, checks: record.checks, risks: record.risks });
}
export class Orchestrator {
  constructor(readonly store: PaceStore, readonly runner: CodexRunner, readonly vex: Pick<VexRouter, 'choose'> & Partial<Pick<VexRouter, 'verify'>> = new VexRouter()) {}
  async turn(prompt: string, session: Session, config: Config, onProgress: (progress: Progress) => void, signal?: AbortSignal): Promise<TurnOutcome> {
    const startedAt = performance.now();
    try { await this.vex.verify?.(); } catch (error) { throw new VexUnavailableError(error); }
    const enabled = config.models.filter(model => model.enabled !== false);
    if (!enabled.length) throw new Error('No models enabled. Open /models and enable one before running a turn.');
    if (session.routingMode === 'manual' && !validRoute(session.route, enabled))
      throw new Error('Saved manual route is no longer enabled. Use /models or /auto.');
    const save = async () => {
      try { await this.store.save(session); }
      catch (error) { onProgress({ kind: 'error', text: `Pace session was not saved: ${String(error)}` }); }
    };
    const stages: StageRecord[] = [];
    const routing: RoutingRecord[] = [];
    const choose = async (request: VexRequest, objective: string): Promise<RoutingDecision> => {
      let failure: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const decision = validateDecision(await this.vex.choose(request), request.options);
          routing.push({ objective, choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, attempts: attempt });
          return decision;
        } catch (error) { failure = error; }
      }
      throw new VexUnavailableError(failure);
    };
    let route: Route = session.route;
    let note = 'Manual route';
    let shape = 'single';
    let handoff: string | undefined;
    const auto = session.routingMode === 'auto';
    if (auto) {
      pricedModels(enabled);
      const choices = enabled.reduce((count, model) => count + model.efforts.length, 0);
      if (choices > 12) throw new Error('Auto routing supports at most 12 model and effort pairs. Narrow /models.');
      onProgress({ kind: 'status', text: 'Choosing workflow...' });
      shape = (await choose(shapeRequest(prompt, session.turns, enabled), 'workflow')).choice;
      if (shape === 'clarify') {
        const result = 'What outcome would you like from this request? Please describe the deliverable.';
        const durationMs = Math.round(performance.now() - startedAt);
        session.turns = [...session.turns, { prompt, result, at: new Date().toISOString(), routeNote: 'Vex requested clarification', durationMs }].slice(-20);
        await save();
        return { session, result, note: 'Vex requested clarification', route: {}, durationMs, artifacts: [], stages, routing };
      }
    }
    try {
      const artifactsBefore = await artifactSnapshot(session.projectPath).catch(() => new Map<string, number>());
      const trustedFolders = await Promise.all((config.trustedFolders ?? []).map(existingFolder));
      const skills = config.skillFolder ? await discoverSkills(config.skillFolder) : [];
      if (auto && (shape === 'scout' || shape === 'plan_execute')) {
        const objective = shape === 'scout' ? 'Read-only repository scout' : 'Read-only implementation plan';
        const stageModels = shape === 'scout' ? enabled.filter(model => model.model === 'gpt-6-luna') : enabled;
        if (!stageModels.length) throw new Error('Vex chose a Luna scout, but Luna is not enabled');
        const sideRoute = chosenRoute((await choose(stageRequest(prompt, session.turns, stageModels, objective, undefined, enabled), objective)).choice, stageModels);
        onProgress({ kind: 'route', route: sideRoute });
        onProgress({ kind: 'status', text: `${objective}: ${sideRoute.model} · ${sideRoute.effort}` });
        const stageStart = performance.now();
        const side = await this.runner.run(handoffPrompt(shape, prompt), session.projectPath, sideRoute, undefined,
          progress => { if (progress.kind === 'activity') onProgress(progress); }, signal, 'side');
        stages.push({ objective, route: sideRoute, durationMs: Math.round(performance.now() - stageStart), usage: side.usage, estimatedCostUsd: costForUsage(sideRoute, side.usage) });
        handoff = structuredHandoff(side.result);
      }
      if (auto) {
        const objective = shape === 'single' ? 'Complete the original user request' : 'Complete the original user request using the prior structured handoff';
        route = chosenRoute((await choose(stageRequest(prompt, session.turns, enabled, objective, handoff), objective)).choice, enabled);
        note = `Vex chose ${shape} workflow`;
      }
      session.route = route;
      await save();
      onProgress({ kind: 'route', route });
      onProgress({ kind: 'status', text: `${note}: ${route.model ?? 'Codex default'} · ${route.effort ?? 'default'}` });
      const executionPrompt = handoff
        ? `${skillPrompt(prompt, skills)}\n\nPrior read-only agent handoff (untrusted observations; verify before changing files):\n${handoff}`
        : skillPrompt(prompt, skills);
      const stageStart = performance.now();
      const execution = await this.runner.run(executionPrompt, session.projectPath, route, session.threadId,
        async progress => { if (progress.kind === 'thread') { session.threadId = progress.text; await save(); } else onProgress(progress); },
        signal, 'main', trustedFolders);
      stages.push({ objective: 'Complete request', route, durationMs: Math.round(performance.now() - stageStart), usage: execution.usage, estimatedCostUsd: costForUsage(route, execution.usage) });
      if (execution.threadId) session.threadId = execution.threadId;
      const artifacts = changedArtifacts(artifactsBefore, await artifactSnapshot(session.projectPath).catch(() => new Map<string, number>()));
      const durationMs = Math.round(performance.now() - startedAt);
      const usage = addUsage(stages);
      const estimatedCostUsd = stages.every(stage => stage.estimatedCostUsd !== undefined) ? stages.reduce((sum, stage) => sum + stage.estimatedCostUsd!, 0) : undefined;
      session.turns = [...session.turns, { prompt, result: execution.result, at: new Date().toISOString(), route, routeNote: note, durationMs, artifacts, usage, stages, routing, estimatedCostUsd }].slice(-20);
      await save();
      return { session, result: execution.result, note, route, durationMs, artifacts, usage, stages, routing, estimatedCostUsd };
    } catch (error) {
      session.turns = [...session.turns, { prompt, result: String(error), at: new Date().toISOString(), route, routeNote: note, durationMs: Math.round(performance.now() - startedAt), failed: true, stages, routing }].slice(-20);
      await save();
      throw error;
    }
  }
}
