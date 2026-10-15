import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { McpManager } from '../src/components/McpManager.js';
import type { McpServerConfig } from '../src/integrations/codex-cli.js';

class Output extends Writable {
  isTTY = true;
  columns = 100;
  rows = 35;
  writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.writes.push(chunk.toString()); done(); }
}
const instances: ReturnType<typeof render>[] = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.unmount(); });

async function manager(servers: McpServerConfig[] = []) {
  const list = vi.fn(async () => servers);
  const run = vi.fn<NonNullable<React.ComponentProps<typeof McpManager>['service']>['run']>(async () => 'Saved');
  const onClose = vi.fn();
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  const stdout = new Output();
  const instance = render(<McpManager project="/project" width={100} height={34} onClose={onClose} service={{ list, run }} />, {
    stdin, stdout, stderr: new PassThrough(), patchConsole: false, alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 10)); await instance.waitUntilRenderFlush(); };
  await settle();
  return {
    run, list, onClose, instance,
    frame: () => stdout.writes.join(''),
    async send(input: string) {
      stdout.writes.length = 0; stdin.write(input);
      // Ink waits briefly to distinguish Escape from a terminal escape sequence.
      if (input === '\x1b') await new Promise(resolve => setTimeout(resolve, 60));
      await settle();
    },
    async field(input: string) { stdin.write(input); await settle(); stdout.writes.length = 0; stdin.write('\r'); await settle(); },
  };
}

it('adds a stdio server through fields, preserving literal arguments and keeping environment values out of review', async () => {
  const ui = await manager();
  expect(ui.frame()).toContain('No external MCP servers configured');
  await ui.send('\r'); // Add server
  await ui.field('local-server');
  await ui.send('\r'); // stdio
  await ui.field('/path with spaces/node');
  await ui.field('one argument with spaces; $(never-run)');
  await ui.send('\r'); // No more arguments
  await ui.field('TEST_TOKEN=private-value');
  await ui.send('\r'); // No more environment variables
  expect(ui.frame()).toContain('Save local-server');
  expect(ui.frame()).toContain('TEST_TOKEN');
  expect(ui.frame()).not.toContain('private-value');
  expect(ui.run).not.toHaveBeenCalled();
  await ui.send('\r');
  expect(ui.run).toHaveBeenCalledWith([
    'add', 'local-server', '--env', 'TEST_TOKEN=private-value', '--', '/path with spaces/node', 'one argument with spaces; $(never-run)',
  ], '/project', expect.objectContaining({ signal: expect.any(AbortSignal), onOutput: expect.any(Function) }));
  expect(ui.frame()).toContain('Server changes apply to the next turn');
  expect(ui.list).toHaveBeenCalledTimes(2);
});

it('adds an HTTP server and validates the bearer environment variable before review', async () => {
  const ui = await manager();
  await ui.send('\r'); await ui.field('remote-server');
  await ui.send('\x1b[B'); await ui.send('\r'); // HTTP
  await ui.field('https://example.com/mcp');
  await ui.field('MCP_TOKEN');
  expect(ui.frame()).toContain('Token from environment: MCP_TOKEN');
  await ui.send('\r');
  expect(ui.run.mock.calls[0]?.[0]).toEqual(['add', 'remote-server', '--url', 'https://example.com/mcp', '--bearer-token-env-var', 'MCP_TOKEN']);
});

it('rejects duplicate names and allows cancelling setup without changing configuration', async () => {
  const ui = await manager([{ name: 'existing', enabled: true, transport: { type: 'stdio', command: 'node' } }]);
  await ui.send('\x1b[B'); await ui.send('\r');
  await ui.field('existing');
  expect(ui.frame()).toContain('That server already exists');
  await ui.send('\x1b');
  expect(ui.run).not.toHaveBeenCalled();
  expect(ui.onClose).not.toHaveBeenCalled();
  await ui.send('\x1b');
  expect(ui.onClose).toHaveBeenCalledOnce();
});

it('requires an explicit removal choice and refreshes the list afterwards', async () => {
  const ui = await manager([{ name: 'existing', enabled: true, transport: { type: 'stdio', command: 'node' } }]);
  await ui.send('\r'); await ui.send('\r'); // Server actions, remove
  expect(ui.frame()).toContain('Remove existing from your shared Codex configuration?');
  await ui.send('\r'); // Default: keep
  expect(ui.run).not.toHaveBeenCalled();
  await ui.send('\r'); await ui.send('\x1b[B'); await ui.send('\r');
  expect(ui.run.mock.calls[0]?.[0]).toEqual(['remove', 'existing']);
  expect(ui.list).toHaveBeenCalledTimes(2);
});

it('streams OAuth output, cancels pending login with Escape, and refreshes partial changes', async () => {
  const ui = await manager([{ name: 'remote', enabled: true, transport: { type: 'streamable_http', url: 'https://example.com/mcp' } }]);
  ui.run.mockImplementation(async (_args, _project, options) => {
    options?.onOutput?.('Authenticate: https://example.com/oauth\n');
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return '';
  });
  await ui.send('\r'); await ui.send('\r');
  expect(ui.run.mock.calls[0]?.[0]).toEqual(['login', 'remote']);
  expect(ui.frame()).toContain('https://example.com/oauth');
  await ui.send('\x1b');
  expect(ui.run.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  expect(ui.frame()).toContain('MCP operation cancelled');
  expect(ui.list).toHaveBeenCalledTimes(2);
  expect(ui.onClose).not.toHaveBeenCalled();
});

it('refreshes saved configuration after a native command fails and aborts pending work on unmount', async () => {
  const ui = await manager([{ name: 'remote', enabled: true, transport: { type: 'streamable_http', url: 'https://example.com/mcp' } }]);
  ui.run.mockRejectedValueOnce(new Error('OAuth provider unavailable'));
  await ui.send('\r'); await ui.send('\x1b[B'); await ui.send('\r'); // Logout
  expect(ui.run.mock.calls[0]?.[0]).toEqual(['logout', 'remote']);
  expect(ui.frame()).toContain('OAuth provider unavailable');
  expect(ui.list).toHaveBeenCalledTimes(2);
  ui.run.mockImplementation(async (_args, _project, options) => {
    await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    return '';
  });
  await ui.send('\r'); await ui.send('\r');
  ui.instance.unmount();
  expect(ui.run.mock.calls.at(-1)?.[2]?.signal?.aborted).toBe(true);
});
