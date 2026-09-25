import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { Route } from "../types.js";
import { vexServerPath } from './vex.js';
export type Progress =
  | { kind: "status" | "message" | "error" | "thread"; text: string }
  | { kind: "route"; route: Route };
export type Execution = {
  threadId?: string;
  result: string;
  completed: boolean;
  usage?: Usage;
};
export interface CodexRunner {
  run(
    prompt: string,
    project: string,
    route: Route,
    threadId: string | undefined,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<Execution>;
}
export function eventProgress(event: ThreadEvent): Progress | undefined {
  if (event.type === "error") return { kind: "error", text: event.message };
  if (event.type === "turn.failed")
    return { kind: "error", text: event.error.message };
  if (event.type === "turn.started")
    return { kind: "status", text: "Working…" };
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  )
    return undefined;
  const item = event.item;
  if (item.type === "reasoning") return undefined;
  if (item.type === "agent_message" && event.type === "item.completed")
    return { kind: "message", text: item.text };
  if (item.type === "command_execution")
    return {
      kind: "status",
      text:
        event.type === "item.completed"
          ? `Command ${item.status}${item.exit_code === undefined ? "" : ` (${item.exit_code})`}`
          : "Running command…",
    };
  if (item.type === "file_change")
    return {
      kind: "status",
      text:
        event.type === "item.completed"
          ? `${item.changes.length} file change(s) ${item.status}`
          : "Editing files…",
    };
  if (item.type === "web_search")
    return { kind: "status", text: "Searching web…" };
  if (item.type === "mcp_tool_call")
    return {
      kind: "status",
      text: `Tool ${item.server}/${item.tool}: ${item.status}`,
    };
  if (item.type === "error") return { kind: "error", text: item.message };
  return undefined;
}
export function codexOptions(serverPath: string | undefined): CodexOptions {
  return serverPath ? { config: { mcp_servers: { vex: { command: process.execPath, args: [serverPath, 'mcp', 'serve'], env_vars: ['OPENROUTER_API_KEY'] } } } } : {};
}
export class SdkRunner implements CodexRunner {
  private codex = new Codex(codexOptions(vexServerPath()));
  async run(
    prompt: string,
    project: string,
    route: Route,
    threadId: string | undefined,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<Execution> {
    const options: ThreadOptions = {
      workingDirectory: project,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      model: route.model,
      modelReasoningEffort: route.effort,
    };
    const thread = threadId
      ? this.codex.resumeThread(threadId, options)
      : this.codex.startThread(options);
    const { events } = await thread.runStreamed(prompt, { signal });
    let result = "";
    let completed = false;
    let failure: string | undefined;
    let usage: Usage | undefined;
    for await (const event of events) {
      const progress = eventProgress(event);
      if (event.type === "thread.started")
        await onProgress({ kind: "thread", text: event.thread_id });
      if (progress) await onProgress(progress);
      if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      )
        result = event.item.text;
      if (event.type === "turn.completed") {
        completed = true;
        usage = event.usage;
      }
      if (event.type === "turn.failed") failure = event.error.message;
      if (event.type === "error") failure = event.message;
    }
    if (failure) throw new Error(failure);
    if (!completed)
      throw new Error("Codex stream ended without turn.completed");
    return {
      threadId: thread.id ?? undefined,
      result: result || "Codex completed without a final message.",
      completed,
      usage,
    };
  }
}
