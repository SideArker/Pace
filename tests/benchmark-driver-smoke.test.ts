import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../src/benchmark/preflight.js';
import { worker } from '../src/benchmark/worker.js';
import { configureControl } from '../src/benchmark/control.js';
import { readEvents, account } from '../src/benchmark/service.js';
import { AppServerRunner } from '../src/integrations/app-server-runner.js';
import { parseFreshSuite } from '../src/benchmark/drivers/fresh-completion.js';
import { inventory } from '../src/benchmark/storage.js';
import type { RunManifest } from '../src/benchmark/types.js';
import type { CodexRunner } from '../src/integrations/codex-types.js';

const roots: string[] = [];
afterEach(async () => { configureControl(undefined); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 };
const report = JSON.stringify({ summary: 'Inspected module and tests', findings: [{ path: 'test.mjs', line: 1, finding: 'Only happy path tested', relevance: 'Add regression coverage' }], coverage: ['module and tests'], gaps: [], nextSteps: ['Fix and test'], checks: ['Not run: node test.mjs'], risks: [] });

it('runs matched stages through the shared worker preserving prompts, threads, fixture resets and accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pace-fresh-smoke-')); roots.push(root);
  const calls: Parameters<CodexRunner['run']>[] = []; let nextThread = 0;
  vi.spyOn(AppServerRunner.prototype, 'run').mockImplementation(async (...args) => {
    calls.push(args);
    const [prompt, cwd, route, thread, progress] = args, threadId = thread ?? `thread-${++nextThread}`;
    await progress({ kind: 'prompt', threadId, input: [{ type: 'text', text: prompt }] });
    if (prompt.includes('Full validated handoff follows:')) {
      const module = prompt.includes('parseRows') ? 'csv.mjs' : prompt.includes('runQueue') ? 'queue.mjs' : 'report.mjs';
      expect(await readFile(join(cwd, module), 'utf8')).not.toContain('fake completion');
      const fixed = module === 'csv.mjs' ? "export function parseRows(text,d=','){return text.split('\\n').filter(Boolean).map(x=>x.split(d));}"
        : module === 'queue.mjs' ? "export async function runQueue(tasks,retries=0){const r=[];for(const t of tasks)for(let a=0;;a++){try{r.push(await t());break}catch(e){if(a>=retries)throw e}}return r}"
        : "export function summarize(records){const r={};for(const x of records){if(!x||typeof x.category!=='string'||typeof x.amount!=='number'||!Number.isFinite(x.amount)||x.amount<0)continue;Object.defineProperty(r,x.category,{value:(Object.hasOwn(r,x.category)?r[x.category]:0)+x.amount,writable:true,enumerable:true,configurable:true})}return r}";
      await writeFile(join(cwd, module), fixed + '\n// fake completion\n');
    }
    return { completed: true, threadId, route, usage, usageComplete: true, result: args[6] === 'side' ? report : 'Completed and checked' };
  });
  const preview = await preflight({ category: 'fresh-completion', profile: 'quick' }), out = join(root, 'segment-1');
  await worker({ manifest: { id: 'test', preview } as RunManifest, out, events: join(root, 'events.jsonl'), completed: [], calls: 0, knownUsd: 0 });
  const runs = await Promise.all((await inventory(out)).filter(path => path.endsWith('/run.json')).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  expect(runs).toHaveLength(6);
  for (const task of ['csv-copy', 'retry-queue', 'report-boundary']) {
    const same = runs.find(r => r.id === task && r.arm === 'same-thread'), fresh = runs.find(r => r.id === task && r.arm === 'fresh-thread');
    for (const field of ['prompt', 'input', 'handoffSha256', 'commit', 'verificationSha256']) expect(same[field]).toEqual(fresh[field]);
    expect(same.threadId).toBe(same.historyThreadId); expect(fresh.threadId).not.toBe(same.historyThreadId);
    expect(same.checksPassed).toBe(true); expect(fresh.checksPassed).toBe(true);
  }
  expect(calls).toHaveLength(12);
  expect(account(await readEvents(root)).codex.attempts).toBe(12);
  expect(account(await readEvents(root)).vex.attempts).toBe(0);
}, 20_000);

it('enforces configured limits before inference and records failed shared setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pace-fresh-limits-')); roots.push(root);
  const preview = await preflight({ category: 'fresh-completion', profile: 'quick', maxTurns: 1, maxUsd: 0.01 });
  const run = vi.spyOn(AppServerRunner.prototype, 'run').mockRejectedValue(new Error('intentional transport failure'));
  await expect(worker({ manifest: { id: 'test', preview } as RunManifest, out: join(root, 'segment-1'), events: join(root, 'events.jsonl'), completed: [], calls: 0, knownUsd: 0 })).rejects.toThrow('call limit');
  expect(run).toHaveBeenCalledTimes(1);
  const pair = JSON.parse(await readFile(join(root, 'segment-1/csv-copy/1/pair.json'), 'utf8'));
  expect(pair.error).toContain('intentional transport failure'); expect(pair.calls[0].error).toContain('intentional transport failure');
  expect(account(await readEvents(root)).codex.failures).toBe(1);
});

it('rejects unsafe fixture paths and invalid suite shapes', () => {
  expect(() => parseFreshSuite({ version: 1, cases: [] })).toThrow();
  expect(() => parseFreshSuite({ version: 1, scout: { model: 'm', effort: 'low' }, completion: { model: 'm', effort: 'low' }, cases: [{ id: 'x', prompt: 'x', history: 'x', verification: 'x', rubric: 'x', files: { '../outside': 'bad' } }, { id: 'y' }] })).toThrow();
});
