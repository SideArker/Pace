import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ModelOption } from '../types.js';
import type { RouteContext } from '../core/router.js';

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
  const trimmed = prompt.trim();
  const greeting = /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))[!.?\s]*$/i.test(trimmed);
  const implementationVerb = /\b(build|implement|create|code|write|develop|fix|debug|refactor|migrate|deploy|integrate|edit|change|add)\b/i.test(prompt)
    || /\b(?:run|execute)\s+tests?\b|^test\s+(?:the|this|my|our|a)\b/i.test(trimmed);
  const planning = /\b(plan|planning|roadmap|proposal|approach|strategy|design|architect)\b/i.test(prompt)
    && (!implementationVerb || /\bplan(?:ning)?\s+(?:how|to|for)\b/i.test(prompt))
    && !/\bplan\s*(?:,?\s*(?:and|then)\s+)(?:build|implement|create|develop|write)\b|\b(?:build|implement|create|develop|write)\s+and\s+plan\b/i.test(prompt)
    && !/\b(create|write|edit|save|update)\b.*\b(file|artifact|document|markdown)\b|\b(create|write|edit|save|update)\b.*\.md\b/i.test(prompt);
  const implementation = implementationVerb && !planning;
  const codingAction = implementation || planning || /\b(design|architect)\b/i.test(prompt);
  const currentInfo = /\b(today|tomorrow|latest|current|recent|forecast|weather|news|price|prices)\b/i.test(prompt);
  const factualQuestion = !greeting && !codingAction && (
    /\b(?:what(?:['’]s|\s+(?:is|are|does|do))|who(?:['’]s|\s+(?:is|are))|where(?:['’]s|\s+(?:is|are))|when(?:['’]s|\s+(?:is|are))|why\s+(?:is|are|does|do)|how\s+(?:does|do|is|are)|which\s+(?:is|are)|explain|define|tell(?:ing)? me (?:what|about|how))\b/i.test(prompt)
    || /^(?:the\s+)?(?:weather|forecast|temperature)\b/i.test(prompt.trim())
  );
  const exploration = /\b(list|find|locate|show|search|inspect|explore|analy[sz]e|look (?:for|at)|where (?:is|are))\b/i.test(prompt)
    && /\b(file|files|folder|directory|repo|repository|codebase|function|class|symbol|implementation|usage|definition)\b/i.test(prompt)
    && !implementation && !planning;
  const diagnostic = /\b(fix|debug|bug|error|fail|regression)\b|what(?:['’]s| is) wrong/i.test(prompt);
  const category = greeting ? 'conversation' : planning ? 'planning' : exploration ? 'exploration' : diagnostic ? 'debugging' : factualQuestion ? 'general_knowledge' : /\b(refactor|migrate|rename|cleanup)\b/i.test(prompt) ? 'refactoring' : implementation ? 'coding' : 'unclear';
  const words = prompt.trim().split(/\s+/).length;
  const size = words < 12 ? 'short' : words < 40 ? 'medium' : 'long';
  const complexDomain = /\b(payment|payments|billing|financial|security|auth|authentication|distributed)\b/i.test(prompt);
  const architecture = /\b(system|architecture|architect|design|platform|end.to.end)\b/i.test(prompt);
  const critical = /\b(outage|critical|irreversible|data loss|zero.downtime)\b/i.test(prompt) && /\b(migrat|deploy|security|auth|payment|billing|distributed|system|service|database)/i.test(prompt);
  const simpleChange = /\b(small|simple|minor|tiny|button color|colour|typo)\b/i.test(prompt);
  const needsRepository = /\b(existing|current|repo|repository|codebase|project|add|implement|fix|debug|refactor|migrate)\b/i.test(prompt);
  const intent = greeting ? 'brief social greeting' : planning ? 'read-only planning' : exploration ? 'read-only repository exploration' : factualQuestion ? currentInfo ? 'current-information lookup' : 'brief factual explanation' : implementation ? 'software implementation' : 'unclear task';
  const describe = (model: string, effort: string) => {
    const tier = /luna/i.test(model) ? 'fast low-cost tier' : /sol/i.test(model) ? 'strong coding tier' : 'configured coding tier';
    return `${model} at ${effort} reasoning, ${tier}`;
  };
  const modelOnly = models.length >= 2 && models.every(model => model.efforts.length === 1);
  const context: RouteContext = { category, requestLength: size, currentInfo, multipleFiles: /\b(all|multiple|several)\s+files?\b/i.test(prompt), testsMentioned: /\b(tests?|specs?)\b/i.test(prompt), complexDomain, architecture, critical, simpleChange, needsRepository };
  return {
    question: modelOnly ? 'Which supplied Codex model should handle this task?' : 'Which configured Codex model and effort should handle this task?',
    context: { ...context, intent },
    options: models.flatMap((model, index) => model.efforts.map(effort => ({ id: `${index}:${effort}`, description: describe(model.model, effort) }))),
    constraints: `${modelOnly ? 'Pace has selected one reasoning effort per model. Choose the least costly capable model. ' : 'Choose the least costly capable model and effort. '}Use task intent and reasoning demand, not request length alone. Luna handles conversation, lookup, repository reading and planning, including architectural planning. Sol handles implementation, debugging and refactoring. Low suits routine lookup or scanning; medium suits small changes or modest synthesis; high suits substantial implementation or multi-step planning; xhigh suits difficult design or sensitive implementation; ultra is reserved for unusually complex, critical changes with serious failure impact. A sensitive topic alone does not make a read-only plan an implementation task. Abstain only when supplied context is insufficient to choose a capable model.`,
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
