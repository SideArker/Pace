import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import type { Route } from "../shared/types.js";
import { realpath } from "node:fs/promises";
import { artifactPrompt } from "../core/system/artifacts.js";
import { vexServerPath } from "../core/vex/client.js";
import type { CodexRunner, Execution, Progress } from "./codex-types.js";
import { codexOptions } from "./codex-options.js";
import { eventProgress } from "./codex-events.js";
/** Direct TypeScript SDK runner retained for SDK-focused integrations. */
export class SdkRunner implements CodexRunner {
  private codex: Codex;

  constructor(
    options: CodexOptions = codexOptions(vexServerPath()),
    private readonly onEvent?: (event: ThreadEvent) => void | Promise<void>,
  ) {
    this.codex = new Codex(options);
  }

  async run(
    prompt: string,
    project: string,
    route: Route,
    threadId: string | undefined,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
    mode: "main" | "side" = "main",
    trustedFolders: string[] = [],
  ): Promise<Execution> {
    const options: ThreadOptions = {
      workingDirectory: await realpath(project),
      sandboxMode: mode === "side" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      model: route.model,
      modelReasoningEffort: route.effort,
      additionalDirectories: mode === "main" ? trustedFolders : [],
    };
    const thread = threadId ? this.codex.resumeThread(threadId, options) : this.codex.startThread(options);
    const { events } = await thread.runStreamed(mode === "side" ? prompt : artifactPrompt(prompt), { signal });
    let result = "";
    let completed = false;
    let failure: string | undefined;
    let usage: Usage | undefined;
    for await (const event of events) {
      await this.onEvent?.(event);
      const progress = eventProgress(event);
      if (event.type === "thread.started") await onProgress({ kind: "thread", text: event.thread_id });
      if (progress) await onProgress(progress);
      if (event.type === "item.completed" && event.item.type === "agent_message") result = event.item.text;
      if (event.type === "turn.completed") { completed = true; usage = event.usage; }
      if (event.type === "turn.failed") failure = event.error.message;
      if (event.type === "error") failure = event.message;
    }
    if (failure) throw new Error(failure);
    if (!completed) throw new Error("Codex stream ended without turn.completed");
    return { threadId: thread.id ?? undefined, result: result || "Codex completed without a final message.", completed, usage };
  }
}
