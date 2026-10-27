import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { AppServerRunner, type CodexRunner, type Progress } from '../transports.js';
import { assertDebug, atomicJson, hash } from '../storage.js';
import { beginTrial, finishTrial, checkControl } from '../control.js';
import { handoffPrompt, structuredHandoff } from '../../core/orchestrator-helpers.js';
import { DEFAULT_ROUTING_PROMPTS, type RoutingPrompts } from '../../core/routing/routing-prompts.js';
import { prepareTurnPrompt } from '../../core/orchestrator-prompts.js';
import { costForUsage } from '../../core/routing/pricing.js';
import { newSession } from '../../core/session-model.js';
import type { Route, TurnSummary } from '../../shared/types.js';
import { EFFORTS, isRecord } from '../../shared/config.js';

const exec = promisify(execFile);
export type FreshCase = { id: string; prompt: string; history: string; files: Record<string, string>; verification: string; rubric: string };
export type FreshSuite = { version: 1; scout: Route; completion: Route; cases: FreshCase[] };
export function parseFreshSuite(value: unknown): FreshSuite {
  const route = (r: unknown) => isRecord(r) && typeof r.model === 'string' && EFFORTS.includes(r.effort as typeof EFFORTS[number]);
  if (!isRecord(value) || value.version !== 1 || !route(value.scout) || !route(value.completion) || !Array.isArray(value.cases) || value.cases.length < 2) throw new Error('Invalid matched completion suite');
  const ids = new Set<string>();
  for (const task of value.cases) {
    if (!isRecord(task) || typeof task.id !== 'string' || !/^[a-z\d-]+$/.test(task.id) || ids.has(task.id) ||
      !['prompt', 'history', 'verification', 'rubric'].every(key => typeof task[key] === 'string' && task[key].trim()) ||
      !isRecord(task.files) || !Object.keys(task.files).length || Object.entries(task.files).some(([path, content]) => isAbsolute(path) || /(^|[\/\\])(?:\.\.|\.git)(?:[\/\\]|$)/.test(path) || path.includes('\\') || typeof content !== 'string')) throw new Error('Invalid matched completion task');
    ids.add(task.id);
  }
  return value as unknown as FreshSuite;
}

