import type { Config, Effort, ModelOption, Route } from './types.js';
export const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
export const DEFAULT_CONFIG: Config = { models: [], defaultRoute: {}, routingMode: 'auto' };
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function validRoute(route: Route, models: ModelOption[]): boolean {
  if (!route.model) return !route.effort;
  const option = models.find(item => item.model === route.model);
  return !!option && (!route.effort || option.efforts.includes(route.effort));
}
export function parseConfig(value: unknown): Config {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('config.json must contain a models array');
  const models: ModelOption[] = value.models.map((item: unknown) => {
    if (!isRecord(item) || typeof item.model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(item.model)
      || !Array.isArray(item.efforts) || !item.efforts.length || !item.efforts.every((effort: unknown) => EFFORTS.includes(effort as Effort))) {
      throw new Error('Each model needs a valid ID and a nonempty list of SDK-supported efforts');
    }
    if (item.defaultEffort !== undefined && !item.efforts.includes(item.defaultEffort)) throw new Error(`Invalid default effort for ${item.model}`);
    return { model: item.model, efforts: [...new Set(item.efforts)] as Effort[], defaultEffort: item.defaultEffort as Effort | undefined };
  });
  if (new Set(models.map(item => item.model)).size !== models.length) throw new Error('Duplicate model IDs');
  const rawRoute = value.defaultRoute ?? {};
  if (!isRecord(rawRoute)) throw new Error('defaultRoute must be an object');
  const defaultRoute: Route = { model: typeof rawRoute.model === 'string' ? rawRoute.model : undefined, effort: typeof rawRoute.effort === 'string' ? rawRoute.effort as Effort : undefined };
  if (!validRoute(defaultRoute, models)) throw new Error('defaultRoute is not in configured model options');
  if (value.routingMode !== 'auto' && value.routingMode !== 'manual') throw new Error('routingMode must be auto or manual');
  return { models, defaultRoute, routingMode: value.routingMode };
}
