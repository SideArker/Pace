import type { Usage } from "@openai/codex-sdk";
import type { Route } from "../shared/types.js";

export type ApprovalDecision = "accept" | "decline";
export type Progress =
  | { kind: "status" | "message" | "error" | "thread" | "system"; text: string }
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
