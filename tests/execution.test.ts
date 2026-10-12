import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession, undoConversationTurn } from '../src/core/sessions.js';
import { AppServerRunner, appServerThreadParams, appServerTurnParams, appUsage, codexOptions, eventProgress, SdkRunner, type CodexRunner, type Progress } from '../src/integrations/codex.js';
import { serverArgs } from '../src/integrations/app-server-process.js';
import type { Config, Route } from '../src/shared/types.js';
import type { VexRequest } from '../src/core/vex/client.js';
import { decision } from './routing-fixture.js';
import { checkpointDue } from '../src/core/checkpoint.js';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-sol', effort: 'high' }, models: [
  { model: 'gpt-6-luna', efforts: ['low'] }, { model: 'gpt-6-sol', efforts: ['medium', 'high'] },
] };

it('keeps the existing thread when routing changes model', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { id?: string; route: Route; prompt: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, id, progress) {
    calls.push({ id, route, prompt });
    if (!id) await progress({ kind: 'thread', text: 'thread-1' });
    return { threadId: 'thread-1', result: 'done', completed: true };
  } };
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'continue' ? 'replace' : request.options[0]?.id === 'single' ? 'single' : request.context.originalRequest === 'first' ? '1:high' : '0:low') };
  const orchestrator = new Orchestrator(store, runner, vex);
  await orchestrator.turn('first', session, config, () => {});
  await orchestrator.turn('second', session, config, () => {});
  expect(calls[0]).toMatchObject({ id: undefined, route: { model: 'gpt-6-sol', effort: 'high' } });
  expect(calls[1]).toMatchObject({ id: 'thread-1', route: { model: 'gpt-6-luna', effort: 'low' } });
  expect(calls[1]?.prompt).not.toContain('Retained conversation:');
  expect((await store.latest('/example/project'))?.turns).toHaveLength(2);
});

it('lets Vex route paraphrased implementation follow-ups using conversation state', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto');
  session.threadId = 'thread-1';
  session.tasks = [{ id: 'csv', text: 'Implement CSV writer', completed: false, source: 'agent' }];
  session.turns.push({ prompt: 'Plan a CSV export and tests. No edits yet.', result: 'I found the export code. The implementation remains.', at: '2026-09-30' });
  const requests: VexRequest[] = [];
  const calls: { prompt: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route) {
    calls.push({ prompt, route });
    return { threadId: 'thread-1', result: 'Implemented and tested', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === 'continue' ? 'continue' : request.options[0]?.id === 'single' ? 'single' : '1:high');
  } };
  const orchestrator = new Orchestrator(new PaceStore(dir), runner, vex);
  await orchestrator.turn('Could you turn that plan into working code?', session, config, () => {});
  expect(requests[1]?.context).toMatchObject({
    originalRequest: 'Could you turn that plan into working code?',
    recentConversation: [{ user: 'Plan a CSV export and tests. No edits yet.', assistant: 'I found the export code. The implementation remains.' }],
    conversationState: { openTasks: ['Implement CSV writer'], hasCodexThread: true },
  });
  expect(requests[0]?.context.conversationState).toMatchObject({ activeTask: { originalRequest: 'Plan a CSV export and tests. No edits yet.' } });
  expect(requests[2]?.options.map(option => option.id)).toEqual(['0:low', '1:medium', '1:high']);
  expect(calls[0]?.route).toEqual({ model: 'gpt-6-sol', effort: 'high' });
  expect(calls[0]?.prompt).toMatch(/^Could you turn that plan into working code\?/);
  expect(calls[0]?.prompt).not.toContain('Follow-up task context:');
});

it('continues a saved task when Vex would otherwise ask for the deliverable again', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto');
  session.threadId = 'thread-1';
  session.activeTask = { originalRequest: 'Implement CSV export and tests', instructions: ['Use the existing writer'], latestOutcome: 'Usage limit before completion', failed: true };
  session.turns.push({ prompt: 'BRO CONTINUE', result: 'Usage limit', failed: true, at: '2026-10-05' });
  const requests: VexRequest[] = [];
  let executionPrompt = '';
  const runner: CodexRunner = { async run(prompt) {
    executionPrompt = prompt;
    return { threadId: 'thread-1', result: 'Implemented CSV export and tests', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options.some(option => option.id === 'clarify') ? 'clarify' : request.options[0]?.id ?? '1:high');
  } };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('BRO CONTINUE', session, config, () => {});
  expect(requests[0]?.options.map(option => option.id)).not.toContain('clarify');
  expect(requests[0]?.context.conversationState).toMatchObject({ activeTask: { originalRequest: 'Implement CSV export and tests' } });
  expect(executionPrompt).toContain("Use this Codex thread's earlier conversation and tool history");
  expect(executionPrompt).not.toContain("Pace's saved task brief");
  expect(outcome.result).toBe('Implemented CSV export and tests');
  expect(session.activeTask?.originalRequest).toBe('Implement CSV export and tests');
});

