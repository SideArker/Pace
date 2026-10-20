import { appendFileSync } from 'node:fs';
import type { Usage } from '@openai/codex-sdk';
import { AppServer, isRecord, type AppServerConnection } from '../src/integrations/app-server-process.js';
import type { Route } from '../src/shared/types.js';

export const PRICES = {
  checkedAt: '2026-10-20', source: 'https://developers.openai.com/api/docs/pricing', processing: 'standard',
  context: 'short; at most 272K input tokens/request',
  rates: {
    'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWriteInput: 2.5, output: 10 },
    'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWriteInput: 0.125, output: 0.5 },
  },
};
export type Exchange = { user: string; assistant: string };
export type LiveLine = { role: string; text: string; detail?: string };
export function replay(history: Exchange[], request: string): string {
  return `Continue this conversation using only the retained exchanges below. The current user request follows the history.\n\nRetained conversation:\n${JSON.stringify(history)}\n\nCurrent user request:\n${request}`;
}
// Mirror App.tsx askBtw, including only the last 24 visible lines, not tool history.
export function btw(history: Exchange[], lines: LiveLine[], tasks: {text:string; completed:boolean}[], question: string, activePrompt?: string): string {
  const retained = history.map(turn => `User: ${turn.user}\nPace: ${turn.assistant}`).join('\n\n');
  const live = lines.filter(line => line.role !== 'you' || line.text !== `/btw ${question}`).slice(-24).map(line => {
    const speaker = line.role === 'codex' ? 'Pace' : line.role === 'you' ? 'User' : line.role === 'activity' ? 'Agent activity' : line.role === 'system' ? 'System' : line.role;
    return `${speaker}: ${line.text}${line.detail ? ` (${line.detail})` : ''}`;
  }).join('\n');
  const plan = tasks.map(task => `${task.completed ? '[x]' : '[ ]'} ${task.text}`).join('\n');
  const context = [retained ? `Retained conversation:\n${retained}` : '', activePrompt ? `Current user request (still in progress):\n${activePrompt}` : '', plan ? `Current agent task plan:\n${plan}` : '', live ? `Recent live transcript and progress:\n${live}` : ''].filter(Boolean).join('\n\n');
  return `Answer the user's side question directly using the conversation context below. Start with the requested format (for example, yes or no when asked a yes/no question), then give only the explanation needed. Treat current progress as evidence about what has happened so far, and be clear if a task is still in progress. Do not edit files or take action. This is separate from the main conversation.\n\nConversation context:\n${context || '(No previous turns)'}\n\nUser's side question (answer this exact question):\n${question}`;
}
export type Rpc = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: {message?:string} };
export class Capture {
  events: { direction: string; message: Rpc; at: string }[] = [];
  constructor(readonly path: string, readonly route: Route) {}
  log(direction: string, message: Rpc) {
    const entry = { direction, message, at: new Date().toISOString() };
    this.events.push(entry); appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }
  factory = (onMessage: (message: Rpc) => void, onExit: (error: Error) => void): AppServerConnection => {
    const server = new AppServer(message => { this.log('in', message); onMessage(message); }, onExit);
    return {
      request: async (method, params) => {
        if ((method === 'thread/start' || method === 'thread/resume') && isRecord(params)) {
          params = { ...params, config: { 'mcp_servers.vex.enabled': false, 'mcp_servers.codex_apps.enabled': false, 'features.apps': false, 'model_reasoning_effort': this.route.effort, 'model_auto_compact_token_limit': 240000 }, serviceTier: 'standard', developerInstructions: 'Work only in the isolated fixture directory. Do not use network, MCP, or subagents. Do not read private configuration or other projects. Do not commit. Use local shell tools for this task.' };
        }
        this.log('out', {method, params});
        const result = await server.request(method, params);
        this.log('response', {method, result});
        if ((method === 'thread/start' || method === 'thread/resume') && isRecord(result) && result.model !== this.route.model) throw new Error(`Model mismatch: requested ${this.route.model}, observed ${result.model}`);
        if ((method === 'thread/start' || method === 'thread/resume') && isRecord(result) && result.reasoningEffort !== this.route.effort) throw new Error(`Effort mismatch: requested ${this.route.effort}, observed ${result.reasoningEffort}`);
        return result;
      },
      setRequestHandler: handler => server.setRequestHandler(message => { this.log('request', message); handler(message); }),
      notify: (method, params) => { this.log('out', {method, params}); server.notify(method, params); },
      respond: (id, result) => { this.log('out', {id, result}); server.respond(id, result); },
      kill: () => server.kill(),
    };
  };
  audit(runnerUsage?: Usage) {
    const updates = this.events.filter(e => e.direction === 'in' && e.message.method === 'thread/tokenUsage/updated');
    let started = false; let previous: number | undefined; let summed: Record<string, number | null> | undefined;
    let calls = 0; const contexts: unknown[] = [];
    const keys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
    for (const event of this.events) {
      if (event.direction === 'out' && ['turn/start', 'thread/compact/start'].includes(event.message.method ?? '')) started = true;
      if (event.direction !== 'in' || event.message.method !== 'thread/tokenUsage/updated') continue;
      const p = event.message.params as any; const u = p.tokenUsage; const total = u?.total?.totalTokens;
      if (!started) { previous = total; continue; }
      if (typeof total !== 'number' || (previous !== undefined && total <= previous)) continue;
      previous = total; calls++; contexts.push({last: u.last, modelContextWindow: u.modelContextWindow});
      summed ??= Object.fromEntries(keys.map(key => [key, 0]));
      for (const key of keys) summed[key] = summed[key] === null || typeof u.last?.[key] !== 'number' ? null : summed[key]! + u.last[key];
    }
    const mapping = { inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', cacheWriteInputTokens: 'cache_write_input_tokens', outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens' } as const;
    const usage = summed ? Object.fromEntries(Object.entries(mapping).map(([camel, snake]) => [snake, summed![camel] ?? null])) : undefined;
    const aggregationMatches = usage && runnerUsage ? Object.entries(usage).every(([key, value]) => value === null || runnerUsage[key as keyof Usage] === value) : null;
    const rates = PRICES.rates[this.route.model as keyof typeof PRICES.rates];
    let estimateNoUnreportedWritesUsd: number | undefined; let upperBoundUnknownWritesUsd: number | undefined;
    if (usage && rates && usage.input_tokens !== null && usage.cached_input_tokens !== null && usage.output_tokens !== null) {
      const writes = usage.cache_write_input_tokens;
      const ordinary = usage.input_tokens! - usage.cached_input_tokens! - (writes ?? 0);
      estimateNoUnreportedWritesUsd = (ordinary * rates.input + usage.cached_input_tokens! * rates.cachedInput + (writes ?? 0) * rates.cacheWriteInput + usage.output_tokens! * rates.output) / 1e6;
      upperBoundUnknownWritesUsd = writes === null ? estimateNoUnreportedWritesUsd + ordinary * (rates.cacheWriteInput - rates.input) / 1e6 : estimateNoUnreportedWritesUsd;
    }
    const threads = this.events.filter(e => e.direction === 'response' && ['thread/start','thread/resume'].includes(e.message.method ?? '')).map(e => {
      const r = e.message.result as any; return {method:e.message.method, threadId:r?.thread?.id, model:r?.model, effort:r?.reasoningEffort, instructionSources:r?.instructionSources, configurationDurationMs: Date.parse(e.at)-Date.parse(this.events.find(x=>x.direction==='out'&&x.message.method===e.message.method)!.at)};
    });
    return {usage, runnerUsage, aggregationMatches, modelRequests: calls, rawUsageEvents: updates.length, contexts, threads, reroutes: this.events.filter(e => e.message.method === 'model/rerouted'), estimateNoUnreportedWritesUsd, upperBoundUnknownWritesUsd};
  }
}
