import type { Config, Route } from '../types.js';
import { isRecord, validRoute } from '../config.js';
export type RouteResult = { route: Route; note: string };
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
export function sameRoute(a: Route, b: Route): boolean { return a.model === b.model && a.effort === b.effort; }
