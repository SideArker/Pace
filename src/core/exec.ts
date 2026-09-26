import { PaceStore, newSession } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import { SdkRunner } from "../integrations/codex.js";
import { VexRouter } from "./vex.js";

export async function execTurn(prompt: string, project = process.cwd()): Promise<number> {
  if (!prompt.trim()) {
    console.error('Usage: pace exec "prompt"');
    return 2;
  }
  const store = new PaceStore();
  const vex = new VexRouter();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const config = await store.loadConfig();
    const session = await store.latest(project) ?? newSession(project, config.routingMode);
    const outcome = await new Orchestrator(store, new SdkRunner(), vex).turn(prompt, session, config, progress => {
      if (progress.kind === "error") console.error(progress.text);
    }, controller.signal);
    console.log(outcome.result);
    return 0;
  } catch (error) {
    console.error(String(error));
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    await vex.close();
  }
}