it('routes a continuation into the Codex thread when Pace lacks the original task brief', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto');
  session.threadId = 'thread-with-history';
  session.turns.push({ prompt: 'BRO CONTINUE', result: 'What outcome would you like?', routeNote: 'Vex requested clarification', at: '2026-10-05' });
  const requests: VexRequest[] = [];
  let sentThread: string | undefined;
  let sentPrompt = '';
  const runner: CodexRunner = { async run(prompt, _project, _route, id) {
    sentThread = id;
    sentPrompt = prompt;
    return { threadId: id, result: 'Continued original work', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options.some(option => option.id === 'clarify') ? 'clarify' : request.options[0]?.id ?? '1:high');
  } };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('BRO CONTINUE', session, config, () => {});
  expect(requests[0]?.options.map(option => option.id)).toEqual(['continue', 'replace', 'aside']);
  expect(requests[1]?.options.map(option => option.id)).toEqual(['single', 'plan', 'scout_plan']);
  expect(sentThread).toBe('thread-with-history');
  expect(sentPrompt).toContain("Use this Codex thread's earlier conversation and tool history");
  expect(outcome.result).toBe('Continued original work');
  expect(session.activeTask).toBeUndefined();
});

it('replays only retained turns after undo starts a new Codex thread', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto');
  session.threadId = 'old-thread';
  session.turns = [
    { prompt: 'Keep this request', result: 'Kept answer', at: '2026-01-01' },
    { prompt: 'Remove this request', result: 'Removed answer', at: '2026-01-02' },
  ];
  undoConversationTurn(session);
  let sentPrompt = '';
  let sentThread: string | undefined;
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId) {
    sentPrompt = prompt;
    sentThread = threadId;
    return { threadId: 'new-thread', result: 'done', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'continue' ? 'replace' : request.options[0]?.id === 'single' ? 'single' : '1:high') };
  await new Orchestrator(new PaceStore(dir), runner, vex).turn('Current request', session, config, () => {});
  expect(sentThread).toBeUndefined();
  expect(sentPrompt).toContain('Keep this request');
  expect(sentPrompt).toContain('Kept answer');
  expect(sentPrompt).not.toContain('Remove this request');
  expect(sentPrompt).not.toContain('Removed answer');
  expect(sentPrompt).toContain('Current request');
  expect(session.threadId).toBe('new-thread');
});

it('runs a read-only scout, reroutes after handoff, and sums stage costs', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { route: Route; mode?: string; prompt: string; id?: string }[] = [];
  const scoutUsage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 };
  const mainUsage = { input_tokens: 200, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 10 };
  const runner: CodexRunner = { async run(prompt, _project, route, id, _progress, _signal, mode) {
    calls.push({ route, mode, prompt, id });
    return mode === 'side'
      ? { result: JSON.stringify({ summary: 'Edit src/a.ts', findings: [{ path: 'src/a.ts', line: 12, finding: 'Parser is defined here', relevance: 'Target for edit' }], nextSteps: ['Update parser'], checks: ['npm test'], risks: [], privateTrace: 'unshared scout history' }), completed: true, usage: scoutUsage }
      : { result: 'done', completed: true, usage: mainUsage };
  } };
  const requests: VexRequest[] = [];
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === 'continue' ? 'replace' : request.options[0]?.id === 'single' ? 'scout' : request.context.stageObjective === 'Read-only repository scout' ? '0:low' : '1:high');
  } };
  const session = newSession('/example/project', 'auto');
  session.threadId = 'existing-main-thread';
  session.turns.push({ prompt: 'We discussed the parser in src/a.ts', result: 'The parser needs an update.', at: new Date().toISOString() });
  const notices: string[] = [];
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, progress => {
    if (progress.kind === 'system') notices.push(progress.text);
  });
  expect(notices).toEqual([
    "Vex chose scout: Luna read-only scout identifies relevant files, behavior, and tests; second agent completes the request from a structured handoff. Use when broad or uncertain repository exploration can materially reduce completion-agent work. Include both stages in total Codex cost.",
    "Vex routed to gpt-6-luna at low reasoning",
    "Vex routed to gpt-6-sol at high reasoning",
  ]);
  expect(session.turns.at(-1)?.systemMessages).toEqual(notices);
  expect(calls.map(call => call.mode)).toEqual(['side', 'main']);
  expect(calls.map(call => call.id)).toEqual([undefined, 'existing-main-thread']);
  expect(calls[0]?.prompt).toContain('We discussed the parser in src/a.ts');
  expect(calls[0]?.route).toEqual({ model: 'gpt-6-luna', effort: 'low' });
  expect(requests[2]?.options.map(option => option.id)).toEqual(['0:low']);
  expect((requests[2]?.context.availableModels as { id: string }[]).map(model => model.id)).toContain('gpt-6-sol');
  expect(calls[1]?.prompt).toContain('Parser is defined here');
  expect(calls[1]?.prompt).not.toContain('Retained conversation:');
  expect(calls[1]?.prompt).not.toContain('unshared scout history');
  expect(requests[3]?.context.priorStageHandoff).toContain('src/a.ts');
  expect(requests[3]?.context.priorStageHandoff).not.toContain('unshared scout history');
  expect(outcome.stages[0]?.handoff).toContain('Parser is defined here');
  expect((await new PaceStore(dir).latest('/example/project'))?.turns.at(-1)?.stages?.[0]?.handoff).toContain('Parser is defined here');
  expect(outcome.usage).toMatchObject({ input_tokens: 300, output_tokens: 25 });
  expect(outcome.estimatedCostUsd).toBeCloseTo(outcome.stages[0]!.estimatedCostUsd! + outcome.stages[1]!.estimatedCostUsd!, 12);
  expect(outcome.routing).toHaveLength(4);
});

