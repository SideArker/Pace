import type { Config, Route } from '../types.js';
import { isRecord, validRoute } from '../config.js';
export type RouteResult = { route: Route; note: string };
export function selectRoute(config: Config, suggestion: unknown, manual?: Route): RouteResult {
  if (manual && validRoute(manual, config.models)) return { route: manual, note: 'Manual route' };
  if (config.routingMode === 'manual') return { route: config.defaultRoute, note: 'Configured default' };
  const answer = isRecord(suggestion) && isRecord(suggestion.answers) ? suggestion.answers.route : undefined;
  if (isRecord(answer) && typeof answer.choice === 'string') {
    const index = Number(answer.choice);
    const option = Number.isInteger(index) ? config.models[index] : undefined;
    const probabilities = isRecord(answer.probabilities) ? Object.entries(answer.probabilities).filter((entry): entry is [string, number] => typeof entry[1] === 'number').sort((a, b) => b[1] - a[1]) : [];
    if (option && typeof answer.confidence === 'number' && answer.confidence >= 0.7 && probabilities.length >= 2 && probabilities[0]![0] === answer.choice && probabilities[0]![1] - probabilities[1]![1] >= 0.15) {
      return { route: { model: option.model, effort: option.defaultEffort ?? option.efforts[0] }, note: 'Selected by Jev' };
    }
  }
  return { route: config.defaultRoute, note: 'Jev unavailable or uncertain; configured default' };
}
export function sameRoute(a: Route, b: Route): boolean { return a.model === b.model && a.effort === b.effort; }
