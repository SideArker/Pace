import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ModelOption, TurnSummary } from '../types.js';
import { PRICE_SNAPSHOT, modelRates } from '../core/pricing.js';
import { routeChoices, type RoutingChoice } from '../core/router.js';

const require = createRequire(import.meta.url);
export function vexServerPath(): string | undefined {
  try {
    const path = join(dirname(require.resolve('vex-mcp/package.json')), 'dist', 'index.js');
    return existsSync(path) ? path : undefined;
  } catch { return undefined; }
}

export type VexRequest = {
  question: string;
  context: Record<string, unknown>;
  options: RoutingChoice[];
  constraints: string;
  decisionType: 'routing';
};
const effortCapability: Record<string, string> = {
  minimal: 'short direct response with minimal reasoning',
  low: 'focused lookup, narrow repository reading, or routine synthesis',
  medium: 'multi-file reading, small edits, and moderate synthesis',
  high: 'substantial implementation or detailed multi-step reasoning',
  xhigh: 'difficult architecture, debugging, or sensitive implementation',
  ultra: 'hardest work with automatic task delegation',
  persistent: 'long-running work that needs proactive follow-through',
};
const modelCapability: Record<string, string> = {
  'gpt-6-luna': 'efficient focused work, repository scouting, and straightforward plans',
  'gpt-6-sol': 'complex coding and agentic work; Sol High is the quality baseline',
  'gpt-6-astra': 'most demanding end-to-end work',
};
function taskContext(prompt: string, turns: TurnSummary[], models: ModelOption[]) {
  return {
    originalRequest: prompt,
    recentConversation: turns.slice(-6).map(turn => ({ user: turn.prompt, assistant: turn.result })),
    availableModels: models.map(model => ({
      id: model.model,
      capability: modelCapability[model.model] ?? 'Configured Codex model; capability unspecified',
      supportedEfforts: model.efforts.map(effort => ({ id: effort, capability: effortCapability[effort] ?? 'Configured SDK effort' })),
      standardUsdPerMillionTokens: modelRates(model.model),
    })),
    priceSnapshot: { checkedAt: PRICE_SNAPSHOT.checkedAt, source: PRICE_SNAPSHOT.source, processing: PRICE_SNAPSHOT.processing, context: PRICE_SNAPSHOT.context },
  };
}
export const shapeChoices: RoutingChoice[] = [
  { id: 'single', description: 'One Codex agent completes requested deliverable. Cheapest when no separate handoff improves total cost or quality.' },
  { id: 'scout', description: 'Luna read-only scout maps relevant repository files; second agent completes request using structured handoff. Include both stages in expected Codex cost.' },
  { id: 'plan_execute', description: 'Planning agent produces actionable plan; execution agent completes requested implementation. Use only when user requests implementation and planning improves quality and total cost.' },
  { id: 'clarify', description: 'Ask user to clarify requested outcome when deliverable cannot be determined from original request and conversation.' },
];
export function shapeRequest(prompt: string, turns: TurnSummary[], models: ModelOption[]): VexRequest {
  return {
    question: 'Which Codex workflow best completes the requested deliverable at the least total Codex cost while meeting Sol High quality?',
    context: taskContext(prompt, turns, models), options: shapeChoices, decisionType: 'routing',
    constraints: 'Infer requested deliverable from original words and conversation. A complex topic alone does not imply implementation. A request only for a plan must choose single, scout, or clarify; never plan_execute. Scout requires enabled Luna. Compare expected total Codex cost of every stage. Ignore Vex cost. Choose clarify only when requested outcome is unclear.',
  };
}
export function stageRequest(prompt: string, turns: TurnSummary[], models: ModelOption[], objective: string, handoff?: string): VexRequest {
  const options = routeChoices(models);
  return {
    question: 'Which supported Codex model and effort together can meet Sol High quality for this stage at the least expected Codex cost?',
    context: { ...taskContext(prompt, turns, models), stageObjective: objective, ...(handoff ? { priorStageHandoff: handoff } : {}) },
    options, decisionType: 'routing',
    constraints: 'Choose one valid model and effort pair. Account for stage scope and expected token use at current prices. Reasoning output is part of output cost. Use prior handoff when supplied. Do not turn a plan-only request into implementation.',
  };
}

export class VexRouter {
  private client?: Client;
  private connecting?: Promise<void>;
  private transport?: Transport;
  constructor(readonly serverPath = vexServerPath(), private readonly transportFactory?: () => Transport) {}
  async start(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.serverPath && !this.transportFactory) throw new Error('Vex MCP server was not found');
    this.connecting = (async () => {
      const client = new Client({ name: 'pace', version: '0.1.0' });
      const transport = this.transportFactory?.() ?? new StdioClientTransport({ command: process.execPath, args: [this.serverPath!, 'mcp', 'serve'], stderr: 'ignore', env: { ...getDefaultEnvironment(), ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}), ...(process.env.VEX_STATS_PATH ? { VEX_STATS_PATH: process.env.VEX_STATS_PATH } : {}) } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.connect(transport), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Vex MCP connection timed out')), 8000); })]);
        const tools = await client.listTools(undefined, { timeout: 8000 });
        if (!tools.tools.some(tool => tool.name === 'vex_choose')) throw new Error('Vex MCP does not offer vex_choose');
        this.client = client;
        this.transport = transport;
      } catch (error) {
        await transport.close(); this.connecting = undefined; throw error;
      } finally { clearTimeout(timer); }
    })();
    return this.connecting;
  }
  async choose(request: VexRequest): Promise<unknown> {
    await this.start();
    const result = await this.client!.callTool({ name: 'vex_choose', arguments: request }, undefined, { timeout: 12000 });
    if (result.isError) {
      const detail = Array.isArray(result.content) ? result.content.find(item => item.type === 'text') : undefined;
      let status: unknown;
      try { status = detail?.type === 'text' ? JSON.parse(detail.text).http_status : undefined; } catch { /* Keep generic failure. */ }
      throw new Error(typeof status === 'number' && status > 0 ? `Vex decision tool failed (HTTP ${status})` : 'Vex decision tool failed; check Vex credentials and network access');
    }
    return result.structuredContent;
  }
  async verify(): Promise<void> { await this.start(); await this.client!.ping({ timeout: 5000 }); }
  get connected(): boolean { return this.client !== undefined; }
  async close(): Promise<void> {
    await this.connecting?.catch(() => {}); await this.client?.close();
    this.client = undefined; this.transport = undefined; this.connecting = undefined;
  }
}