it('passes scout findings to a terminal read-only plan', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { prompt: string; mode?: string; threadId?: string }[] = [];
  const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2 };
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId, _progress, _signal, mode) {
    calls.push({ prompt, mode, threadId });
    return { result: calls.length === 1
      ? JSON.stringify({ summary: 'Scout found parser', findings: [], nextSteps: [], checks: [], risks: [] })
      : '# Plan parser migration\n\nScout found parser.\n', threadId: calls.length === 2 ? 'plan-thread' : undefined, completed: true, usage };
  } };
  const requests: VexRequest[] = [];
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === 'single' ? 'scout_plan' : '0:low');
  } };
  const session = newSession('/example/project', 'auto');
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement broad migration', session, config, () => {});
  expect(calls.map(call => call.mode)).toEqual(['side', 'side']);
  expect(calls[1]?.prompt).toContain('Scout found parser');
  expect(calls[1]?.prompt).toContain('pace-planning');
  expect(calls.map(call => call.threadId)).toEqual([undefined, undefined]);
  expect(requests[2]?.context.priorStageHandoff).toContain('Scout found parser');
  expect(outcome.stages).toHaveLength(2);
  expect(outcome.routing).toHaveLength(3);
  expect(outcome.usage?.input_tokens).toBe(200);
  expect(outcome.estimatedCostUsd).toBeCloseTo(outcome.stages.reduce((sum, stage) => sum + stage.estimatedCostUsd!, 0), 12);
  expect(session.kind).toBe('planning');
  expect(session.threadId).toBe('plan-thread');
  expect(session.plan).toContain('Scout found parser');
  expect(outcome.result).toContain('.pace-plan.md');
});

it('starts a fresh main thread from a valid checkpoint and counts turns per thread', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  session.threadId = 'old-thread';
  session.turns = Array.from({ length: 16 }, (_, index) => ({ prompt: `old-${index}`, result: `result-${index}`, at: `turn-${index}` }));
  session.checkpoint = { createdAt: 'now', sourceTurnAt: 'turn-15', threadId: 'old-thread', route: session.route,
    note: { complete: true, goal: 'Finish parser', constraints: [], findings: [], changes: [], checks: [], unfinished: ['Add tests'], questions: [], risks: [] }, durationMs: 10 };
  const calls: { prompt: string; threadId?: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, threadId) {
    calls.push({ prompt, threadId });
    return { threadId: threadId ?? 'fresh-thread', result: 'done', completed: true };
  } };
  const store = new PaceStore(dir);
  await store.save(session);
  session = (await store.latest(session.projectPath))!;
  const orchestrator = new Orchestrator(store, runner);
  const manual = { ...config, routingMode: 'manual' as const };
  await orchestrator.turn('Add tests', session, manual, () => {});
  expect(calls[0]?.threadId).toBeUndefined();
  expect(calls[0]?.prompt).toContain('Finish parser');
  expect(calls[0]?.prompt).not.toContain('old-0');
  expect(session.threadId).toBe('fresh-thread');
  expect(session.threadTurnCount).toBe(1);
  expect(checkpointDue(session)).toBe(false);
  session = (await store.latest(session.projectPath))!;
  await orchestrator.turn('Check results', session, manual, () => {});
  expect(calls[1]?.threadId).toBe('fresh-thread');
  expect(calls[1]?.prompt).not.toContain('Finish parser');
  expect(session.threadTurnCount).toBe(2);
});

it('does not resume the old thread when a fresh run omits its new ID', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  session.threadId = 'old-thread';
  session.turns = [{ prompt: 'Original work', result: 'Partial work', at: 'turn-1' }];
  session.checkpoint = { createdAt: 'now', sourceTurnAt: 'turn-1', threadId: 'old-thread', route: session.route,
    note: { complete: true, goal: 'Finish work', constraints: [], findings: [], changes: [], checks: [], unfinished: ['Test'], questions: [], risks: [] }, durationMs: 10 };
  const runner: CodexRunner = { async run(_prompt, _project, _route, threadId) {
    expect(threadId).toBeUndefined();
    return { result: 'done', completed: true };
  } };
  await new Orchestrator(new PaceStore(dir), runner).turn('Test', session, { ...config, routingMode: 'manual' }, () => {});
  expect(session.threadId).toBeUndefined();
  expect(session.threadTurnCount).toBe(1);
});

it('asks for clarification without starting Codex', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = { choose: async (request: VexRequest) => decision(request, 'clarify') };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Something', newSession('/example/project', 'auto'), config, () => {});
  expect(outcome.result).toContain('What outcome');
  expect(outcome.stages).toHaveLength(0);
});

it('prompts user interactively when Vex chooses clarify and proceeds with chosen single workflow', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let ranPrompt = '';
  const runner: CodexRunner = { async run(prompt) { ranPrompt = prompt; return { result: 'completed single', completed: true }; } };
  const vex = {
    choose: async (request: VexRequest) => {
      if (request.options.some(o => o.id === 'clarify')) return decision(request, 'clarify');
      return decision(request, request.options[0]!.id);
    },
  };
  let questionSeen: any;
  const onProgress = Object.assign((progress: any) => {
    if (progress.kind === 'question') {
      questionSeen = progress;
      progress.respond({ workflow: { answers: ['Run as single agent'] } });
    }
  }, { interactive: true });

  const session = newSession('/example/project', 'auto');
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Fix the thing', session, config, onProgress);
  expect(questionSeen).toBeDefined();
  expect(questionSeen.questions[0].header).toBe('Clarification Needed');
  expect(outcome.result).toBe('completed single');
  expect(ranPrompt).toContain('Fix the thing');
  expect(outcome.stages).toHaveLength(1);
});

