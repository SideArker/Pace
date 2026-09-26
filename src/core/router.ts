import type { Config, ModelOption, Route } from '../types.js';
import { isRecord, validRoute } from '../config.js';
export type RouteResult = { route: Route; note: string };
export type RouteContext = { category: string; requestLength: string; currentInfo: boolean; complexDomain: boolean; architecture: boolean; multipleFiles: boolean; testsMentioned: boolean; critical: boolean; simpleChange: boolean; needsRepository: boolean };

function effortOrder(context: RouteContext, modelName?: string): Route['effort'][] {
  if (modelName === 'gpt-6-luna' && ['coding', 'debugging', 'refactoring'].includes(context.category))
    return ['low', 'medium', 'high'];
  if (context.critical) return ['ultra', 'xhigh', 'high', 'medium', 'low'];
  if (context.category === 'conversation' || context.category === 'general_knowledge')
    return context.complexDomain && context.architecture ? ['high', 'medium', 'low'] : context.requestLength === 'long' ? ['medium', 'high', 'low'] : ['low', 'medium', 'high'];
  if (context.category === 'exploration')
    return context.multipleFiles || context.requestLength === 'long' ? ['medium', 'high', 'low'] : ['low', 'medium', 'high'];
  if (context.category === 'planning')
    return context.architecture || context.multipleFiles || context.complexDomain ? ['high', 'medium', 'xhigh', 'low'] : ['medium', 'low', 'high'];
  if (context.simpleChange && !context.multipleFiles && !context.testsMentioned) return ['medium', 'low', 'high'];
  if (context.complexDomain && context.architecture) return ['xhigh', 'high', 'ultra', 'medium', 'low'];
  return context.multipleFiles || context.testsMentioned || context.requestLength === 'long' || context.category === 'coding'
    ? ['high', 'medium', 'xhigh', 'low'] : ['medium', 'high', 'low'];
}

export function routingCandidates(models: ModelOption[], context: RouteContext): ModelOption[] {
  return models.map(model => {
    const effort = effortOrder(context, model.model).find(value => value && model.efforts.includes(value));
    const selected = effort ?? model.defaultEffort ?? model.efforts[0]!;
    return { ...model, efforts: [selected], defaultEffort: selected };
  });
}
function modelConsensus(config: Config, suggestion: unknown): Route | undefined {
  if (!isRecord(suggestion) || suggestion.contractVersion !== '1' || suggestion.abstained !== true || suggestion.reason !== 'Insufficient confidence or probability lead' || !isRecord(suggestion.probabilities)) return undefined;
  const ids = config.models.flatMap((model, index) => model.efforts.map(effort => `${index}:${effort}`));
  const probabilities = suggestion.probabilities;
  const entries = Object.entries(probabilities);
  if (ids.length < 2 || entries.length !== ids.length || !entries.every(([id, value]) => ids.includes(id) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return undefined;
  const total = entries.reduce((sum, [, value]) => sum + (value as number), 0);
  if (total < 0.75 || total > 1.01) return undefined;
  const ranked = config.models.map((model, index) => ({
    model,
    index,
    mass: model.efforts.reduce((sum, effort) => sum + (probabilities[`${index}:${effort}`] as number), 0),
  })).sort((a, b) => b.mass - a.mass);
  const first = ranked[0];
  if (!first || first.mass / total < 0.85 || (first.mass - (ranked[1]?.mass ?? 0)) / total < 0.5) return undefined;
  const effort = first.model.efforts.reduce((best, candidate) =>
    probabilities[`${first.index}:${candidate}`] as number > (probabilities[`${first.index}:${best}`] as number) ? candidate : best);
  return { model: first.model.model, effort };
}
export function selectRoute(config: Config, suggestion: unknown, manual?: Route, policyFallback?: Route): RouteResult {
  if (manual && validRoute(manual, config.models)) return { route: manual, note: 'Manual route' };
  if (config.routingMode === 'manual') return { route: config.defaultRoute, note: 'Configured default' };
  if (isRecord(suggestion) && suggestion.contractVersion === '1' && suggestion.abstained === false && typeof suggestion.choice === 'string') {
    const [rawIndex, effort] = suggestion.choice.split(':');
    const index = Number(rawIndex);
    const option = Number.isInteger(index) ? config.models[index] : undefined;
    const routeIds = config.models.flatMap((model, modelIndex) => model.efforts.map(available => `${modelIndex}:${available}`));
    const probabilities = isRecord(suggestion.probabilities) ? Object.entries(suggestion.probabilities).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 1).sort((a, b) => b[1] - a[1]) : [];
    if (option && effort && option.efforts.includes(effort as typeof option.efforts[number]) && probabilities.length === routeIds.length && probabilities.every(([id]) => routeIds.includes(id)) && typeof suggestion.confidence === 'number' && suggestion.confidence >= 0.7 && suggestion.confidence <= 1 && probabilities[0]![0] === suggestion.choice && probabilities[0]![1] - probabilities[1]![1] >= 0.15) {
      return { route: { model: option.model, effort: effort as typeof option.efforts[number] }, note: 'Selected by Vex' };
    }
  }
  const consensus = modelConsensus(config, suggestion);
  if (consensus) return { route: consensus, note: 'Selected from Vex model consensus after route abstention' };
  if (policyFallback && validRoute(policyFallback, config.models))
    return { route: policyFallback, note: 'Policy fallback after Vex abstained or was uncertain' };
  return { route: config.defaultRoute, note: 'Vex abstained or was uncertain; configured default' };
}
/** A clear task intent can be routed locally; Vex handles unclear requests. */
export function directRoute(context: RouteContext, config: Config): Route | undefined {
  const name = ['conversation', 'general_knowledge', 'exploration', 'planning'].includes(context.category)
    ? 'gpt-6-luna' : ['coding', 'debugging', 'refactoring'].includes(context.category) ? 'gpt-6-sol' : undefined;
  const model = config.models.find(option => option.enabled !== false && option.model === name);
  if (!model) return undefined;
  const effort = effortOrder(context, model.model).find(value => value && model.efforts.includes(value)) ?? model.defaultEffort ?? model.efforts[0];
  return { model: model.model, effort };
}
export function policyRoute(context: RouteContext, config: Config): Route | undefined {
  const direct = directRoute(context, config);
  if (direct) return direct;
  if (context.category === 'unclear') return undefined;
  const preference = ['conversation', 'general_knowledge', 'exploration', 'planning'].includes(context.category)
    ? ['gpt-6-sol', 'gpt-6-astra'] : ['gpt-6-astra', 'gpt-6-luna'];
  const model = preference.map(name => config.models.find(option => option.enabled !== false && option.model === name)).find(Boolean);
  const effort = model && (effortOrder(context, model.model).find(value => value && model.efforts.includes(value)) ?? model.defaultEffort ?? model.efforts[0]);
  return model && effort ? { model: model.model, effort } : undefined;
}
export function sameRoute(a: Route, b: Route): boolean { return a.model === b.model && a.effort === b.effort; }
