import { describe, expect, it } from 'vitest';
import { directRoute, policyRoute, routingCandidates, selectRoute } from '../src/core/router.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { parseConfig, withModels } from '../src/config.js';
import { routeRequest } from '../src/integrations/vex.js';
const config = parseConfig({ routingMode: 'auto', models: [
  { model: 'route-one', efforts: ['medium'] }, { model: 'route-two', efforts: ['high'] },
], defaultRoute: { model: 'route-one', effort: 'medium' } });
describe('routing', () => {
  it('offers Vex one locally selected effort per model', () => {
    const models = [
      { model: 'gpt-6-sol', efforts: ['low' as const, 'medium' as const, 'high' as const], defaultEffort: 'medium' as const },
      { model: 'gpt-6-luna', efforts: ['low' as const, 'medium' as const, 'high' as const], defaultEffort: 'low' as const },
    ];
    const ordinary = routingCandidates(models, routeRequest('Fix a small bug', models).context);
    expect(ordinary.map(model => model.efforts)).toEqual([['medium'], ['low']]);
    expect(routeRequest('Fix a small bug', ordinary).options).toHaveLength(2);
    expect(routeRequest('Fix a small bug', ordinary).question).toContain('model should handle');
    const demanding = routingCandidates(models, routeRequest('Fix tests across multiple files', models).context);
    expect(demanding.map(model => model.efforts)).toEqual([['high'], ['low']]);
    expect(routingCandidates(models, routeRequest('Hello', models).context).map(model => model.efforts)).toEqual([['low'], ['low']]);
    expect(routingCandidates(models, routeRequest('Find the test files', models).context).map(model => model.efforts)).toEqual([['low'], ['low']]);
  });
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
    const helloFallback = policyRoute(hello.context, routes);
    const paymentFallback = policyRoute(payment.context, routes);
    expect(helloFallback).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(paymentFallback).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' });
    expect(selectRoute(routes, abstained, undefined, helloFallback).route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(selectRoute(routes, abstained, undefined, paymentFallback)).toEqual({ route: { model: 'gpt-6-sol', effort: 'xhigh' }, note: 'Policy fallback after Vex abstained or was uncertain' });
  });
  it('classifies a conversational factual question without exposing its subject and falls back to Luna', () => {
    const models = [{ model: 'gpt-6-luna', efforts: ['low' as const] }, { model: 'gpt-6-sol', efforts: ['medium' as const] }];
    const routes = parseConfig({ routingMode: 'auto', models, defaultRoute: { model: 'gpt-6-sol', effort: 'medium' } });
    const question = routeRequest('Hey, do you mind telling me what mitochondria is used for?', models);
    expect(question.context).toMatchObject({ category: 'general_knowledge', intent: 'brief factual explanation' });
    expect(JSON.stringify(question)).not.toContain('mitochondria');
    const fallback = directRoute(question.context, routes);
    expect(selectRoute(routes, { contractVersion: '1', abstained: true, reason: 'Insufficient information' }, undefined, fallback))
      .toEqual({ route: { model: 'gpt-6-luna', effort: 'low' }, note: 'Policy fallback after Vex abstained or was uncertain' });
    expect(routeRequest('Plan and build a payment system', models).context.category).toBe('coding');
  });
  it('treats current factual lookups as light work without weakening coding and complex-task routes', () => {
    const weather = routeRequest("What's today's weather in Warsaw?", DEFAULT_CONFIG.models);
    expect(weather.context).toMatchObject({ category: 'general_knowledge', intent: 'current-information lookup', currentInfo: true });
    expect(directRoute(weather.context, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(JSON.stringify(weather)).not.toContain('Warsaw');
    expect(routeRequest('Weather in Warsaw today', DEFAULT_CONFIG.models).context.category).toBe('general_knowledge');
    expect(routeRequest("What's wrong with the test in src/app.tsx?", DEFAULT_CONFIG.models).context.category).toBe('debugging');
    const architecture = routeRequest("What's the security architecture for payments?", DEFAULT_CONFIG.models).context;
    expect(directRoute(architecture, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'high' });
    expect(policyRoute(architecture, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'high' });
    const longExplanation = routeRequest(`Explain ${'the implications '.repeat(45)}`, DEFAULT_CONFIG.models).context;
    expect(directRoute(longExplanation, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'medium' });
    expect(policyRoute(longExplanation, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'medium' });
  });
  it('uses clear policy routes for exploration, ordinary coding, and sensitive architecture', () => {
    expect(DEFAULT_CONFIG.models.map(model => model.model)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra']);
    const explore = routeRequest('Find the router implementation in this repo', DEFAULT_CONFIG.models);
    expect(explore.context.category).toBe('exploration');
    expect(policyRoute(explore.context, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(policyRoute(routeRequest('Fix a small bug', DEFAULT_CONFIG.models).context, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
    expect(policyRoute(routeRequest('Plan the security architecture for payments', DEFAULT_CONFIG.models).context, DEFAULT_CONFIG)).toEqual({ model: 'gpt-6-luna', effort: 'high' });
  });
  it('routes clear planning and build examples by task demand', () => {
    const examples = [
      ['Make me a plan', 'planning', 'gpt-6-luna', 'medium'],
      ['Help me plan an architectural design', 'planning', 'gpt-6-luna', 'high'],
      ['Analyze this repository', 'exploration', 'gpt-6-luna', 'low'],
      ['Analyze the current codebase and plan how to make an alert system', 'planning', 'gpt-6-luna', 'high'],
      ['Plan how to build an alert system', 'planning', 'gpt-6-luna', 'high'],
      ['Build a strong PDF generation system', 'coding', 'gpt-6-sol', 'high'],
      ['Build a simple website', 'coding', 'gpt-6-sol', 'medium'],
      ['Implement new functionality', 'coding', 'gpt-6-sol', 'high'],
      ['Plan and build an advanced payment system', 'coding', 'gpt-6-sol', 'xhigh'],
      ['Plan then build an advanced payment system', 'coding', 'gpt-6-sol', 'xhigh'],
      ['Build a production payment system', 'coding', 'gpt-6-sol', 'xhigh'],
      ['Create a planning artifact', 'coding', 'gpt-6-sol', 'high'],
      ['Implement a routing strategy', 'coding', 'gpt-6-sol', 'high'],
      ['Migrate the production payment system during an outage', 'refactoring', 'gpt-6-sol', 'ultra'],
    ] as const;
    for (const [prompt, category, model, effort] of examples) {
      const context = routeRequest(prompt, DEFAULT_CONFIG.models).context;
      expect(context.category, prompt).toBe(category);
      expect(policyRoute(context, DEFAULT_CONFIG), prompt).toEqual({ model, effort });
      expect(JSON.stringify(routeRequest(prompt, DEFAULT_CONFIG.models))).not.toContain(prompt);
    }
  });
  it('recovers a clear model consensus when Vex abstains on individual effort confidence', () => {
    const routes = parseConfig({ routingMode: 'auto', models: [
      { model: 'gpt-6-luna', efforts: ['low'] },
      { model: 'gpt-6-sol', efforts: ['high', 'xhigh'] },
    ], defaultRoute: { model: 'gpt-6-luna', effort: 'low' } });
    const abstained = { contractVersion: '1', choice: null, abstained: true, reason: 'Insufficient confidence or probability lead', confidence: .54, probabilities: { '0:low': 0, '1:high': .33, '1:xhigh': .66 } };
    expect(selectRoute(routes, abstained)).toEqual({ route: { model: 'gpt-6-sol', effort: 'xhigh' }, note: 'Selected from Vex model consensus after route abstention' });
    expect(selectRoute(routes, { ...abstained, probabilities: { '0:low': .04, '1:high': .6, '1:xhigh': .17 } }).route).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    expect(selectRoute(routes, { ...abstained, probabilities: { '0:low': .01, '1:high': .2, '1:xhigh': .15 } }).route).toEqual(routes.defaultRoute);
    expect(selectRoute(routes, { ...abstained, probabilities: { '0:low': .51, '1:high': .25, '1:xhigh': .24 } }).route).toEqual(routes.defaultRoute);
    expect(selectRoute(routes, { ...abstained, reason: 'Insufficient information' }).route).toEqual(routes.defaultRoute);
    expect(selectRoute(routes, { ...abstained, probabilities: { '0:low': 0, '1:high': .33, '1:xhigh': 1.2 } }).route).toEqual(routes.defaultRoute);
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
