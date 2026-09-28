import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { Route } from "../shared/types.js";
import { realpath } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { artifactPrompt } from "../core/system/artifacts.js";
import { vexServerPath } from '../core/vex/client.js';
export type ApprovalDecision = "accept" | "decline";
export type Progress =
  | { kind: "status" | "message" | "error" | "thread"; text: string }
  | { kind: "route"; route: Route }
  | { kind: "activity"; id: string; category: "thinking" | "command" | "files" | "tool" | "search" | "plan"; title: string; detail?: string; completed: boolean }
  | { kind: "approval"; id: string; command: string; cwd?: string; reason?: string; network?: boolean; respond: (decision: ApprovalDecision) => void };
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

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexCommand(): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@openai/codex/package.json");
  return join(dirname(packagePath), "bin", "codex.js");
}

function serverArgs(): string[] {
  const serverPath = vexServerPath();
  const args = [
    "--config", 'approvals_reviewer="user"',
    "--config", 'rules.prefix_rules=[{ pattern = [{ token = "git" }, { any_of = ["push", "reset"] }], decision = "prompt", justification = "Publishing or resetting Git history requires your approval." }]',
  ];
  if (serverPath) args.unshift(
    "--config", `mcp_servers.vex.command=${tomlString(process.execPath)}`,
    "--config", `mcp_servers.vex.args=[${[serverPath, "mcp", "serve"].map(tomlString).join(", ")}]`,
    "--config", `mcp_servers.vex.env_vars=[${(process.env.VEX_STATS_PATH ? ["OPENROUTER_API_KEY", "VEX_STATS_PATH"] : ["OPENROUTER_API_KEY"]).map(tomlString).join(", ")}]`,
  );
  return args;
}

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestHandler?: (message: RpcMessage) => void;
  private stderr = "";

  constructor(onMessage: (message: RpcMessage) => void) {
    this.child = spawn(process.execPath, [codexCommand(), "app-server", "--stdio", ...serverArgs()], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      if (message.method && message.id !== undefined) this.requestHandler?.(message);
      else if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
        else pending.resolve(message.result);
      }
      else if (message.method) onMessage(message);
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.on("error", error => this.rejectPending(error));
    this.child.on("close", code => this.rejectPending(new Error(`Codex app-server exited (${code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }

  setRequestHandler(handler: (message: RpcMessage) => void): void { this.requestHandler = handler; }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }
  respond(id: number | string, result: unknown): void { this.write({ id, result }); }
  kill(): void { this.child.kill(); }

  private write(message: unknown): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function appUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const last = isRecord(value.last) ? value.last : value;
  const number = (snake: string, camel: string) => {
    const found = last[snake] ?? last[camel];
    return typeof found === "number" && Number.isFinite(found) ? found : undefined;
  };
  const input = number("input_tokens", "inputTokens");
  const output = number("output_tokens", "outputTokens");
  if (input === undefined || output === undefined) return undefined;
  return {
    input_tokens: input,
    cached_input_tokens: number("cached_input_tokens", "cachedInputTokens") ?? 0,
    cache_write_input_tokens: number("cache_write_input_tokens", "cacheWriteInputTokens") ?? 0,
    output_tokens: output,
    reasoning_output_tokens: number("reasoning_output_tokens", "reasoningOutputTokens") ?? 0,
  };
}

function appItemProgress(item: JsonRecord, event: string): Progress | undefined {
  const id = typeof item.id === "string" ? item.id : "codex-item";
  const completed = event === "item/completed";
  switch (item.type) {
    case "reasoning": return { kind: "activity", id, category: "thinking", title: "Thinking", detail: typeof item.summary === "string" ? item.summary : undefined, completed };
    case "agentMessage": return completed && typeof item.text === "string" ? { kind: "message", text: item.text } : undefined;
    case "commandExecution": return {
      kind: "activity", id, category: "command",
      title: `${completed ? item.status === "failed" || item.status === "declined" ? "Failed" : "Ran" : "Running"}: ${String(item.command ?? "command")}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
      detail: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      completed,
    };
    case "fileChange": return {
      kind: "activity", id, category: "files",
      title: `${item.status === "failed" ? "Failed to edit" : "Edited"} ${Array.isArray(item.changes) ? item.changes.length : 0} file${Array.isArray(item.changes) && item.changes.length === 1 ? "" : "s"}`,
      detail: Array.isArray(item.changes) ? item.changes.map(change => isRecord(change) ? `${String(change.kind)} ${String(change.path)}` : "").join("\n") : undefined,
      completed,
    };
    case "webSearch": return { kind: "activity", id, category: "search", title: `Web search: ${String(item.query ?? "")}`, completed };
    case "mcpToolCall": return { kind: "activity", id, category: "tool", title: `Tool ${String(item.server)}/${String(item.tool)}: ${String(item.status)}`, completed };
    case "plan": return { kind: "activity", id, category: "plan", title: "Plan", detail: typeof item.text === "string" ? item.text : undefined, completed };
    default: return undefined;
  }
}

export class AppServerRunner implements CodexRunner {
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
    if (signal?.aborted) throw new Error("Turn cancelled");
    const { realpath } = await import("node:fs/promises");
    const cwd = await realpath(project);
    let result = "";
    let usage: Usage | undefined;
    let thread: JsonRecord | undefined;
    let failure: string | undefined;
    let completed = false;
    let turnResolve!: () => void;
    const turnDone = new Promise<void>(resolve => { turnResolve = resolve; });
    const server = new AppServer(message => {
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : {};
        usage = appUsage(params.tokenUsage) ?? appUsage(turn.tokenUsage) ?? appUsage(turn.usage) ?? usage;
        if (turn.status === "failed" || turn.status === "interrupted") failure = isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : `Codex turn ${String(turn.status)}`;
        completed = turn.status === "completed";
        turnResolve();
        return;
      }
      if (message.method === "thread/tokenUsage/updated") usage = appUsage(params.tokenUsage) ?? usage;
      if (message.method === "error") {
        failure = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error";
        turnResolve();
        return;
      }
      const item = isRecord(params.item) ? params.item : undefined;
      if (!item) return;
      if (item.type === "agentMessage" && message.method === "item/completed" && typeof item.text === "string") result = item.text;
      const progress = appItemProgress(item, message.method ?? "");
      if (progress) {
        void onProgress(progress);
      }
    });
    const approvals = new Map<string, (decision: ApprovalDecision) => void>();
    server.setRequestHandler(message => {
      if (message.id === undefined) return;
      const params = isRecord(message.params) ? message.params : {};
      const isCommandApproval = message.method === "item/commandExecution/requestApproval";
      const isFileApproval = message.method === "item/fileChange/requestApproval";
      if (!isCommandApproval && !isFileApproval) {
        server.respond(message.id, { decision: "decline" });
        return;
      }
      const requestId = message.id;
      const approvalId = String(requestId);
      const resolve = (decision: ApprovalDecision) => {
        if (!approvals.delete(approvalId)) return;
        server.respond(requestId, { decision });
      };
      approvals.set(approvalId, resolve);
      const networkContext = isRecord(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
      const networkTarget = networkContext
        ? `${String(networkContext.host ?? "host")}${networkContext.protocol ? ` (${String(networkContext.protocol)})` : ""}`
        : undefined;
      void onProgress({
        kind: "approval",
        id: String(params.itemId ?? requestId),
        command: isFileApproval
          ? "Codex requests permission to modify files"
          : typeof params.command === "string" ? params.command : networkTarget ? `Network access to ${networkTarget}` : "Codex requests permission to run a command",
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        reason: typeof params.reason === "string" ? params.reason : undefined,
        network: !!networkContext,
        respond: resolve,
      });
    });
    try {
      const init = await server.request("initialize", {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      void init;
      server.notify("initialized", {});
      const threadResult = await server.request(threadId ? "thread/resume" : "thread/start", {
        ...(threadId ? { threadId } : {}),
        ...(route.model ? { model: route.model } : {}),
        cwd,
        approvalPolicy: mode === "side" ? "never" : "on-request",
        sandbox: mode === "side" ? "read-only" : "workspace-write",
        serviceName: "pace",
      });
      thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : undefined;
      const id = typeof thread?.id === "string" ? thread.id : threadId;
      if (!id) throw new Error("Codex app-server did not return a thread id");
      await onProgress({ kind: "thread", text: id });
      const writableRoots = [cwd, ...(mode === "main" ? trustedFolders : [])];
      const abortTurn = () => {
        for (const resolve of approvals.values()) resolve("decline");
        void server.request("turn/interrupt", { threadId: id }).catch(() => {});
      };
      signal?.addEventListener("abort", abortTurn, { once: true });
      try {
        await onProgress({ kind: "status", text: "Working…" });
        await server.request("turn/start", {
          threadId: id,
          input: [{ type: "text", text: mode === "side" ? prompt : artifactPrompt(prompt) }],
          cwd,
          approvalPolicy: mode === "side" ? "never" : "on-request",
          sandboxPolicy: mode === "side" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
          ...(route.model ? { model: route.model } : {}),
          ...(route.effort ? { effort: route.effort } : {}),
        });
        await turnDone;
      } finally { signal?.removeEventListener("abort", abortTurn); }
      if (failure) throw new Error(failure);
      if (!completed) throw new Error("Codex stream ended without turn.completed");
      return { threadId: id, result: result || "Codex completed without a final message.", completed, usage };
    } finally { server.kill(); }
  }
}

/** Direct TypeScript SDK runner retained for SDK-focused integrations. */
export class SdkRunner implements CodexRunner {
  private codex: Codex;

  constructor(options: CodexOptions = codexOptions(vexServerPath())) {
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
