import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { Route } from "../types.js";
import { realpath } from "node:fs/promises";
import { artifactPrompt } from "../core/artifacts.js";
import { vexServerPath } from './vex.js';
export type Progress =
  | { kind: "status" | "message" | "error" | "thread"; text: string }
  | { kind: "route"; route: Route }
  | { kind: "activity"; id: string; category: "thinking" | "command" | "files" | "tool" | "search" | "plan"; title: string; detail?: string; completed: boolean };
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
    mode?: "main" | "side",
    trustedFolders?: string[],
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
  if (item.type === "reasoning")
    return { kind: "activity", id: item.id, category: "thinking", title: "Thinking", detail: item.text, completed: event.type === "item.completed" };
  if (item.type === "agent_message" && event.type === "item.completed")
    return { kind: "message", text: item.text };
  if (item.type === "command_execution")
    return {
      kind: "activity", id: item.id, category: "command",
      title: `${item.status === "in_progress" ? "Running" : item.status === "failed" ? "Failed" : "Ran"}: ${item.command}${item.exit_code === undefined ? "" : ` (exit ${item.exit_code})`}`,
      detail: item.aggregated_output, completed: event.type === "item.completed",
    };
  if (item.type === "file_change")
    return {
      kind: "activity", id: item.id, category: "files",
      title: `${item.status === "failed" ? "Failed to edit" : "Edited"} ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`,
      detail: item.changes.map(change => `${change.kind} ${change.path}`).join("\n"), completed: event.type === "item.completed",
    };
  if (item.type === "web_search")
    return { kind: "activity", id: item.id, category: "search", title: `Web search: ${item.query}`, completed: event.type === "item.completed" };
  if (item.type === "mcp_tool_call")
    return {
      kind: "activity", id: item.id, category: "tool", title: `Tool ${item.server}/${item.tool}: ${item.status}`,
      detail: item.error?.message, completed: event.type === "item.completed",
    };
  if (item.type === "todo_list")
    return { kind: "activity", id: item.id, category: "plan", title: "Plan", detail: item.items.map(step => `${step.completed ? "✓" : "○"} ${step.text}`).join("\n"), completed: event.type === "item.completed" };
  if (item.type === "error") return { kind: "error", text: item.message };
  return undefined;
}
export function codexOptions(serverPath: string | undefined): CodexOptions {
  return serverPath ? { config: { mcp_servers: { vex: { command: process.execPath, args: [serverPath, 'mcp', 'serve'], env_vars: process.env.VEX_STATS_PATH ? ['OPENROUTER_API_KEY', 'VEX_STATS_PATH'] : ['OPENROUTER_API_KEY'] } } } } : {};
}
export class SdkRunner implements CodexRunner {
  private codex: Codex;
  constructor(options: CodexOptions = codexOptions(vexServerPath()), private readonly onEvent?: (event: ThreadEvent) => void | Promise<void>) {
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
      // Session keys are case-folded on Windows; the native sandbox needs the
      // filesystem's actual path casing when it builds its writable roots.
      workingDirectory: await realpath(project),
      sandboxMode: mode === "side" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      model: route.model,
      modelReasoningEffort: route.effort,
      additionalDirectories: mode === "main" ? trustedFolders : [],
    };
    const thread = threadId
      ? this.codex.resumeThread(threadId, options)
      : this.codex.startThread(options);
    const { events } = await thread.runStreamed(mode === "side" ? prompt : artifactPrompt(prompt), { signal });
    let result = "";
    let completed = false;
    let failure: string | undefined;
    let usage: Usage | undefined;
    for await (const event of events) {
      await this.onEvent?.(event);
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
