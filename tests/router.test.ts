import { describe, expect, it } from 'vitest';
import { selectRoute } from '../src/core/router.js';
import { parseConfig } from '../src/config.js';
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
  it('rejects unsupported effort in config', () => {
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['unknown'] }] })).toThrow();
    expect(() => parseConfig({ ...config, models: [{ model: 'route-one', efforts: ['max'] }] })).toThrow();
  });
});
