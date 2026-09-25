import type { Config, Route } from '../types.js';
import { isRecord, validRoute } from '../config.js';
export type RouteResult = { route: Route; note: string };
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
export function sensitiveArchitectureFallback(context: { complexDomain: boolean; architecture: boolean }, config: Config): Route | undefined {
  if (!context.complexDomain || !context.architecture) return undefined;
  const sol = config.models.find(model => model.enabled !== false && model.model === 'gpt-6-sol');
  const effort = sol?.efforts.includes('high') ? 'high' : sol?.efforts.includes('xhigh') ? 'xhigh' : undefined;
  return effort ? { model: sol!.model, effort } : undefined;
}
export function lightweightFallback(context: { category: string; requestLength: string; complexDomain: boolean; architecture: boolean; multipleFiles: boolean }, config: Config): Route | undefined {
  if (context.category !== 'conversation' && context.category !== 'general_knowledge' && context.category !== 'exploration') return undefined;
  if (context.category !== 'conversation' && (context.requestLength === 'long' || context.multipleFiles || (context.complexDomain && context.architecture))) return undefined;
  const luna = config.models.find(model => model.enabled !== false && model.model === 'gpt-6-luna');
  const effort = luna?.efforts.includes('low') ? 'low' : luna?.defaultEffort ?? luna?.efforts[0];
  return luna && effort ? { model: luna.model, effort } : undefined;
}
export function policyRoute(context: { category: string; requestLength: string; complexDomain: boolean; architecture: boolean; multipleFiles: boolean; testsMentioned: boolean }, config: Config): Route | undefined {
  const available = (name: string, efforts: Route['effort'][]) => {
    const model = config.models.find(option => option.enabled !== false && option.model === name);
    const effort = efforts.find(candidate => candidate && model?.efforts.includes(candidate));
    return model && effort ? { model: model.model, effort } : undefined;
  };
  const light = lightweightFallback(context, config);
  if (light) return light;
  if (context.complexDomain && context.architecture)
    return available('gpt-6-astra', ['high', 'xhigh', 'medium']) ?? available('gpt-6-sol', ['high', 'xhigh', 'medium']);
  if ((context.category === 'general_knowledge' || context.category === 'exploration') && context.requestLength === 'long' && !context.multipleFiles)
    return available('gpt-6-sol', ['medium', 'high']) ?? available('gpt-6-luna', ['low']);
  if (context.multipleFiles || context.testsMentioned || context.requestLength === 'long')
    return available('gpt-6-sol', ['high', 'medium']) ?? available('gpt-6-astra', ['high']);
  return available('gpt-6-sol', ['medium', 'high', 'low']) ?? available('gpt-6-luna', ['low']);
}
export function sameRoute(a: Route, b: Route): boolean { return a.model === b.model && a.effort === b.effort; }
