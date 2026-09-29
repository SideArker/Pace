import type { Route } from "../shared/types.js";
import { isAbsolute, join } from "node:path";
import type { Usage } from "@openai/codex-sdk";
import { artifactPrompt } from "../core/system/artifacts.js";
import type { ApprovalDecision, CodexRunner, Execution, Progress } from "./codex-types.js";
import { AppServer, isRecord, type AppServerConnection, type JsonRecord } from "./app-server-process.js";
import { appServerThreadParams, appServerTurnParams, appUsage } from "./app-server-protocol.js";
import { appItemProgress, fileChangeProgress } from "./codex-events.js";

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
export class AppServerRunner implements CodexRunner {
  constructor(
    private readonly createServer: (
      onMessage: (message: RpcMessage) => void,
      onExit: (error: Error) => void,
    ) => AppServerConnection = (onMessage, onExit) => new AppServer(onMessage, onExit),
  ) {}

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
    signal?.throwIfAborted();
    let result = "";
    let usage: Usage | undefined;
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
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.then(
          value => { signal.removeEventListener("abort", onAbort); resolve(value); },
          error => { signal.removeEventListener("abort", onAbort); reject(error); },
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
        appServerThreadParams(cwd, route, threadId, mode),
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
        await awaitAbort(server.request("turn/start", appServerTurnParams(prompt, cwd, route, id, mode, trustedFolders)));
        await awaitAbort(turnDone);
      } finally { signal?.removeEventListener("abort", abortTurn); }
      if (failure) throw new Error(failure);
      if (!completed) throw new Error("Codex stream ended without turn.completed");
      return { threadId: id, result: result || "Codex completed without a final message.", completed, usage };
    } finally { server.kill(); }
  }
}
