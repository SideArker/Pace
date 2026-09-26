import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { VexRouter } from '../src/core/vex/client.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { PaceStore, newSession } from '../src/core/sessions.js';
import type { Config, Route } from '../src/shared/types.js';
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
    const ids = (request.params.arguments?.options as { id: string }[]).map(option => option.id);
    const choice = ids.includes('single') ? 'single' : '1:high';
    return { content: [{ type: 'text', text: 'decision' }], structuredContent: { contractVersion: '1', choice, abstained: false, confidence: .9, probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? .9 : .1 / (ids.length - 1)])) } };
  });
  await server.connect(serverTransport);
  const vex = new VexRouter('', () => clientTransport);
  const seen: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { seen.push(route); return { result: 'done', completed: true }; } };
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-luna', effort: 'medium' }, models: [{ model: 'gpt-6-luna', efforts: ['medium'] }, { model: 'gpt-6-sol', efforts: ['high'] }] };
  const orchestrator = new Orchestrator(new PaceStore(directory), runner, vex);
  try {
    await vex.start();
    await orchestrator.turn('first task', newSession('/project', 'auto'), config, () => {});
    await orchestrator.turn('second task', newSession('/project', 'auto'), config, () => {});
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ name: 'vex_choose', arguments: { options: [{ id: 'single' }, { id: 'scout' }, { id: 'plan_execute' }, { id: 'clarify' }] } });
    expect(calls[1]).toMatchObject({ name: 'vex_choose', arguments: { options: [{ id: '0:medium' }, { id: '1:high' }] } });
    expect(seen).toEqual([{ model: 'gpt-6-sol', effort: 'high' }, { model: 'gpt-6-sol', effort: 'high' }]);
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
  const config: Config = { routingMode: 'auto', defaultRoute: { model: 'gpt-6-luna', effort: 'medium' }, models: [{ model: 'gpt-6-luna', efforts: ['medium'] }, { model: 'gpt-6-sol', efforts: ['high'] }] };
  const seen: Route[] = [];
  const runner: CodexRunner = { async run(_prompt, _project, route) { seen.push(route); return { result: 'done', completed: true }; } };
  const orchestrator = new Orchestrator(new PaceStore(directory), runner, vex);
  try {
    await expect(orchestrator.turn('first', newSession('/project', 'auto'), config, () => {})).rejects.toThrow('HTTP 401');
    expect(seen).toEqual([]);
  } finally { await vex.close(); await server.close(); }
});