export async function runFreshCompletion({ suite, repeats, out, signal, runner = new AppServerRunner(undefined, undefined, false), prompts = DEFAULT_ROUTING_PROMPTS }: {
  suite: FreshSuite; repeats: number; out: string; signal?: AbortSignal; runner?: CodexRunner; prompts?: RoutingPrompts;
}): Promise<void> {
  assertDebug();
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('Repetitions must be 1–10');
  await mkdir(out, { recursive: true });
  await atomicJson(join(out, 'manifest.json'), { version: 1, benchmark: 'fresh-completion', suiteSha256: hash(JSON.stringify(suite)), repeats, scout: suite.scout, completion: suite.completion, policy: 'Experimental; production thread policy unchanged' });
  for (const task of suite.cases) for (let repetition = 1; repetition <= repeats; repetition++) {
    signal?.throwIfAborted(); checkControl();
    const key = `${task.id}/${repetition}`;
    if (!beginTrial(key)) continue;
    const directory = join(out, task.id, String(repetition));
    await mkdir(directory, { recursive: true });
    const root = await mkdtemp(join(tmpdir(), 'pace-fresh-completion-'));
    const workspace = join(root, 'workspace');
    const records: Record<string, unknown>[] = [];
    const pair: Record<string, unknown> = { version: 1, pairId: randomUUID(), id: task.id, repetition, request: task.prompt, rubric: task.rubric, calls: records, verification: task.verification, verificationSha256: hash(task.verification), fixtureSha256: hash(JSON.stringify(task.files)) };
    const save = () => atomicJson(join(directory, 'pair.json'), pair);
    const git = async (...args: string[]) => (await exec('git', args, { cwd: workspace, env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }, maxBuffer: 4_000_000 })).stdout.trim();
    const run = async (stage: string, prompt: string, route: Route, thread: string | undefined, mode: 'side' | 'main') => {
      const record: Record<string, unknown> = { stage, prompt, promptSha256: hash(prompt), route, requestedThreadId: thread ?? null, mode, startedAt: new Date().toISOString() };
      records.push(record); await save();
      const start = performance.now();
      try {
        const result = await runner.run(prompt, workspace, route, thread, (event: Progress) => {
          if (event.kind === 'prompt') { record.input = event.input; record.threadId = event.threadId; }
          if (event.kind === 'thread') record.threadId = event.text;
          if (event.kind === 'approval') event.respond('decline');
          if (event.kind === 'question') event.respond({});
        }, signal, mode, [], stage === 'history' ? 'limited' : 'request-approval');
        Object.assign(record, result, { estimatedCostUsd: costForUsage(route, result.usage) });
        if (!result.completed || !result.threadId || (thread && result.threadId !== thread) || (!thread && typeof pair.historyThreadId === 'string' && result.threadId === pair.historyThreadId) || (result.route && (result.route.model !== route.model || result.route.effort !== route.effort))) throw new Error('Completion/thread/route identity mismatch');
        return result;
      } catch (error) {
        const failure = error as { usage?: unknown; accounting?: unknown };
        Object.assign(record, { error: String(error), usage: failure.usage ?? record.usage, accounting: failure.accounting });
        throw error;
      } finally { record.durationMs = Math.round(performance.now() - start); await save(); }
    };
    let failed = false;
    try {
      await mkdir(workspace);
      for (const [path, content] of Object.entries(task.files)) { await mkdir(dirname(join(workspace, path)), { recursive: true }); await writeFile(join(workspace, path), content); }
      await git('init', '-q'); await git('add', '.'); await git('-c', 'user.name=Pace benchmark', '-c', 'user.email=benchmark@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Frozen fixture');
      const commit = await git('rev-parse', 'HEAD'); pair.commit = commit;
      const history = await run('history', task.history, suite.completion, undefined, 'main');
      pair.historyThreadId = history.threadId;
      if (await git('status', '--porcelain')) throw new Error('Read-only history changed the fixture');
      const turns: TurnSummary[] = [{ prompt: task.history, result: history.result, at: 'setup' }];
      const scout = await run('scout', handoffPrompt(task.prompt, turns, prompts), suite.scout, undefined, 'side');
      const handoff = structuredHandoff(scout.result);
      if (await git('status', '--porcelain')) throw new Error('Read-only scout changed the fixture');
      pair.handoff = handoff; pair.handoffSha256 = hash(handoff); pair.handoffBytes = Buffer.byteLength(handoff);
      await writeFile(join(directory, 'scout.json'), handoff + '\n');
      const prompt = prepareTurnPrompt({ prompt: task.prompt, session: newSession(workspace, 'manual'), taskRelation: 'replace', priorTask: undefined, usedThreadForClarification: false, prompts, skills: [], handoff }).promptWithHandoff;
      const arms = repetition % 2 ? ['same-thread', 'fresh-thread'] : ['fresh-thread', 'same-thread'];
      for (const arm of arms) {
        signal?.throwIfAborted();
        await git('reset', '--hard', commit); await git('clean', '-fdx');
        const runDir = join(directory, arm); await mkdir(runDir);
        const armRecord: Record<string, unknown> = { version: 1, benchmark: 'fresh-completion', pairId: pair.pairId, id: task.id, repetition, arm, commit, fixtureSha256: pair.fixtureSha256, promptSha256: hash(prompt), handoffSha256: hash(handoff), handoffBytes: pair.handoffBytes, verificationSha256: pair.verificationSha256, historyThreadId: history.threadId, route: suite.completion, rubric: task.rubric };
        try {
          const result = await run(arm, prompt, suite.completion, arm === 'same-thread' ? history.threadId : undefined, 'main');
          Object.assign(armRecord, result, { estimatedCostUsd: costForUsage(suite.completion, result.usage) });
        } catch (error) { armRecord.error = String(error); failed = true; }
        const invocation = records.at(-1)!;
        Object.assign(armRecord, { prompt, input: invocation.input, durationMs: invocation.durationMs, usage: invocation.usage, threadId: invocation.threadId });
        const checks = [];
        for (const args of [['test.mjs'], ['--input-type=module', '-e', task.verification]]) {
          try { const result = await exec(process.execPath, args, { cwd: workspace, timeout: 20_000, maxBuffer: 1_000_000 }); checks.push({ command: args[0] === 'test.mjs' ? 'node test.mjs' : 'external verification', exitCode: 0, output: result.stdout + result.stderr }); }
          catch (error) { const failure = error as { stdout?: string; stderr?: string }; checks.push({ command: 'verification', exitCode: 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${String(error)}` }); }
        }
        armRecord.checks = checks; armRecord.checksPassed = checks.every(check => check.exitCode === 0);
        await git('add', '-N', '.');
        await writeFile(join(runDir, 'diff.patch'), await git('diff', '--binary', 'HEAD'));
        armRecord.finalFiles = Object.fromEntries(await Promise.all(Object.keys(task.files).map(async path => [path, await readFile(join(workspace, path), 'utf8').catch(() => '[missing]')])));
        await atomicJson(join(runDir, 'run.json'), armRecord);
      }
    } catch (error) { pair.error = String(error); failed = true; }
    finally { await save(); await rm(root, { recursive: true, force: true }); finishTrial(failed); }
    signal?.throwIfAborted();
  }
}
