import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isRecord } from "../shared/config.js";

export type McpServerConfig = {
  name: string;
  enabled: boolean;
  transport: { type: "stdio" | "streamable_http"; command?: string; args?: string[]; url?: string; bearer_token_env_var?: string };
  authStatus?: string;
};

export function codexCommand(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

/** Keep MCP configuration, credentials, argument parsing, and OAuth owned by Codex. */
export async function runMcpCommand(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [codexCommand(), "mcp", ...(args.length ? args : ["list"])], {
    stdio: "inherit",
    windowsHide: true,
  });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>(resolve => {
      child.once("error", error => {
        console.error(`Could not run Codex MCP: ${error.message}`);
        resolve(1);
      });
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

export async function listMcpServers(project: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [codexCommand(), "mcp", "list"], {
      cwd: project,
      windowsHide: true,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

/** Capture native command output without taking over Ink's terminal. */
export async function executeMcpCommand(
  args: string[],
  project: string,
  options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(process.execPath, [codexCommand(), "mcp", ...args], {
    cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const abort = () => { child.kill(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => { stdout = (stdout + text).slice(-65_536); options.onOutput?.(text); });
  child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(-65_536); options.onOutput?.(text); });
  try {
    return await new Promise<string>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (options.signal?.aborted) reject(new Error("MCP operation cancelled."));
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || stdout.trim() || `Codex MCP exited (${code ?? "signal"}).`));
      });
    });
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function readMcpServers(project: string, signal?: AbortSignal): Promise<McpServerConfig[]> {
  const raw: unknown = JSON.parse(await executeMcpCommand(["list", "--json"], project, { signal }));
  if (!Array.isArray(raw)) throw new Error("Codex returned an invalid MCP server list.");
  return raw.map(value => {
    if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.transport) ||
      (value.transport.type !== "stdio" && value.transport.type !== "streamable_http"))
      throw new Error("Codex returned an invalid MCP server configuration.");
    const transport = value.transport;
    return {
      name: value.name,
      enabled: value.enabled !== false,
      transport: {
        type: transport.type as McpServerConfig["transport"]["type"],
        ...(typeof transport.command === "string" ? { command: transport.command } : {}),
        ...(Array.isArray(transport.args) && transport.args.every(arg => typeof arg === "string") ? { args: transport.args as string[] } : {}),
        ...(typeof transport.url === "string" ? { url: transport.url } : {}),
        ...(typeof transport.bearer_token_env_var === "string" ? { bearer_token_env_var: transport.bearer_token_env_var } : {}),
      },
      ...(typeof value.auth_status === "string" ? { authStatus: value.auth_status } : {}),
    };
  });
}