it('prompts user interactively when Vex chooses clarify and uses manual route bypass', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let ranRoute: any;
  const runner: CodexRunner = { async run(_p, _dir, route) { ranRoute = route; return { result: 'completed manual', completed: true }; } };
  const vex = {
    choose: async (request: VexRequest) => decision(request, 'clarify'),
  };
  const onProgress = Object.assign((progress: any) => {
    if (progress.kind === 'question') {
      progress.respond({ workflow: { answers: ['Use manual route (GPT-6 Sol Medium)'] } });
    }
  }, { interactive: true });

  const session = newSession('/example/project', 'auto');
  session.route = { model: 'gpt-6-sol', effort: 'medium' };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Something ambiguous', session, config, onProgress);
  expect(outcome.result).toBe('completed manual');
  expect(ranRoute).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
  expect(outcome.note).toContain('Manual route');
});

it('prompts user interactively and updates request with typed clarification', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let ranPrompt = '';
  const runner: CodexRunner = { async run(prompt) { ranPrompt = prompt; return { result: 'completed with clarification', completed: true }; } };
  let calls = 0;
  const vex = {
    choose: async (request: VexRequest) => {
      calls++;
      if (calls === 1) return decision(request, 'clarify');
      if (request.options.some(o => o.id === 'single')) return decision(request, 'single');
      return decision(request, request.options[0]!.id);
    },
  };
  const onProgress = Object.assign((progress: any) => {
    if (progress.kind === 'question') {
      progress.respond({ workflow: { answers: ['Inspect the auth tests and fix JWT expiration'] } });
    }
  }, { interactive: true });

  const session = newSession('/example/project', 'auto');
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Fix it', session, config, onProgress);
  expect(outcome.result).toBe('completed with clarification');
  expect(ranPrompt).toContain('Clarification: Inspect the auth tests and fix JWT expiration');
  expect(outcome.stages).toHaveLength(1);
});

it('stops before completion when scout report lacks verifiable findings schema', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let mainRuns = 0;
  const sidePrompts: string[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, _id, _progress, _signal, mode) {
    if (mode === 'side') {
      sidePrompts.push(prompt);
      return { result: JSON.stringify({ summary: 'Found code', files: ['src/a.ts'], checks: [], risks: [] }), completed: true };
    }
    mainRuns++;
    return { result: 'unexpected', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'scout' : '0:low') };
  const session = newSession('/example/project', 'auto');
  await expect(new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', session, config, () => {})).rejects.toThrow('Invalid stage handoff');
  expect(mainRuns).toBe(0);
  expect(sidePrompts).toHaveLength(2);
  expect(sidePrompts[1]).toContain('Your previous report was rejected');
  expect(session.turns.at(-1)?.failed).toBe(true);
  expect(session.turns.at(-1)?.stages).toHaveLength(2);
});

it('uses a corrected scout report for the completion stage', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let sideRuns = 0;
  const runner: CodexRunner = { async run(prompt, _project, _route, _id, _progress, _signal, mode) {
    if (mode === 'side') {
      sideRuns++;
      return { result: sideRuns === 1
        ? JSON.stringify({ summary: 'Found code', files: ['src/a.ts'] })
        : JSON.stringify({ summary: 'Found code', findings: [{ path: 'src/a.ts', finding: 'Parser lives here', relevance: 'Edit target' }], nextSteps: ['Edit parser'], checks: [], risks: [] }), completed: true };
    }
    expect(prompt).toContain('Parser lives here');
    return { result: 'done', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'scout' : '0:low') };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Implement feature', newSession('/example/project', 'auto'), config, () => {});
  expect(sideRuns).toBe(2);
  expect(outcome.stages).toHaveLength(3);
  expect(outcome.stages[1]?.handoff).toContain('Parser lives here');
});

it('stops after a Vex-selected read-only plan', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { mode?: string; prompt: string; route: Route }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, _id, _progress, _signal, mode) {
    calls.push({ prompt, route, mode });
    return { result: '# Parser plan\n\n1. Update src/parser.ts.\n', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => decision(request, request.options[0]?.id === 'single' ? 'plan' : '1:high') };
  const session = newSession('/example/project', 'auto');
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Plan parser changes', session, config, () => {});
  expect(calls.map(call => call.mode)).toEqual(['side']);
  expect(calls[0]?.prompt).toContain('[PLANNING MODE INSTRUCTION]');
  expect(outcome.stages.map(stage => stage.route)).toEqual([{ model: 'gpt-6-sol', effort: 'high' }]);
  expect(session.kind).toBe('planning');
  expect(session.plan).toContain('Update src/parser.ts');
  expect(outcome.result).toContain('.pace-plan.md');
  expect((await new PaceStore(dir).latest(session.projectPath))?.kind).toBe('planning');
});

