import { readFileSync } from 'node:fs';
import { AppServerRunner as ProductionAppServerRunner } from '../integrations/app-server-runner.js';
import { SdkRunner as ProductionSdkRunner } from '../integrations/codex.js';
import { VexRouter as ProductionVexRouter } from '../core/vex/client.js';
import { awaitRouting } from '../core/orchestrator-helpers.js';
import { combinedSignal, modelCall } from './control.js';
export { codexOptions } from '../integrations/codex.js';
export { vexServerPath } from '../core/vex/client.js';
export type { CodexRunner, Progress } from '../integrations/codex.js';
export type { VexRequest } from '../core/vex/client.js';
export class AppServerRunner extends ProductionAppServerRunner {
  override run(...args: Parameters<ProductionAppServerRunner['run']>) { args[5]=combinedSignal(args[5]); return modelCall('codex',args[2],()=>super.run(...args)); }
  override compact(...args: Parameters<ProductionAppServerRunner['compact']>) { args[4]=combinedSignal(args[4]); return modelCall('codex',args[2],()=>super.compact(...args)); }
}
export class SdkRunner extends ProductionSdkRunner {
  override run(...args: Parameters<ProductionSdkRunner['run']>) { args[5]=combinedSignal(args[5]); return modelCall('codex',args[2],()=>super.run(...args)); }
}
export class VexRouter extends ProductionVexRouter {
  override choose(...args: Parameters<ProductionVexRouter['choose']>) {
    const read=()=>{try {const data=JSON.parse(readFileSync(process.env.VEX_STATS_PATH!,'utf8'));return typeof data.total_cost==='number'?data.total_cost:undefined;}catch{return undefined;}};
    const before=read()??0;
    const signal=combinedSignal();
    const cancel=()=>{void this.close().catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    return modelCall('vex',{},async()=>{
      try {const decision=await awaitRouting(super.choose(...args),signal);const after=read();return {usage:undefined,decision,reportedCostUsd:after===undefined?undefined:after-before};}
      catch(error){const after=read();if(error&&typeof error==='object'&&after!==undefined)Object.assign(error,{benchmarkReportedCostUsd:after-before});throw error;}
    }).then(value=>value.decision).finally(()=>signal?.removeEventListener('abort',cancel));
  }
}
