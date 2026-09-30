import type { Usage } from "@openai/codex-sdk";
import type { ApprovalMode, Route, Task } from "../shared/types.js";
import type { ContextMeasurement } from "../shared/types.js";

export type ApprovalDecision = "accept" | "decline";
export type Progress =
  | { kind: "status" | "message" | "error" | "thread" | "system"; text: string }
  | { kind: "route"; route: Route }
  | { kind: "usage"; usage: Usage }
  | { kind: "activity"; id: string; category: "thinking" | "command" | "files" | "tool" | "search" | "plan"; title: string; detail?: string; completed: boolean }
  | { kind: "tasks"; items: Pick<Task, "text" | "completed">[] }
  | { kind: "approval"; id: string; command: string; cwd?: string; reason?: string; network?: boolean; respond: (decision: ApprovalDecision) => void };
export type Execution = {
  threadId?: string;
  result: string;
  completed: boolean;
  usage?: Usage;
  context?: ContextMeasurement;
};
export class CodexRunError extends Error {
  constructor(message: string, readonly usage?: Usage, readonly context?: ContextMeasurement) {
    super(message);
    this.name = "Error";
  }
}
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
    approvalMode?: ApprovalMode,
  ): Promise<Execution>;
}
