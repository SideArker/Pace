import type { ModelOption, Route } from '../types.js';
import { isRecord } from '../config.js';

export type RoutingChoice = { id: string; description: string };
export type RoutingDecision = { contractVersion: '1'; choice: string; abstained: false; confidence: number; probabilities: Record<string, number> };
export function validateDecision(value: unknown, options: RoutingChoice[]): RoutingDecision {
  if (!isRecord(value) || value.contractVersion !== '1' || value.abstained !== false ||
    typeof value.choice !== 'string' || !options.some(option => option.id === value.choice) ||
    typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
    !isRecord(value.probabilities)) throw new Error('Invalid Vex routing decision');
  const probabilities = value.probabilities;
  if (Object.keys(probabilities).length !== options.length || options.some(option =>
    typeof probabilities[option.id] !== 'number' || !Number.isFinite(probabilities[option.id]) ||
    (probabilities[option.id] as number) < 0 || (probabilities[option.id] as number) > 1))
    throw new Error('Invalid Vex routing probabilities');
  const total = options.reduce((sum, option) => sum + (probabilities[option.id] as number), 0);
  if (total <= 0 || total > 1.02) throw new Error('Invalid Vex routing probability total');
  const highest = options.reduce((best, option) =>
    (probabilities[option.id] as number) > (probabilities[best.id] as number) ? option : best);
  if (value.choice !== highest.id) throw new Error('Vex routing choice does not match highest ranked option');
  return value as RoutingDecision;
}
export function routeChoices(models: ModelOption[]): RoutingChoice[] {
  return models.flatMap((model, index) => model.efforts.map(effort => ({
    id: `${index}:${effort}`,
    description: `${model.model} at ${effort} reasoning`,
  })));
}
export function chosenRoute(choice: string, models: ModelOption[]): Route {
  const match = /^(\d+):([a-z]+)$/.exec(choice);
  const model = match ? models[Number(match[1])] : undefined;
  const effort = match?.[2];
  if (!model || !effort || !model.efforts.includes(effort as ModelOption['efforts'][number])) throw new Error('Vex selected an unavailable route');
  return { model: model.model, effort: effort as Route['effort'] };
}
