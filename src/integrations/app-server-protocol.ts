import type { Usage } from "@openai/codex-sdk";
import type { ApprovalMode, Route } from "../shared/types.js";
import { turnImageInput } from "./image-input.js";
import { isRecord } from "../shared/config.js";
import type { RunnerMode } from "./codex-types.js";
export function appUsage(value: unknown): Usage | undefined {
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

export function appServerThreadParams(
  cwd: string,
  route: Route,
  threadId: string | undefined,
  mode: RunnerMode,
  approvalMode: ApprovalMode = "request-approval",
) {
  const policy = approvalMode === "full-access" ? "never" : approvalMode === "limited" ? "untrusted" : "on-request";
  const sandbox = approvalMode === "full-access" ? "danger-full-access" : approvalMode === "limited" ? "read-only" : "workspace-write";
  return {
    ...(threadId ? { threadId } : {}),
    ...(route.model ? { model: route.model } : {}),
    cwd,
    approvalPolicy: mode !== "main" ? "never" : policy,
    sandbox: mode === "side" ? "read-only" : mode === "planning" ? "workspace-write" : sandbox,
    serviceName: "pace",
  };
}

export function appServerTurnParams(
  prompt: string,
  cwd: string,
  route: Route,
  threadId: string,
  mode: RunnerMode,
  trustedFolders: string[],
  approvalMode: ApprovalMode = "request-approval",
  artifactDirectory?: string,
) {
  const policy = approvalMode === "full-access" ? "never" : approvalMode === "limited" ? "untrusted" : "on-request";
  return {
    threadId,
    input: turnImageInput(prompt, mode, artifactDirectory),
    cwd,
    approvalPolicy: mode !== "main" ? "never" : policy,
    sandboxPolicy: mode === "side"
      ? { type: "readOnly", networkAccess: false }
      : mode === "planning" ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : approvalMode === "full-access" ? { type: "dangerFullAccess" }
      : approvalMode === "limited" ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [cwd, ...trustedFolders], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
  };
}
