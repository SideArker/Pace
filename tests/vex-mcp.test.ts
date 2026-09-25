import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VexRouter } from '../src/integrations/vex.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import type { Config, Route } from '../src/types.js';
import type { CodexRunner } from '../src/integrations/codex.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

it('uses one persistent MCP connection and selects a validated route before Codex', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pace-vex-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'mock-vex', version: '1' }, { capabilities: { tools: {} } });
  const calls: unknown[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'vex_choose', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    calls.push(request.params);
    return { content: [{ type: 'text', text: 'decision' }], structuredContent: { contractVersion: '1', choice: '1:high', abstained: false, confidence: .9, probabilities: { '0:medium': .1, '1:high': .9 } } };
  });
  await server.connect(serverTransport);
  const vex = new VexRouter('', () => clientTransport);
  const seen: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { seen.push(route); return { result: 'done', completed: true }; } };
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'one', effort: 'medium' }, models: [{ model: 'one', efforts: ['medium'] }, { model: 'two', efforts: ['high'] }] };
  const orchestrator = new Orchestrator(new PaceStore(directory), runner, vex);
  try {
    await vex.start();
    await orchestrator.turn('first task', newSession('/project', 'auto'), config, () => {});
    await orchestrator.turn('second task', newSession('/project', 'auto'), config, () => {});
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ name: 'vex_choose', arguments: { options: [{ id: '0:medium' }, { id: '1:high' }] } });
    expect(seen).toEqual([{ model: 'two', effort: 'high' }, { model: 'two', effort: 'high' }]);
  } finally { await vex.close(); await server.close(); }
});

it('blocks a coding turn when the Vex tool fails', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pace-vex-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'mock-vex', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'vex_choose', inputSchema: { type: 'object' } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: true, http_status: 401, error_detail: 'secret' }) }] }));
  await server.connect(serverTransport);
  const vex = new VexRouter('', () => clientTransport);
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'one', effort: 'medium' }, models: [{ model: 'one', efforts: ['medium'] }, { model: 'two', efforts: ['high'] }] };
  const seen: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { seen.push(route); return { result: 'done', completed: true }; } };
  const orchestrator = new Orchestrator(new PaceStore(directory), runner, vex);
  try {
    await expect(orchestrator.turn('first', newSession('/project', 'auto'), config, () => {})).rejects.toThrow('HTTP 401');
    expect(seen).toEqual([]);
  } finally { await vex.close(); await server.close(); }
});
