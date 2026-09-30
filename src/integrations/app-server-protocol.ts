import type { Usage } from "@openai/codex-sdk";
import type { ApprovalMode, Route } from "../shared/types.js";
import { artifactPrompt } from "../core/system/artifacts.js";
import { isRecord } from "../shared/config.js";
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
  mode: "main" | "side",
  approvalMode: ApprovalMode = "request-approval",
) {
  const policy = approvalMode === "full-access" ? "never" : approvalMode === "limited" ? "untrusted" : "on-request";
  const sandbox = approvalMode === "full-access" ? "danger-full-access" : approvalMode === "limited" ? "read-only" : "workspace-write";
  return {
    ...(threadId ? { threadId } : {}),
    ...(route.model ? { model: route.model } : {}),
    cwd,
    approvalPolicy: mode === "side" ? "never" : policy,
    sandbox: mode === "side" ? "read-only" : sandbox,
    serviceName: "pace",
  };
}

export function appServerTurnParams(
  prompt: string,
  cwd: string,
  route: Route,
  threadId: string,
  mode: "main" | "side",
  trustedFolders: string[],
  approvalMode: ApprovalMode = "request-approval",
) {
  const policy = approvalMode === "full-access" ? "never" : approvalMode === "limited" ? "untrusted" : "on-request";
  return {
    threadId,
    input: [{ type: "text", text: mode === "side" ? prompt : artifactPrompt(prompt) }],
    cwd,
    approvalPolicy: mode === "side" ? "never" : policy,
    sandboxPolicy: mode === "side"
      ? { type: "readOnly", networkAccess: false }
      : approvalMode === "full-access" ? { type: "dangerFullAccess" }
      : approvalMode === "limited" ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [cwd, ...trustedFolders], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    ...(route.model ? { model: route.model } : {}),
    ...(route.effort ? { effort: route.effort } : {}),
  };
}
