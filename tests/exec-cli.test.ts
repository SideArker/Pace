import { afterEach, expect, it, vi } from 'vitest';
import { execTurn } from '../src/core/exec.js';
import { PaceStore } from '../src/core/sessions.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { VexRouter } from '../src/core/vex/client.js';
import { DEFAULT_CONFIG } from '../src/shared/config.js';

afterEach(() => vi.restoreAllMocks());

function stubServices() {
  vi.spyOn(PaceStore.prototype, 'loadConfig').mockResolvedValue(structuredClone(DEFAULT_CONFIG));
  vi.spyOn(PaceStore.prototype, 'latest').mockResolvedValue(undefined);
  vi.spyOn(VexRouter.prototype, 'close').mockResolvedValue(undefined);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { stdout, stderr };
}

it('returns usage status for an empty script prompt', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await execTurn('  ')).toBe(2);
  expect(stderr).toHaveBeenCalledWith('Usage: pace exec "prompt"');
});

it('prints only the final answer and removes its SIGINT handler', async () => {
  const { stdout, stderr } = stubServices();
  const before = process.listenerCount('SIGINT');
  vi.spyOn(Orchestrator.prototype, 'turn').mockResolvedValue({ result: 'final answer' } as never);
  expect(await execTurn('work')).toBe(0);
  expect(stdout).toHaveBeenCalledExactlyOnceWith('final answer');
  expect(stderr).not.toHaveBeenCalled();
  expect(process.listenerCount('SIGINT')).toBe(before);
});

it('declines noninteractive approval and reports execution failure on stderr', async () => {
  const { stdout, stderr } = stubServices();
  let decision: string | undefined;
  vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, _session, _config, progress) => {
    progress({ kind: 'approval', command: 'git push', respond: value => { decision = value; } });
    throw new Error('approval declined');
  });
  expect(await execTurn('publish')).toBe(1);
  expect(decision).toBe('decline');
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith('Denied command approval in non-interactive mode: git push');
  expect(stderr).toHaveBeenCalledWith('Error: approval declined');
});

it('returns cancellation status after SIGINT and removes its signal handler', async () => {
  const { stdout, stderr } = stubServices();
  const before = process.listenerCount('SIGINT');
  vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, _session, _config, _progress, signal) => {
    process.emit('SIGINT');
    signal?.throwIfAborted();
    throw new Error('expected cancellation');
  });
  expect(await execTurn('work')).toBe(130);
  expect(stderr).toHaveBeenCalledWith('Turn cancelled by user');
  expect(stdout).not.toHaveBeenCalled();
  expect(process.listenerCount('SIGINT')).toBe(before);
});
