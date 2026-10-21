import { expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig } from '../src/shared/config.js';
import { chosenRoute, routeChoices, validateDecision } from '../src/core/routing/router.js';
import { costForUsage, PRICE_SNAPSHOT } from '../src/core/routing/pricing.js';
import { shapeRequest, stageRequest, taskRelationRequest } from '../src/core/vex/client.js';
import { parseRoutingSuite, summarizeRouting } from '../src/entrypoints/routing-benchmark.js';
import { handoffPrompt } from '../src/core/orchestrator-helpers.js';
import { DEFAULT_ROUTING_PROMPTS } from '../src/core/routing/routing-prompts.js';

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
  expect(shape.constraints).toContain('Plan and scout_plan stop after saving a plan in conversation artifacts');
  expect(shapeRequest(prompt, turns, DEFAULT_CONFIG.models.filter(model => model.model !== 'gpt-6-luna')).options.map(option => option.id)).toContain('scout');
  expect(shapeRequest(prompt, turns, DEFAULT_CONFIG.models.filter(model => model.model !== 'gpt-6-luna')).options.map(option => option.id)).toContain('scout_plan');
});

it('gives Vex full route choice and task context for paraphrased follow-ups', () => {
  const turns = [{ prompt: 'Plan a CSV export. Do not edit yet.', result: 'Add a writer, CLI flag, and tests.', at: '2026-09-30' }];
  const state = { previousRoute: { model: 'gpt-6-luna', effort: 'low' } as const, openTasks: ['Implement CSV writer'], hasCodexThread: true };
  for (const prompt of ['Implement this', 'Please turn that plan into working code', 'Go ahead with the changes']) {
    const shape = shapeRequest(prompt, turns, DEFAULT_CONFIG.models, undefined, state);
    const stage = stageRequest(prompt, turns, DEFAULT_CONFIG.models, 'Complete task', undefined, DEFAULT_CONFIG.models, undefined, state);
    expect(shape.context).toMatchObject({ originalRequest: prompt, recentConversation: [{ user: turns[0]!.prompt, assistant: turns[0]!.result }], conversationState: state });
    expect(shape.constraints).toContain('do not infer workload from message length');
    expect(stage.constraints).toContain('full remaining deliverable');
    expect(stage.options).toEqual(routeChoices(DEFAULT_CONFIG.models));
  }
  expect(shapeRequest('Start fresh', [], DEFAULT_CONFIG.models).context).not.toHaveProperty('followUp');
  const tenTurns = Array.from({ length: 10 }, (_, index) => ({ prompt: `Task detail ${index}`, result: `Progress ${index}`, at: '2026-09-30' }));
  expect(shapeRequest('Proceed', tenTurns, DEFAULT_CONFIG.models).context.recentConversation).toHaveLength(10);
  expect(handoffPrompt('Proceed', tenTurns, DEFAULT_ROUTING_PROMPTS)).toContain('Task detail 0');
});

it('bounds Vex conversation excerpts while keeping the full request for Codex', () => {
  const long = 'x'.repeat(20_000);
  const state = { openTasks: Array.from({ length: 15 }, () => long), activeTask: {
    originalRequest: long, instructions: Array.from({ length: 12 }, () => long), latestOutcome: long,
  } };
  const request = shapeRequest(long, [{ prompt: long, result: long, at: 'now' }], DEFAULT_CONFIG.models, undefined, state);
  const relation = taskRelationRequest(long, [], state);
  expect((request.context.originalRequest as string).length).toBeLessThan(12_100);
  expect((request.context.recentConversation as { user: string; assistant: string }[])[0]?.user.length).toBeLessThan(1_300);
  for (const context of [request.context, relation.context]) {
    const compact = context.conversationState as typeof state;
    expect(compact.activeTask.originalRequest.length).toBeLessThanOrEqual(3000);
    expect(compact.activeTask.instructions).toHaveLength(4);
    expect(compact.activeTask.instructions[0]?.length).toBeLessThanOrEqual(800);
    expect(compact.openTasks).toHaveLength(8);
  }
  expect(state.activeTask.originalRequest).toHaveLength(20_000);
});

it('offers Sol 6.1 with its current verified price and capability', () => {
  const model = { model: 'gpt-6.1-sol', efforts: ['medium', 'high'] as const, defaultEffort: 'medium' as const };
  const request = shapeRequest('Implement the feature', [], [model]);
  expect(request.context.availableModels).toEqual([expect.objectContaining({
    id: 'gpt-6.1-sol',
    capability: expect.stringContaining('near-Astra'),
    standardUsdPerMillionTokens: { input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 },
  })]);
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

it('accepts SDK-supported effort levels for user-selected models', () => {
  const config = parseConfig({ ...DEFAULT_CONFIG, models: [{ model: 'gpt-6-luna', efforts: ['ultra'] }], defaultRoute: { model: 'gpt-6-luna', effort: 'ultra' } });
  expect(config.models[0]?.efforts).toEqual(['ultra']);
  expect(() => parseConfig({ ...DEFAULT_CONFIG, models: [{ model: 'gpt-6-luna', efforts: ['max'] }] })).toThrow('max');
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
