import type { CodexOptions } from "@openai/codex-sdk";

export function codexOptions(serverPath: string | undefined): CodexOptions {
  return serverPath ? { config: { mcp_servers: { vex: { command: process.execPath, args: [serverPath, 'mcp', 'serve'], env_vars: process.env.VEX_STATS_PATH ? ['OPENROUTER_API_KEY', 'VEX_STATS_PATH'] : ['OPENROUTER_API_KEY'] } } } } : {};
}
