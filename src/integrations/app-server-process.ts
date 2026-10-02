import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { vexServerPath } from "../core/vex/client.js";

type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
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

import { VEX_ENV_VARS } from "./codex-options.js";

export function serverArgs(): string[] {
  const serverPath = vexServerPath();
  const args = [
    "--config", 'approvals_reviewer="user"',
    "--enable", "default_mode_request_user_input",
  ];
  if (serverPath) args.unshift(
    "--config", `mcp_servers.vex.command=${tomlString(process.execPath)}`,
    "--config", `mcp_servers.vex.args=[${[serverPath, "mcp", "serve"].map(tomlString).join(", ")}]`,
    "--config", `mcp_servers.vex.env_vars=[${VEX_ENV_VARS.map(tomlString).join(", ")}]`,
  );
  return args;
}

export class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestHandler?: (message: RpcMessage) => void;
  private stderr = "";

  constructor(onMessage: (message: RpcMessage) => void, onExit: (error: Error) => void) {
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
    this.child.on("error", error => { this.rejectPending(error); onExit(error); });
    this.child.on("close", code => {
      const error = new Error(`Codex app-server exited (${code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
      this.rejectPending(error);
      onExit(error);
    });
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
export type AppServerConnection = Pick<AppServer, "setRequestHandler" | "request" | "notify" | "respond" | "kill">;