it('keeps explicit plan execution on writable completion routes', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto', 'normal');
  const requests: VexRequest[] = [];
  const calls: { mode?: string; prompt: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, _route, _id, _progress, _signal, mode) {
    calls.push({ prompt, mode });
    return { result: 'Implemented', completed: true };
  } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options[0]?.id === 'single' ? 'single' : '1:high');
  } };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn(
    'Implement this saved plan', session, config, () => {}, undefined, true, 'execute_plan',
  );
  expect(requests[0]?.options.map(option => option.id)).toEqual(['single', 'scout']);
  expect(requests[0]?.constraints).toContain('The user invoked /execute');
  expect(calls.map(call => call.mode)).toEqual(['main']);
  expect(outcome.result).toBe('Implemented');
  expect(session.kind).toBe('normal');
});

it('loads an older manual plan-verify workflow as plan only', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const calls: { prompt: string; route: Route; mode?: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, _id, _progress, _signal, mode) {
    calls.push({ prompt, route, mode });
    return { result: '# Legacy plan\n\nUpdate parser.\n', completed: true };
  } };
  const session = newSession(dir, 'manual');
  session.manualWorkflow = { shape: 'plan_verify', routes: {
    plan: { model: 'gpt-6-luna', effort: 'low' }, final: { model: 'gpt-6-sol', effort: 'high' },
  } };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, { choose: async () => { throw new Error('Vex should not choose explicit routes'); } }).turn('Plan parser', session, config, () => {});
  expect(calls.map(call => call.mode)).toEqual(['side']);
  expect(outcome.result).toContain('.pace-plan.md');
  expect(outcome.session.plan).toContain('Legacy plan');
  expect(outcome.stages.map(stage => stage.route)).toEqual([{ model: 'gpt-6-sol', effort: 'high' }]);
});

it('verifies an existing plan in a fresh read-only thread with a stronger route', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'auto', 'planning');
  session.threadId = 'draft-thread';
  session.plan = '# Draft plan\n\nUpdate parser.\n';
  const calls: { prompt: string; route: Route; threadId?: string; mode?: string }[] = [];
  const runner: CodexRunner = { async run(prompt, _project, route, threadId, _progress, _signal, mode) {
    calls.push({ prompt, route, threadId, mode });
    return { result: '# Verified plan\n\nUpdate parser and test it.\n', threadId: 'review-thread', completed: true };
  } };
  const requests: VexRequest[] = [];
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, request.options.at(-1)!.id);
  } };
  const outcome = await new Orchestrator(new PaceStore(dir), runner, vex).turn('Review this plan', session, config, () => {}, undefined, true, 'verify_plan');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.options.map(option => option.id)).toEqual(['0:high']);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ route: { model: 'gpt-6-sol', effort: 'high' }, mode: 'side', threadId: undefined });
  expect(calls[0]?.prompt).toContain('Independently verify the plan');
  expect(session.threadId).toBe('review-thread');
  expect(session.plan).toContain('Verified plan');
  expect(outcome.result).toContain('.pace-plan.md');
});

it('lets Vex choose effort within a manually selected model', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const requests: VexRequest[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) {
    expect(route).toEqual({ model: 'gpt-6-sol', effort: 'high' });
    return { result: 'done', completed: true };
  } };
  const session = newSession('/example/project', 'manual');
  session.manualWorkflow = { shape: 'single', routes: { final: { model: 'gpt-6-sol' } } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    return decision(request, '0:high');
  } };
  await new Orchestrator(new PaceStore(dir), runner, vex).turn('Work', session, config, () => {});
  expect(requests).toHaveLength(1);
  expect(requests[0]?.options.map(option => option.id)).toEqual(['0:medium', '0:high']);
});

it('retries invalid decisions once, then exposes error without model fallback', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  let calls = 0;
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = { choose: async () => { calls++; return { choice: 'invalid' }; } };
  await expect(new Orchestrator(new PaceStore(dir), runner, vex).turn('Work', newSession('/example/project', 'auto'), config, () => {})).rejects.toThrow('Invalid Vex routing decision');
  expect(calls).toBe(2);
});

it('records cancellation during routing and never starts Codex', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const controller = new AbortController();
  let started!: () => void;
  const routingStarted = new Promise<void>(resolve => { started = resolve; });
  const routingReleased = new Promise<void>(() => {});
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const vex = { choose: async (request: VexRequest) => {
    started();
    await routingReleased;
    return decision(request, 'single');
  } };
  const turn = new Orchestrator(store, runner, vex).turn('work', session, config, () => {}, controller.signal);
  await routingStarted;
  controller.abort();
  await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.turns.at(-1)).toMatchObject({ prompt: 'work', failed: true });
  expect((await store.latest('/example/project'))?.turns.at(-1)?.failed).toBe(true);
});

it('saves cancellation while Vex is connecting before routing begins', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const controller = new AbortController();
  let started!: () => void;
  const connecting = new Promise<void>(resolve => { started = resolve; });
  const session = newSession('/example/project', 'auto');
  const store = new PaceStore(dir);
  const runner: CodexRunner = { async run() { throw new Error('Codex must not run'); } };
  const vex = {
    async verify() { started(); await new Promise<void>(() => {}); },
    async choose() { throw new Error('Routing must not start'); },
  };
  const turn = new Orchestrator(store, runner, vex).turn('work', session, config, () => {}, controller.signal);
  await connecting;
  controller.abort();
  await expect(turn).rejects.toMatchObject({ name: 'AbortError' });
  expect((await store.latest('/example/project'))?.turns.at(-1)).toMatchObject({
    prompt: 'work', result: 'Turn cancelled by user', failed: true, cancelled: true,
  });
});

