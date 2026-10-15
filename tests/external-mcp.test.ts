import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { AppServer, isRecord } from '../src/integrations/app-server-process.js';
import { executeMcpCommand, listMcpServers, readMcpServers } from '../src/integrations/codex-cli.js';

const execute = promisify(execFile);
let directory: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'pace-external-mcp-'));
  vi.stubEnv('CODEX_HOME', directory);
  return async (...args: string[]) => execute(process.execPath, [resolve('dist/entrypoints/cli.js'), 'mcp', ...args], {
    env: process.env,
    timeout: 20_000,
  });
}

it('forwards native MCP help, validation errors, and exit codes before loading the terminal UI', async () => {
  const pace = await fixture();
  expect((await pace('--help')).stdout).toContain('Manage external MCP servers');
  expect((await pace('add', '--help')).stdout).toContain('--bearer-token-env-var');
  await expect(pace('not-a-command')).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('unrecognized subcommand') });
  await expect(pace('get', 'missing')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('missing') });
});

it('manages stdio and HTTP servers in native Codex config, preserving literal arguments and other settings', async () => {
  const pace = await fixture();
  await writeFile(join(directory, 'config.toml'), 'model = "existing-model"\n');
  const literal = 'space and "quotes" $(echo never-run); $HOME';
  await pace('add', 'local-test', '--env', 'PACE_MCP_TEST_VALUE=test-value', '--', process.execPath, resolve('tests/fixtures/external-mcp.mjs'), literal);
  const local = JSON.parse((await pace('get', 'local-test', '--json')).stdout);
  expect(local).toMatchObject({ name: 'local-test', transport: { type: 'stdio', command: process.execPath,
    args: [resolve('tests/fixtures/external-mcp.mjs'), literal], env: { PACE_MCP_TEST_VALUE: 'test-value' } } });
  await pace('add', 'http-test', '--url', 'http://127.0.0.1:9/mcp', '--bearer-token-env-var', 'PACE_MCP_TEST_TOKEN');
  expect(JSON.parse((await pace('get', 'http-test', '--json')).stdout)).toMatchObject({
    transport: { type: 'streamable_http', url: 'http://127.0.0.1:9/mcp', bearer_token_env_var: 'PACE_MCP_TEST_TOKEN' },
  });
  const list = JSON.parse((await pace('list', '--json')).stdout);
  expect(list.map((server: { name: string }) => server.name).sort()).toEqual(['http-test', 'local-test']);
  expect((await pace()).stdout).toContain('local-test');
  expect(await listMcpServers(process.cwd())).toContain('http-test');
  const interactiveList = await readMcpServers(process.cwd());
  expect(interactiveList).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'local-test', enabled: true })]));
  expect(JSON.stringify(interactiveList)).not.toContain('test-value');
  const output: string[] = [];
  await executeMcpCommand(['remove', 'local-test'], process.cwd(), { onOutput: text => output.push(text) });
  expect(output.join('')).toContain('local-test');
  await pace('remove', 'http-test');
  expect(JSON.parse((await pace('list', '--json')).stdout)).toEqual([]);
  expect(await readFile(join(directory, 'config.toml'), 'utf8')).toContain('model = "existing-model"');
  await writeFile(join(directory, 'config.toml'), 'invalid = [');
  await expect(listMcpServers(process.cwd())).rejects.toThrow('TOML parse error');
}, 30_000);

it('cancels a real native OAuth operation without giving it ownership of terminal input', async () => {
  await fixture();
  const controller = new AbortController();
  let contacted!: () => void;
  const contact = new Promise<void>(resolve => { contacted = resolve; });
  const provider = createServer(() => { contacted(); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Missing local provider port');
  await writeFile(join(directory, 'config.toml'), `[mcp_servers.pending]\nurl = "http://127.0.0.1:${address.port}/mcp"\n`);
  const work = executeMcpCommand(['login', 'pending'], process.cwd(), { signal: controller.signal });
  const result = expect(work).rejects.toThrow('MCP operation cancelled');
  try {
    await Promise.race([contact, work]);
    controller.abort();
    await result;
  } finally {
    controller.abort();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 15_000);

it('discovers an external server through Pace’s real Codex App Server connection', async () => {
  const pace = await fixture();
  await writeFile(join(directory, 'config.toml'), `[mcp_servers.vex]\nenabled = false\ncommand = ${JSON.stringify(process.execPath)}\n`);
  await pace('add', 'local-test', '--env', 'PACE_MCP_TEST_VALUE=test-value', '--', process.execPath, resolve('tests/fixtures/external-mcp.mjs'));
  const server = new AppServer(() => {}, () => {});
  try {
    await server.request('initialize', { clientInfo: { name: 'pace-test', version: '1.0.0' } });
    server.notify('initialized', {});
    const status = await server.request('mcpServerStatus/list', {});
    expect(status).toMatchObject({ data: expect.arrayContaining([expect.objectContaining({ name: 'local-test', tools: expect.any(Object) })]) });
    const external = isRecord(status) && Array.isArray(status.data) ? status.data.find(item => item.name === 'local-test') : undefined;
    expect(JSON.stringify(external?.tools)).toContain('pace_echo');
  } finally {
    server.kill();
  }
}, 30_000);
