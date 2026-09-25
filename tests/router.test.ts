import { describe, expect, it } from 'vitest';
import { selectRoute } from '../src/core/router.js';
import { parseConfig } from '../src/config.js';
import { parseJevOutput, routeRequest } from '../src/integrations/jev.js';
const config = parseConfig({ routingMode: 'auto', models: [
  { model: 'route-one', efforts: ['medium'] }, { model: 'route-two', efforts: ['high'] },
], defaultRoute: { model: 'route-one', effort: 'medium' } });
describe('routing', () => {
  it('accepts only confident configured Jev choices', () => {
    expect(selectRoute(config, { answers: { route: { choice: '1', confidence: .9, probabilities: { '0': .1, '1': .9 } } } }).route).toEqual({ model: 'route-two', effort: 'high' });
    expect(selectRoute(config, { answers: { route: { choice: 'evil', confidence: 1, probabilities: { '0': 0, '1': 1 } } } }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, { answers: { route: { choice: '1', confidence: .6, probabilities: { '0': .1, '1': .9 } } } }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, { answers: { route: { choice: '0', confidence: .9, probabilities: { '0': .1, '1': .9 } } } }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, { error: true }).route).toEqual(config.defaultRoute);
    expect(selectRoute(config, undefined).route).toEqual(config.defaultRoute);
  });
  it('keeps raw prompts out of Jev requests', () => {
    const request = JSON.stringify(routeRequest('fix SECRET_TOKEN=https://private.example/path', config.models));
    expect(request).not.toContain('SECRET_TOKEN');
    expect(request).not.toContain('private.example');
    expect(request).toContain('debugging');
  });
  it('rejects unsupported effort in config', () => {
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['unknown'] }] })).toThrow();
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['max'] }] })).toThrow();
  });
  it('rejects malformed Jev stdout', () => {
    expect(() => parseJevOutput('not json')).toThrow('invalid JSON');
    expect(() => parseJevOutput('[]')).toThrow('invalid JSON');
  });
});