it('runs a saved manual route when Vex is unavailable', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  const routes: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) {
    routes.push(route);
    return { result: 'done', completed: true };
  } };
  const vex = {
    async verify() { throw new Error('Vex offline'); },
    async choose() { throw new Error('Vex offline'); },
  };
  const result = await new Orchestrator(new PaceStore(dir), runner, vex).turn('work', session, config, () => {});
  expect(result.result).toBe('done');
  expect(routes).toEqual([session.route]);
});

it('rejects disabled models and lets manual mode keep its route', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const routes: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { routes.push(route); return { result: 'done', completed: true }; } };
  const session = newSession('/example/project', 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  const orchestrator = new Orchestrator(new PaceStore(dir), runner, { choose: async () => { throw new Error('No Vex routing in manual mode'); } });
  await orchestrator.turn('work', session, config, () => {});
  expect(routes).toEqual([session.route]);
  await expect(orchestrator.turn('work', session, { ...config, models: [{ model: 'gpt-6-luna', efforts: ['low'] }] }, () => {})).rejects.toThrow('no longer enabled');
});

it('exposes SDK activity with stable IDs and the available reasoning summary', () => {
  expect(eventProgress({ type: 'item.started', item: { id: 'x', type: 'command_execution', command: 'test', aggregated_output: '', status: 'in_progress' } })).toMatchObject({ kind: 'activity', id: 'x', completed: false });
  expect(eventProgress({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'Checking files' } })).toMatchObject({ category: 'thinking', detail: 'Checking files' });
  expect(eventProgress({ type: 'item.completed', item: { id: 'failed', type: 'command_execution', command: 'false', aggregated_output: '', status: 'failed', exit_code: 1 } })).toMatchObject({ outcome: 'failure' });
  expect(eventProgress({ type: 'item.completed', item: { id: 'read', type: 'mcp_tool_call', server: 'files', tool: 'read_file', arguments: { path: 'src/a.ts' }, status: 'completed' } })).toMatchObject({ title: 'Read(src/a.ts)', outcome: 'success' });
});

it('uses Codex app-server sandbox values for threads and turns', () => {
  const usage = { input_tokens: 20, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 8, reasoning_output_tokens: 2 };
  expect(appUsage({ last: { inputTokens: 20, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 } })).toEqual(usage);
  expect(appServerThreadParams('/project', { model: 'gpt-6-luna', effort: 'low' }, undefined, 'side')).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
  expect(appServerThreadParams('/project', { model: 'gpt-6-sol', effort: 'high' }, 'thread-1', 'main')).toMatchObject({ threadId: 'thread-1', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  const side = appServerTurnParams('scout', '/project', { model: 'gpt-6-luna', effort: 'low' }, 'thread-1', 'side', ['/trusted']);
  expect(side).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text: 'scout' }] });
  expect(JSON.stringify(side)).not.toContain('/trusted');
  const main = appServerTurnParams('work', '/project', { model: 'gpt-6-sol', effort: 'high' }, 'thread-1', 'main', ['/trusted']);
  expect(main).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project', '/trusted'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  expect(appServerTurnParams('Describe [Pace image: /project/.pace/pasted-images/photo.png]', '/project', {}, 'thread-1', 'main', []).input).toEqual([
    expect.objectContaining({ type: 'text', text: expect.stringContaining('Describe [Pace image: /project/.pace/pasted-images/photo.png]') }),
    { type: 'localImage', path: '/project/.pace/pasted-images/photo.png' },
  ]);
  expect(appServerThreadParams('/project', {}, undefined, 'main', 'full-access')).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  expect(appServerTurnParams('work', '/project', {}, 'thread-1', 'main', [], 'full-access')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  expect(appServerThreadParams('/project', {}, undefined, 'main', 'limited')).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'read-only' });
  expect(appServerTurnParams('work', '/project', {}, 'thread-1', 'main', ['/trusted'], 'limited')).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
  expect(appServerTurnParams('Create an artifact', '/project', {}, 'thread-1', 'main', ['/conversation/artifacts'], 'request-approval', '/conversation/artifacts').input[0]).toMatchObject({ text: expect.stringContaining('/conversation/artifacts') });
  expect(appServerTurnParams('scout', '/project', {}, 'thread-1', 'side', [], 'full-access')).toMatchObject({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
});

it('declines a destructive Codex command before showing an approval prompt', async () => {
  let onMessage!: (message: { method: string; params: unknown }) => void;
  let onRequest!: (message: { id: number; method: string; params: unknown }) => void;
  const decisions: unknown[] = [];
  const progress: Progress[] = [];
  const runner = new AppServerRunner(message => {
    onMessage = message;
    return {
      setRequestHandler(handler) { onRequest = handler; },
      notify() {}, kill() {},
      respond(_id, decision) {
        decisions.push(decision);
        queueMicrotask(() => onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));
      },
      async request(method: string) {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') queueMicrotask(() => onRequest({
          id: 7, method: 'item/commandExecution/requestApproval',
          params: { itemId: 'cmd-1', command: 'rm -rf /' },
        }));
        return {};
      },
    };
  });
  await runner.run('work', process.cwd(), {}, undefined, event => { progress.push(event); });
  expect(decisions).toEqual([{ decision: 'decline' }]);
  expect(progress.some(event => event.kind === 'approval')).toBe(false);
});

