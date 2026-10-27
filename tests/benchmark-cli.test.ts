import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { benchmarkCommand, benchmarkCommandService, parseBenchmarkArgs } from '../src/entrypoints/benchmark-cli.js';
import { getProfile } from '../src/benchmark/catalog.js';
import type { Preview } from '../src/benchmark/types.js';

const preview: Preview = {
  selection: { category: 'fresh-completion', profile: 'quick' },
  profile: getProfile('fresh-completion', 'quick'),
  plan: [{ key: 'persistence', description: 'Synthetic sessions' }],
  maximumModelTurns: 0, estimate: 'No inference', resolvedCommits: {}, dependencies: ['GC'],
};
const originalExitCode = process.exitCode;
const ttyDescriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  });
  vi.restoreAllMocks();
});
function services() {
  return {
    preflight: vi.fn().mockResolvedValue(preview),
    startRun: vi.fn().mockResolvedValue({ id: 'run', state: { execution: 'completed' } }),
    resumeRun: vi.fn().mockResolvedValue({ id: 'run', state: { execution: 'completed' } }),
    previewResume: vi.fn().mockResolvedValue({ preview }),
    listResults: vi.fn().mockResolvedValue([]),
    resultSummary: vi.fn().mockResolvedValue({ version: 1 }),
    resultFiles: vi.fn().mockResolvedValue(['answer.md']),
    readResultFile: vi.fn().mockResolvedValue('answer'),
    analyzeResult: vi.fn().mockResolvedValue('derived report'),
  } satisfies Record<keyof typeof benchmarkCommandService, unknown>;
}
function run(args: string[], service = services()) {
  return benchmarkCommand(args, service as unknown as typeof benchmarkCommandService);
}

it.each([
  ['--profile'], ['--profile', 'quick', '--profile', 'standard'],
  ['--preview', '--preview'], ['--max-turns', '--preview'], ['--unknown'],
])('rejects missing, duplicate, and unknown flags: %j', args => {
  expect(() => parseBenchmarkArgs(args)).toThrow();
});

it.each([
  [], ['run', 'fresh-completion'], ['run', 'fresh-completion', '--profile', 'quick', 'extra'],
  ['list', '--preview'], ['results', '--file', 'answer.md'],
  ['resume', 'run', '--max-turns', '2'], ['analyze', 'run', '--preview'], ['unknown', 'run'],
])('rejects incomplete or inapplicable commands before calling services: %j', async args => {
  const service = services();
  await expect(run(args, service)).rejects.toThrow();
  for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
});

it('previews a headless run without starting and forwards numeric limits on explicit execution', async () => {
  const service = services();
  const args = ['run', 'fresh-completion', '--profile', 'quick', '--max-turns', '7', '--max-usd', '0.25'];
  await run([...args, '--preview'], service);
  expect(service.preflight).toHaveBeenCalledWith(expect.objectContaining({ category: 'fresh-completion', profile: 'quick', maxTurns: 7, maxUsd: 0.25 }));
  expect(service.startRun).not.toHaveBeenCalled();
  await run(args, service);
  expect(service.startRun).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 7, maxUsd: 0.25 }), expect.objectContaining({ preview, signal: expect.any(AbortSignal) }));
});

it('keeps help, listing, results, and resume preview free of execution', async () => {
  const service = services();
  for (const args of [['--help'], ['list'], ['results'], ['results', 'run'], ['results', 'run', '--files'], ['results', 'run', '--file', 'answer.md'], ['resume', 'run', '--preview']]) await run(args, service);
  expect(service.listResults).toHaveBeenCalledOnce();
  expect(service.resultSummary).toHaveBeenCalledWith('run');
  expect(service.resultFiles).toHaveBeenCalledWith('run');
  expect(service.readResultFile).toHaveBeenCalledWith('run', 'answer.md');
  expect(service.previewResume).toHaveBeenCalledWith('run');
  expect(service.startRun).not.toHaveBeenCalled();
  expect(service.resumeRun).not.toHaveBeenCalled();
  expect(service.preflight).not.toHaveBeenCalled();
});

it.each(['analyze', 'summarize', 'reaccount'])('dispatches %s without starting a model run', async action => {
  const service = services();
  await run([action, 'run'], service);
  expect(service.analyzeResult).toHaveBeenCalledWith('run', action);
  expect(service.startRun).not.toHaveBeenCalled();
  expect(service.resumeRun).not.toHaveBeenCalled();
});

it.each(['failed', 'cancelled', 'interrupted'])('sets a failing exit code for %s execution', async execution => {
  const service = services();
  service.startRun.mockResolvedValue({ id: 'run', state: { execution } });
  await run(['run', 'fresh-completion', '--profile', 'quick'], service);
  expect(process.exitCode).toBe(1);
});

it('scopes signal handlers to execution and removes them on success and failure', async () => {
  const service = services();
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.listeners(signal));
  service.resumeRun.mockImplementation(async (_id, options) => {
    process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    return { id: 'run', state: { execution: 'cancelled' } };
  });
  await run(['resume', 'run'], service);
  expect(['SIGINT', 'SIGTERM'].map(signal => process.listeners(signal))).toEqual(before);
  service.startRun.mockRejectedValue(new Error('worker failed'));
  await expect(run(['run', 'fresh-completion', '--profile', 'quick'], service)).rejects.toThrow('worker failed');
  expect(['SIGINT', 'SIGTERM'].map(signal => process.listeners(signal))).toEqual(before);
});
