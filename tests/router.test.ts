import { describe, expect, it } from 'vitest';
import { selectRoute, sensitiveArchitectureFallback } from '../src/core/router.js';
import { parseConfig, withModels } from '../src/config.js';
import { routeRequest } from '../src/integrations/vex.js';
const config = parseConfig({ routingMode: 'auto', models: [
  { model: 'route-one', efforts: ['medium'] }, { model: 'route-two', efforts: ['high'] },
], defaultRoute: { model: 'route-one', effort: 'medium' } });
describe('routing', () => {
  const result = (choice: string, confidence = .9, probabilities = { '0:medium': .1, '1:high': .9 }) => ({ contractVersion: '1', choice, abstained: false, confidence, probabilities });
  it('accepts only confident configured Vex choices', () => {
    expect(selectRoute(config, result('1:high')).route).toEqual({ model: 'route-two', effort: 'high' });
    expect(selectRoute(config, result('evil')).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, result('1:high', .6)).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, result('0:medium')).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, result('01:high', .9, { '0:medium': .1, '01:high': .9 })).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, { ...result('1:high'), abstained: true }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, { error: true }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, undefined).route).toEqual(config.defaultRoute);
  });
  it('keeps raw prompts out of Vex requests and lists model-effort pairs', () => {
    const request = JSON.stringify(routeRequest('fix SECRET_TOKEN=https://private.example/path', config.models));
    expect(request).not.toContain('SECRET_TOKEN');
    expect(request).not.toContain('private.example');
    expect(request).toContain('debugging');
    expect(routeRequest('work', [{ model: 'route-one', efforts: ['low', 'high'] }]).options.map(option => option.id)).toEqual(['0:low', '0:high']);
  });
  it('separates a greeting from a complex payment-system task without sending either prompt', () => {
    const models = [{ model: 'gpt-6-luna', efforts: ['low' as const] }, { model: 'gpt-6-sol', efforts: ['high' as const, 'xhigh' as const] }];
    const hello = routeRequest('Hello', models);
    const payment = routeRequest('Plan and build an advanced payment system', models);
    expect(hello.context).toMatchObject({ category: 'conversation', complexDomain: false, architecture: false });
    expect(payment.context).toMatchObject({ category: 'coding', complexDomain: true, architecture: true });
    expect(hello.options.map(option => option.id)).toEqual(['0:low', '1:high', '1:xhigh']);
    expect(JSON.stringify(hello)).not.toContain('Hello');
    expect(JSON.stringify(payment)).not.toContain('Plan and build');
    const routes = parseConfig({ routingMode: 'auto', models, defaultRoute: { model: 'gpt-6-luna', effort: 'low' } });
    expect(selectRoute(routes, { contractVersion: '1', choice: '0:low', abstained: false, confidence: .9, probabilities: { '0:low': .9, '1:high': .07, '1:xhigh': .03 } }).route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(selectRoute(routes, { contractVersion: '1', choice: '1:xhigh', abstained: false, confidence: .9, probabilities: { '0:low': .05, '1:high': .15, '1:xhigh': .8 } }).route).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' });
    const abstained = { contractVersion: '1', abstained: true };
    const helloFallback = sensitiveArchitectureFallback(hello.context, routes);
    const paymentFallback = sensitiveArchitectureFallback(payment.context, routes);
    expect(helloFallback).toBeUndefined();
    expect(paymentFallback).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    expect(selectRoute(routes, abstained, undefined, helloFallback).route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(selectRoute(routes, abstained, undefined, paymentFallback)).toEqual({ route: { model: 'gpt-6-sol', effort: 'high' }, note: 'Policy fallback after Vex abstained or was uncertain' });
  });
  it('rejects unsupported effort in config', () => {
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['unknown'] }] })).toThrow();
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['max'] }] })).toThrow();
  });
  it('moves the configured fallback when its reasoning level is removed in the menu', () => {
    const current = parseConfig({ routingMode: 'auto', defaultRoute: { model: 'gpt-6-sol', effort: 'medium' }, models: [{ model: 'gpt-6-sol', efforts: ['medium', 'high'], defaultEffort: 'medium' }] });
    const updated = withModels(current, [{ model: 'gpt-6-sol', efforts: ['high'], defaultEffort: 'high' }]);
    expect(updated.defaultRoute).toEqual({ model: 'gpt-6-sol', effort: 'high' });
  });
});