it('keeps a Codex turn open until an agent question is answered', async () => {
  let onMessage!: (message: { method: string; params: unknown }) => void;
  let onRequest!: (message: { id: number; method: string; params: unknown }) => void;
  const replies: unknown[] = [];
  let asked!: (question: Extract<Progress, { kind: 'question' }>) => void;
  const questionReady = new Promise<Extract<Progress, { kind: 'question' }>>(resolve => { asked = resolve; });
  const runner = new AppServerRunner(message => {
    onMessage = message;
    return {
      setRequestHandler(handler) { onRequest = handler; },
      notify() {}, kill() {},
      respond(_id, answer) {
        replies.push(answer);
        queueMicrotask(() => onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } }));
      },
      async request(method: string) {
        if (method === 'thread/start') return { thread: { id: 'thread-1' } };
        if (method === 'turn/start') queueMicrotask(() => onRequest({
          id: 8, method: 'item/tool/requestUserInput', params: { questions: [
            { id: 'choice', header: 'Scope', question: 'Which scope?', options: [{ label: 'All', description: 'Every file' }], isOther: true, isSecret: false },
            { id: 'note', header: 'Note', question: 'Any note?', options: null, isOther: false, isSecret: false },
          ] },
        }));
        return {};
      },
    };
  });
  let finished = false;
  const running = runner.run('work', process.cwd(), {}, undefined, event => {
    if (event.kind === 'question') asked(event);
  }).then(value => { finished = true; return value; });
  const request = await questionReady;
  expect(request.questions).toMatchObject([{ id: 'choice', options: [{ label: 'All' }] }, { id: 'note', options: [] }]);
  expect(finished).toBe(false);
  request.respond({ choice: { answers: ['All'] }, note: { answers: ['No'] } });
  await running;
  expect(replies).toEqual([{ answers: { choice: { answers: ['All'] }, note: { answers: ['No'] } } }]);
});

it('enables agent questions during normal Codex turns', () => {
  const args = serverArgs();
  expect(args.slice(args.indexOf('--enable'), args.indexOf('--enable') + 2)).toEqual(['--enable', 'default_mode_request_user_input']);
});

it('dismisses a question when Codex resolves it without an answer', async () => {
  const progress: Progress[] = [];
  const runner = new AppServerRunner((onMessage) => ({
    setRequestHandler(handler) {
      queueMicrotask(() => handler({ id: 10, method: 'item/tool/requestUserInput', params: {
        questions: [{ id: 'scope', question: 'Which scope?', options: null }],
      } }));
    },
    notify() {}, kill() {}, respond() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage({ method: 'serverRequest/resolved', params: { requestId: 10 } });
        onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      });
      return {};
    },
  }));
  await runner.run('work', process.cwd(), {}, undefined, event => { progress.push(event); });
  expect(progress.map(event => event.kind)).toContain('question');
  expect(progress).toContainEqual({ kind: 'questionResolved', id: '10' });
});

it('releases an unanswered agent question when a turn is cancelled', async () => {
  let onRequest!: (message: { id: number; method: string; params: unknown }) => void;
  const replies: unknown[] = [];
  let asked!: () => void;
  const questionReady = new Promise<void>(resolve => { asked = resolve; });
  const controller = new AbortController();
  const runner = new AppServerRunner(() => ({
    setRequestHandler(handler) { onRequest = handler; }, notify() {}, kill() {},
    respond(_id, answer) { replies.push(answer); },
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => onRequest({
        id: 9, method: 'item/tool/requestUserInput', params: { questions: [
          { id: 'note', question: 'Continue?', options: null },
        ] },
      }));
      return {};
    },
  }));
  const running = runner.run('work', process.cwd(), {}, undefined, event => {
    if (event.kind === 'question') asked();
  }, controller.signal);
  await questionReady;
  controller.abort();
  await expect(running).rejects.toThrow();
  expect(replies).toEqual([{ answers: {} }]);
});

it('saves agent questions and redacts secret answers in the conversation', async () => {
  dir = await mkdtemp(join(tmpdir(), 'pace-test-'));
  const session = newSession(process.cwd(), 'manual');
  session.route = { model: 'gpt-6-sol', effort: 'high' };
  const store = new PaceStore(dir);
  const runner: CodexRunner = { async run(_prompt, _project, _route, _threadId, progress) {
    await progress({ kind: 'question', id: 'one', questions: [
      { id: 'scope', header: 'Scope', question: 'Which scope?', options: [], isOther: false, isSecret: false },
      { id: 'token', header: 'Token', question: 'What token?', options: [], isOther: false, isSecret: true },
    ], respond: () => {} });
    return { threadId: 'thread-1', result: 'Done', completed: true };
  } };
  const orchestrator = new Orchestrator(store, runner, { choose: async () => { throw new Error('unexpected routing'); } });
  await orchestrator.turn('Work', session, { ...config, routingMode: 'manual' }, event => {
    if (event.kind === 'question') event.respond({ scope: { answers: ['All'] }, token: { answers: ['secret-value'] } });
  });
  expect((await store.latest(process.cwd()))?.turns.at(-1)?.questions).toEqual([
    { question: 'Which scope?', answer: 'All' },
    { question: 'What token?', answer: '[hidden]' },
  ]);
});

