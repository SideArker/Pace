import { expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig } from '../src/config.js';
import { chosenRoute, routeChoices, validateDecision } from '../src/core/router.js';
import { costForUsage, PRICE_SNAPSHOT } from '../src/core/pricing.js';
import { shapeRequest, stageRequest } from '../src/integrations/vex.js';
import { parseRoutingSuite, summarizeRouting } from '../src/routing-benchmark.js';

it('sends original request, recent conversation, all valid pairs, capabilities, and prices', () => {
  const prompt = 'Plan a payment system. Do not implement it.';
  const turns = [{ prompt: 'Previous request', result: 'Previous answer', at: '2026-09-26' }];
  const shape = shapeRequest(prompt, turns, DEFAULT_CONFIG.models);
  const stage = stageRequest(prompt, turns, DEFAULT_CONFIG.models, 'Produce requested plan', '{"summary":"repo finding"}');
  expect(shape.context).toMatchObject({ originalRequest: prompt, recentConversation: [{ user: 'Previous request', assistant: 'Previous answer' }] });
  expect(shape.context.availableModels).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'gpt-6-sol', standardUsdPerMillionTokens: PRICE_SNAPSHOT.rates['gpt-6-sol'] })]));
  expect(stage.context).toMatchObject({ originalRequest: prompt, stageObjective: 'Produce requested plan', priorStageHandoff: '{"summary":"repo finding"}' });
  expect(stage.options).toEqual(routeChoices(DEFAULT_CONFIG.models));
  expect(stage.options).toHaveLength(10);
  expect(shape.decisionType).toBe('routing');
  expect(shape.constraints).toContain('plan must choose single, scout, or clarify');
  expect(shapeRequest(prompt, turns, DEFAULT_CONFIG.models.filter(model => model.model !== 'gpt-6-luna')).options.map(option => option.id)).not.toContain('scout');
});

it('accepts narrow leads and exact ties, rejects invalid or inconsistent choices', () => {
  const options = [{ id: 'first', description: 'First' }, { id: 'second', description: 'Second' }];
  const result = (choice: string, probabilities: Record<string, number>) => ({ contractVersion: '1', abstained: false, choice, confidence: 0.51, probabilities });
  expect(validateDecision(result('second', { first: 0.49, second: 0.50 }), options).choice).toBe('second');
  expect(validateDecision(result('first', { first: 0.5, second: 0.5 }), options).choice).toBe('first');
  expect(() => validateDecision(result('second', { first: 0.5, second: 0.5 }), options)).toThrow('highest ranked');
  expect(() => validateDecision(result('other', { first: 0.1, second: 0.9 }), options)).toThrow();
  expect(() => validateDecision({ ...result('first', { first: 0.5, second: 0.5 }), abstained: true }, options)).toThrow();
  expect(() => validateDecision(result('first', { first: 0.5, second: 0.5, invented: 0 }), options)).toThrow();
});

it('prices ordinary, cached, cache writes, and output once at the stage model rate', () => {
  const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 };
  expect(costForUsage({ model: 'gpt-6-sol', effort: 'high' }, usage)).toBeCloseTo((70 * 2 + 20 * 0.2 + 10 * 2.5 + 5 * 10) / 1_000_000, 12);
  expect(costForUsage({ model: 'gpt-6-luna', effort: 'low' }, usage)).toBeCloseTo((70 * 0.1 + 20 * 0.01 + 10 * 0.125 + 5 * 0.5) / 1_000_000, 12);
  expect(() => costForUsage({ model: 'gpt-6-sol' }, { ...usage, cached_input_tokens: 101 })).toThrow('cache tokens exceed');
  expect(chosenRoute('1:high', DEFAULT_CONFIG.models)).toEqual({ model: 'gpt-6-sol', effort: 'high' });
});

it('rejects configured model efforts unsupported by Codex', () => {
  expect(() => parseConfig({ ...DEFAULT_CONFIG, models: [{ model: 'gpt-6-luna', efforts: ['ultra'] }] })).toThrow('Unsupported effort');
});

it('validates routing benchmark labels and counts failed calls separately', () => {
  const item = { id: 'one', category: 'plan_only', prompt: 'Plan it.', preferred: 'single', acceptable: ['single', 'scout'], reason: 'Plan only' };
  expect(parseRoutingSuite({ version: 1, cases: [item] }).cases).toHaveLength(1);
  expect(() => parseRoutingSuite({ version: 1, cases: [item, item] })).toThrow('Invalid routing case');
  expect(() => parseRoutingSuite({ version: 1, cases: [{ ...item, preferred: 'plan_execute' }] })).toThrow('Invalid routing case');
  const summary = summarizeRouting([
    { id: 'one', category: 'plan_only', repetition: 1, promptSha256: 'a', preferred: 'single', acceptable: ['single', 'scout'],
      shape: 'scout', acceptableHit: true, preferredHit: false, decisions: [], vexCalls: 3, retries: 1, elapsedMs: 10 },
    { id: 'one', category: 'plan_only', repetition: 2, promptSha256: 'a', preferred: 'single', acceptable: ['single', 'scout'],
      decisions: [], vexCalls: 2, retries: 1, elapsedMs: 20, error: 'Vex failed' },
  ]);
  expect(summary).toMatchObject({ total: 2, completed: 1, errors: 1, acceptable: 1, preferred: 0,
    selectedShapes: { scout: 1 }, vexCalls: 5, retries: 2 });
});
