import { PaceStore, newSession } from "./sessions.js";
import { Orchestrator } from "./orchestrator.js";
import { AppServerRunner } from "../integrations/codex.js";
import { VexRouter } from "./vex/client.js";

export async function execTurn(prompt: string, project = process.cwd()): Promise<number> {
  if (!prompt.trim()) {
    console.error('Usage: pace exec "prompt"');
    return 2;
  }
  const store = new PaceStore();
  const vex = new VexRouter();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let lastProgressError: string | undefined;
  process.on("SIGINT", cancel);
  try {
    const config = await store.loadConfig();
    const session = await store.latest(project) ?? newSession(project, config.routingMode);
    const outcome = await new Orchestrator(store, new AppServerRunner(), vex).turn(prompt, session, config, progress => {
      if (progress.kind === "error") {
        lastProgressError = progress.text;
        console.error(progress.text);
      }
      if (progress.kind === "system") console.error(`System: ${progress.text}`);
      if (progress.kind === "approval") {
        console.error(`Denied command approval in non-interactive mode: ${progress.command}`);
        progress.respond("decline");
      }
      if (progress.kind === "question") {
        console.error("Skipped agent question in non-interactive mode.");
        progress.respond({});
      }
    }, controller.signal);
    controller.signal.throwIfAborted();
    console.log(outcome.result);
    return 0;
  } catch (error) {
    if (controller.signal.aborted) console.error("Turn cancelled by user");
    else if (String(error) !== lastProgressError) console.error(String(error));
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    await vex.close();
  }
}