it('ends an active turn when Codex app-server exits', async () => {
  let exit!: (error: Error) => void;
  const server = {
    setRequestHandler() {},
    notify() {},
    respond() {},
    kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => exit(new Error('App Server exited')));
      return {};
    },
  };
  const runner = new AppServerRunner((_message, onExit) => {
    exit = onExit;
    return server;
  });
  await expect(runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {}))
    .rejects.toThrow('App Server exited');
});

it('shows file path and diff as soon as app-server updates the patch', async () => {
  const changes = [{ path: join(process.cwd(), 'src', 'example.ts'), kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }];
  const progress: Progress[] = [];
  const runner = new AppServerRunner((onMessage) => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage({ method: 'item/fileChange/patchUpdated', params: { itemId: 'edit-1', changes } });
        onMessage({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'edit-1', changes, status: 'completed' } } });
        onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      });
      return {};
    },
  }));
  await runner.run('edit', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, event => { progress.push(event); });
  const edits = progress.filter(event => event.kind === 'activity' && event.category === 'files');
  expect(edits).toHaveLength(2);
  expect(edits[0]).toMatchObject({ title: `Edited ${join('src', 'example.ts')}`, detail: '@@ -1 +1 @@\n-old\n+new', completed: false });
  expect(edits[1]).toMatchObject({ title: `Edited ${join('src', 'example.ts')}`, completed: true });
});

it('reads current context from the raw App Server usage event', async () => {
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage({ method: 'thread/tokenUsage/updated', params: {
          threadId: 'thread-1', tokenUsage: {
            total: { totalTokens: 600_000 },
            last: { totalTokens: 130_000, inputTokens: 120_000, cachedInputTokens: 50_000, outputTokens: 10_000 },
            modelContextWindow: 250_000,
          },
        } });
        onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      });
      return {};
    },
  }));
  const execution = await runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {});
  expect(execution.context).toEqual({ tokens: 130_000, windowTokens: 250_000, model: 'gpt-6-sol' });
  expect(execution.usage).toMatchObject({ input_tokens: 120_000, output_tokens: 10_000 });
});

it('sums distinct model requests without counting resumed history or duplicate usage events', async () => {
  const usageEvent = (totalTokens: number, inputTokens: number, outputTokens: number) => ({
    method: 'thread/tokenUsage/updated', params: { tokenUsage: {
      total: { totalTokens }, last: { totalTokens: inputTokens + outputTokens, inputTokens, outputTokens },
      modelContextWindow: 1000,
    } },
  });
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      if (method === 'thread/resume') {
        onMessage(usageEvent(1000, 700, 100));
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage(usageEvent(1000, 700, 100));
        onMessage(usageEvent(1100, 80, 20));
        onMessage(usageEvent(1100, 80, 20));
        onMessage(usageEvent(1200, 90, 10));
        onMessage({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
      });
      return {};
    },
  }));
  const progress: Progress[] = [];
  const execution = await runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, 'thread-1', event => { progress.push(event); });
  expect(execution.usage).toMatchObject({ input_tokens: 170, output_tokens: 30 });
  expect(execution.context).toEqual({ tokens: 100, windowTokens: 1000, model: 'gpt-6-sol' });
  expect(progress.filter(event => event.kind === 'usage').map(event => event.usage)).toMatchObject([
    { input_tokens: 80, output_tokens: 20 },
    { input_tokens: 170, output_tokens: 30 },
  ]);
});

it('retains observed usage when a turn fails after model work', async () => {
  const runner = new AppServerRunner(onMessage => ({
    setRequestHandler() {}, notify() {}, respond() {}, kill() {},
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') queueMicrotask(() => {
        onMessage({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
          total: { totalTokens: 120 }, last: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
          modelContextWindow: 1000,
        } } });
        onMessage({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'limit' } } } });
      });
      return {};
    },
  }));
  await expect(runner.run('work', process.cwd(), { model: 'gpt-6-sol' }, undefined, () => {}))
    .rejects.toMatchObject({ message: 'limit', usage: { input_tokens: 100, output_tokens: 20 } });
});

it('gives Codex independent Vex MCP access without key in command arguments', () => {
  expect(codexOptions('/installed/vex/dist/index.js')).toMatchObject({ config: { mcp_servers: { vex: {
    command: process.execPath,
    args: ['/installed/vex/dist/index.js', 'mcp', 'serve'],
    env_vars: expect.arrayContaining(['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'JEV_API_KEY']),
  } } } });
});

it('delivers every streamed SDK event to benchmark observer', async () => {
  const seen: string[] = [];
  const runner = new SdkRunner({}, async event => { seen.push(event.type); });
  const thread = { id: 'thread-1', async runStreamed() { return { events: (async function* () {
    yield { type: 'item.completed', item: { type: 'agent_message', id: 'message-1', text: 'done' } };
    yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
  })() }; } };
  (runner as unknown as { codex: { startThread: () => typeof thread } }).codex = { startThread: () => thread };
  await runner.run('work', process.cwd(), { model: 'gpt-6-sol', effort: 'high' }, undefined, () => {});
  expect(seen).toEqual(['item.completed', 'turn.completed']);
});
