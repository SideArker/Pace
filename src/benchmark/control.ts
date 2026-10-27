import { appendFileSync } from 'node:fs';
import type { Route } from '../shared/types.js';
import type { Usage } from '@openai/codex-sdk';
import type { Config } from '../shared/types.js';
import type { RoutingPrompts } from '../core/routing/routing-prompts.js';
import { assertDebug } from './storage.js';
import { costForUsage, type PriceSnapshot } from '../core/routing/pricing.js';
import { randomUUID } from 'node:crypto';
import type { Event } from './types.js';
type Context = { signal: AbortSignal; events: string; completed: Set<string>; maxTurns: number; timeoutMs?: number; maxUsd?: number; calls: number; knownUsd: number; trial?: string; trialAttempt?: string; segment?: number; prices?: PriceSnapshot; effective?: {config:Config;prompts:RoutingPrompts}; onEvent?: (event: Event)=>void };
let context: Context | undefined;
export function configureControl(value: Context | undefined) { context=value; }
export function effectiveConfiguration() { return context?.effective; }
export function emit(kind: string, fields: Record<string,unknown>={}) {
  if(!context) return;
  const event={at:new Date().toISOString(),kind,segment:context.segment,trialAttempt:context.trialAttempt,...fields};
  appendFileSync(context.events,JSON.stringify(event)+'\n',{mode:0o600}); context.onEvent?.(event);
}
export function checkControl() {
  context?.signal.throwIfAborted();
  if(context && context.calls>=context.maxTurns) throw new Error('Benchmark model call limit reached; no further calls started');
  if(context?.maxUsd!==undefined && context.knownUsd>=context.maxUsd) throw new Error('Benchmark estimated dollar threshold reached; no further calls started');
}
export function beginTrial(key: string) {
  context?.signal.throwIfAborted();
  if(context?.completed.has(key)) { emit('trial-skipped',{key}); return false; }
  if(context) {context.trial=key;context.trialAttempt=randomUUID();}
  emit('trial-started',{key}); return true;
}
export function finishTrial(failed=false) { emit('trial-finished',{key:context?.trial,execution:failed?'failed':'completed'}); if(context) {context.trial=undefined;context.trialAttempt=undefined;} }
export function combinedSignal(signal?: AbortSignal) { return context ? AbortSignal.any([context.signal,...(signal?[signal]:[]),...(context.timeoutMs?[AbortSignal.timeout(context.timeoutMs)]:[])]) : signal; }
export async function modelCall<T extends { usage?: Usage; knownUsage?: Usage; usageComplete?: boolean; route?: Route; reportedCostUsd?: number }>(kind: 'codex'|'vex', route: Route, action: ()=>Promise<T>): Promise<T> {
  assertDebug();
  checkControl(); const id=randomUUID(), started=performance.now();
  if(context) context.calls++;
  emit('call-started',{id,trial:context?.trial,provider:kind,route});
  let result:T|undefined, failure:unknown;
  try {
    result=await action();
    if(kind==='codex'&&result.route&&((route.model&&result.route.model&&route.model!==result.route.model)||(route.effort&&result.route.effort&&route.effort!==result.route.effort)))throw new Error('Benchmark model/effort mismatch; fallback routes are not accepted');
    return result;
  } catch(error) { failure=error; throw error; }
  finally {
    const error=failure as { usage?: Usage; accounting?: { knownUsage?: Usage; route?: Route; usageComplete?: boolean } } | undefined;
    const effectiveRoute=result?.route??error?.accounting?.route??route;
    const usage=result?.usage??error?.usage, knownUsage=result?.knownUsage??error?.accounting?.knownUsage??usage;
    const price=(value:Usage|undefined)=>value && ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens'].every(key=>Number.isFinite(value[key as keyof Usage])&&value[key as keyof Usage]>=0)
      && value.input_tokens>=value.cached_input_tokens+value.cache_write_input_tokens
      ? costForUsage(effectiveRoute,value,context?.prices) : undefined;
    const reported=result?.reportedCostUsd??(failure as any)?.benchmarkReportedCostUsd;
    const reportedCost=Number.isFinite(reported)&&reported>=0?reported:undefined;
    const estimatedCostUsd=kind==='vex'?reportedCost:price(usage), knownCostUsd=kind==='vex'?reportedCost:price(knownUsage);
    if(context) context.knownUsd+=knownCostUsd??0;
    emit('call-finished',{id,trial:context?.trial,provider:kind,route:effectiveRoute,usage,knownUsage,estimatedCostUsd,knownCostUsd,costComplete:estimatedCostUsd!==undefined&&(kind==='vex'||result?.usageComplete!==false&&error?.accounting?.usageComplete!==false),usageComplete:kind==='codex' && !!usage && result?.usageComplete!==false && error?.accounting?.usageComplete!==false,error:failure?String(failure):undefined,durationMs:Math.round(performance.now()-started)});
  }
}
