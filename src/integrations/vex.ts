import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ModelOption } from '../types.js';

const require = createRequire(import.meta.url);

export function vexServerPath(): string | undefined {
  try {
    const path = join(dirname(require.resolve('vex-mcp/package.json')), 'dist', 'index.js');
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

export function routeRequest(prompt: string, models: ModelOption[]) {
  // Keep user text, repository content and paths out of the remote decision.
  const greeting = /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))[!.?\s]*$/i.test(prompt.trim());
  const category = greeting ? 'conversation' : /\b(test|bug|fix|error|fail|regression)\b/i.test(prompt) ? 'debugging' : /\b(refactor|migrate|rename|cleanup)\b/i.test(prompt) ? 'refactoring' : 'coding';
  const words = prompt.trim().split(/\s+/).length;
  const size = words < 12 ? 'short' : words < 40 ? 'medium' : 'long';
  const complexDomain = /\b(payment|payments|billing|financial|security|auth|authentication|distributed)\b/i.test(prompt);
  const architecture = /\b(system|architecture|architect|design|platform|end.to.end)\b/i.test(prompt);
  return {
    question: 'Which configured Codex model and effort should handle this task?',
    context: { category, requestLength: size, multipleFiles: /\b(all|multiple|several)\s+files?\b/i.test(prompt), testsMentioned: /\b(tests?|specs?)\b/i.test(prompt), complexDomain, architecture },
    options: models.flatMap((model, index) => model.efforts.map(effort => ({ id: `${index}:${effort}`, description: `Codex model ${model.model}, reasoning effort ${effort}` }))),
    constraints: 'Choose only from the supplied routes; abstain when evidence is insufficient.',
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
      const transport = this.transportFactory?.() ?? new StdioClientTransport({ command: process.execPath, args: [this.serverPath!, 'mcp', 'serve'], stderr: 'ignore', env: { ...getDefaultEnvironment(), ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}) } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([client.connect(transport), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Vex MCP connection timed out')), 8000); })]);
        const tools = await client.listTools(undefined, { timeout: 8000 });
        if (!tools.tools.some(tool => tool.name === 'vex_choose')) throw new Error('Vex MCP does not offer vex_choose');
        this.client = client;
        this.transport = transport;
      } catch (error) {
        await transport.close();
        this.connecting = undefined;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.connecting;
  }

  async choose(prompt: string, models: ModelOption[]): Promise<unknown> {
    const routeCount = models.reduce((count, model) => count + model.efforts.length, 0);
    if (routeCount < 2 || routeCount > 12) return undefined;
    await this.start();
    const result = await this.client!.callTool({ name: 'vex_choose', arguments: routeRequest(prompt, models) }, undefined, { timeout: 12000 });
    if (result.isError) {
      const detail = Array.isArray(result.content) ? result.content.find((item: unknown) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text') : undefined;
      let status: unknown;
      try { status = detail && 'text' in detail && typeof detail.text === 'string' ? JSON.parse(detail.text).http_status : undefined; } catch { /* Invalid tool errors remain generic. */ }
      throw new Error(typeof status === 'number' && status > 0 ? `Vex decision tool failed (HTTP ${status})` : 'Vex decision tool failed; check Vex credentials and network access');
    }
    return result.structuredContent;
  }

  async verify(): Promise<void> {
    await this.start();
    await this.client!.ping({ timeout: 5000 });
  }

  get connected(): boolean { return this.client !== undefined; }

  async close(): Promise<void> {
    await this.connecting?.catch(() => {});
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
  }
}
