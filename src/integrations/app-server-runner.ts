import type { ApprovalMode, Route } from "../shared/types.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Usage } from "@openai/codex-sdk";
import { artifactPrompt } from "../core/system/artifacts.js";
import { CodexRunError, type ApprovalDecision, type CodexRunner, type Execution, type Progress } from "./codex-types.js";
import { AppServer, isRecord, type AppServerConnection, type JsonRecord } from "./app-server-process.js";
import { appServerThreadParams, appServerTurnParams, appUsage } from "./app-server-protocol.js";
import { appItemProgress, fileChangeProgress } from "./codex-events.js";
import { contextMeasurement } from "../core/context.js";

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
export type CompactionResult = {
  threadId: string;
  outcome: "completed" | "failed" | "cancelled";
  durationMs: number;
  usage?: Usage;
  error?: string;
};

function sumUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

export class AppServerRunner implements CodexRunner {
  constructor(
    private readonly createServer: (
      onMessage: (message: RpcMessage) => void,
      onExit: (error: Error) => void,
    ) => AppServerConnection = (onMessage, onExit) => new AppServer(onMessage, onExit),
  ) {}

  async compact(
    threadId: string,
    project: string,
    route: Route,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const started = performance.now();
    let usage: Usage | undefined;
    let usageKnown = true;
    let previousTotal = -1;
    let sawCompaction = false;
    let completedStatus: string | undefined;
    let failure: string | undefined;
    let compacting = false;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const server = this.createServer(message => {
      if (!compacting) return;
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "thread/tokenUsage/updated") {
        const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
        const total = isRecord(tokenUsage.total) ? tokenUsage.total.totalTokens : undefined;
        if (typeof total !== "number" || !Number.isFinite(total)) usageKnown = false;
        else if (total > previousTotal) {
          previousTotal = total;
          const last = appUsage(tokenUsage);
          if (last) usage = usage ? sumUsage(usage, last) : last;
          else usageKnown = false;
        }
      }
      if (message.method === "item/completed" && isRecord(params.item) && params.item.type === "contextCompaction") {
        sawCompaction = true;
        void onProgress({ kind: "status", text: "Context compacted; finishing…" });
      }
      if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : {};
        completedStatus = typeof turn.status === "string" ? turn.status : undefined;
        if (isRecord(turn.error) && typeof turn.error.message === "string") failure = turn.error.message;
        finish();
      }
      if (message.method === "error") {
        failure = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error";
        finish();
      }
    }, error => { failure = error.message; finish(); });
    let cancelled = !!signal?.aborted;
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancelled = true;
        void server.request("turn/interrupt", { threadId }).catch(() => {});
        reject(new Error("Compaction cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
    const race = <T,>(work: Promise<T>) => Promise.race([work, aborted]);
    try {
      if (cancelled) throw new Error("Compaction cancelled");
      const cwd = await race(realpath(project));
      await race(server.request("initialize", {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }));
      server.notify("initialized", {});
      const response = await race(server.request("thread/resume", appServerThreadParams(cwd, route, threadId, "main")));
      const resumed = isRecord(response) && isRecord(response.thread) ? response.thread.id : undefined;
      if (resumed !== threadId) throw new Error("Codex resumed a different thread");
      await race(Promise.resolve(onProgress({ kind: "status", text: "Compacting context…" })));
      compacting = true;
      await race(server.request("thread/compact/start", { threadId }));
      await race(done);
      if (failure) throw new Error(failure);
      if (completedStatus !== "completed" || !sawCompaction)
        throw new Error(`Compaction ended without a completed contextCompaction item (${completedStatus ?? "unknown"})`);
      return { threadId, outcome: "completed", durationMs: Math.round(performance.now() - started), ...(usageKnown && usage ? { usage } : {}) };
    } catch (error) {
      return {
        threadId,
        outcome: cancelled ? "cancelled" : "failed",
        durationMs: Math.round(performance.now() - started),
        ...(usageKnown && usage ? { usage } : {}),
        error: String(error),
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      server.kill();
    }
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
    approvalMode: ApprovalMode = "request-approval",
  ): Promise<Execution> {
    if (signal?.aborted) throw new Error("Turn cancelled");
    const { realpath } = await import("node:fs/promises");
    const cwd = await realpath(project);
    signal?.throwIfAborted();
    let result = "";
    let usage: Usage | undefined;
    let context: Execution["context"];
    let previousTotal: number | undefined;
    let turnStarted = false;
    let usageEvents = 0;
    let usageKnown = true;
    let thread: JsonRecord | undefined;
    let failure: string | undefined;
    let completed = false;
    let turnResolve!: () => void;
    const turnDone = new Promise<void>(resolve => { turnResolve = resolve; });
    const server = this.createServer(message => {
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "item/fileChange/patchUpdated" && typeof params.itemId === "string") {
        void onProgress(fileChangeProgress({ id: params.itemId, changes: params.changes }, false, cwd));
        return;
      }
      if (message.method === "turn/completed") {
        const turn = isRecord(params.turn) ? params.turn : {};
        if (!usageEvents) usage = appUsage(params.tokenUsage) ?? appUsage(turn.tokenUsage) ?? appUsage(turn.usage);
        if (turn.status === "failed" || turn.status === "interrupted") failure = isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : `Codex turn ${String(turn.status)}`;
        completed = turn.status === "completed";
        turnResolve();
        return;
      }
      if (message.method === "thread/tokenUsage/updated") {
        const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
        const total = isRecord(tokenUsage.total) ? tokenUsage.total.totalTokens : undefined;
        if (!turnStarted) {
          if (typeof total === "number" && Number.isFinite(total)) previousTotal = total;
        } else if (typeof total !== "number" || !Number.isFinite(total)) {
          usageKnown = false;
          context = undefined;
        } else if (previousTotal === undefined || total > previousTotal) {
          previousTotal = total;
          usageEvents++;
          const last = appUsage(tokenUsage);
          if (last) usage = usage ? sumUsage(usage, last) : last;
          else usageKnown = false;
          context = contextMeasurement(tokenUsage, route.model);
          if (usageKnown && usage) void onProgress({ kind: "usage", usage });
        }
      }
      if (message.method === "error") {
        failure = isRecord(params.error) && typeof params.error.message === "string" ? params.error.message : "Codex app-server error";
        turnResolve();
        return;
      }
      const item = isRecord(params.item) ? params.item : undefined;
      if (!item) return;
      if (item.type === "agentMessage" && message.method === "item/completed" && typeof item.text === "string") result = item.text;
      const progress = appItemProgress(item, message.method ?? "", cwd);
      if (progress) {
        void onProgress(progress);
      }
    }, error => {
      failure = error.message;
      turnResolve();
    });
    const awaitAbort = <T,>(pending: Promise<T>): Promise<T> => {
      if (!signal) return pending;
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(
          value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
        );
      });
    };
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
      const init = await awaitAbort(server.request("initialize", {
        clientInfo: { name: "pace", title: "Pace", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }));
      void init;
      server.notify("initialized", {});
      const threadResult = await awaitAbort(server.request(
        threadId ? "thread/resume" : "thread/start",
        appServerThreadParams(cwd, route, threadId, mode, approvalMode),
      ));
      thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : undefined;
      const id = typeof thread?.id === "string" ? thread.id : threadId;
      if (!id) throw new Error("Codex app-server did not return a thread id");
      signal?.throwIfAborted();
      await onProgress({ kind: "thread", text: id });
      const abortTurn = () => {
        for (const resolve of approvals.values()) resolve("decline");
        void server.request("turn/interrupt", { threadId: id }).catch(() => {});
      };
      signal?.addEventListener("abort", abortTurn, { once: true });
      try {
        signal?.throwIfAborted();
        await onProgress({ kind: "status", text: "Working…" });
        signal?.throwIfAborted();
        turnStarted = true;
        await awaitAbort(server.request("turn/start", appServerTurnParams(prompt, cwd, route, id, mode, trustedFolders, approvalMode)));
        await awaitAbort(turnDone);
      } finally { signal?.removeEventListener("abort", abortTurn); }
      if (failure) throw new Error(failure);
      if (!completed) throw new Error("Codex stream ended without turn.completed");
      return { threadId: id, result: result || "Codex completed without a final message.", completed, usage: usageKnown ? usage : undefined, context };
    } catch (error) {
      throw new CodexRunError(error instanceof Error ? error.message : String(error), usageKnown ? usage : undefined, context);
    } finally { server.kill(); }
  }
}
