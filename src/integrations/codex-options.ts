import type { CodexOptions } from "@openai/codex-sdk";

export const VEX_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "JEV_API_KEY",
  "VEX_STATS_PATH",
  "JEV_STATS_PATH",
  "TYPESAFE_BASE_URL",
  "OPENROUTER_BASE_URL",
  "TYPESAFE_MODEL",
  "OPENROUTER_MODEL",
  "JEV_PROVIDER",
  "VEX_PROVIDER",
];

export function codexOptions(serverPath: string | undefined): CodexOptions {
  return serverPath
    ? {
        config: {
          mcp_servers: {
            vex: {
              command: process.execPath,
              args: [serverPath, "mcp", "serve"],
              env_vars: VEX_ENV_VARS,
            },
          },
        },
      }
    : {};
}
