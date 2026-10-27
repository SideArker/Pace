import { AppServerRunner as ProductionAppServerRunner } from '../integrations/app-server-runner.js';
import { combinedSignal, modelCall } from './control.js';
export type { CodexRunner, Progress } from '../integrations/codex.js';
export class AppServerRunner extends ProductionAppServerRunner {
  override run(...args: Parameters<ProductionAppServerRunner['run']>) {
    args[5] = combinedSignal(args[5]);
    return modelCall('codex', args[2], () => super.run(...args));
  }
}
