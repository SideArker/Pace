import type { Usage } from "@openai/codex-sdk";
import type { ApprovalMode, Route, Task } from "../shared/types.js";
import type { ContextMeasurement } from "../shared/types.js";

export type ApprovalDecision = "accept" | "decline";
export type UserQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[]; isOther: boolean; isSecret: boolean };
export type UserAnswers = Record<string, { answers: string[] }>;
export type Progress = (
  | { kind: "steering"; steer?: (prompt: string) => Promise<void> }
  | { kind: "status" | "message" | "error" | "thread" | "system"; text: string }
  | { kind: "route"; route: Route }
  | { kind: "usage"; usage: Usage }
  | { kind: "activity"; id: string; category: "thinking" | "command" | "files" | "tool" | "search" | "plan"; title: string; detail?: string; completed: boolean; outcome?: "success" | "failure" }
  | { kind: "tasks"; items: Pick<Task, "text" | "completed">[] }
  | { kind: "question"; id: string; questions: UserQuestion[]; respond: (answers: UserAnswers) => void }
  | { kind: "questionResolved"; id: string }
  | { kind: "approval"; id: string; command: string; cwd?: string; reason?: string; network?: boolean; respond: (decision: ApprovalDecision) => void })
 & { taskId?: string; role?: import("../shared/types.js").AgentRole; attemptId?: string };
export type Execution = {
  threadId?: string;
  result: string;
  completed: boolean;
  turnId?: string;
  route?: Route;
  knownUsage?: Usage;
  usageComplete?: boolean;
  usage?: Usage;
  context?: ContextMeasurement;
};
export class CodexRunError extends Error {
  constructor(message: string, readonly usage?: Usage, readonly context?: ContextMeasurement, readonly accounting?: { threadId?: string; turnId?: string; route: Route; knownUsage?: Usage; usageComplete: boolean }) {
    super(message);
    this.name = "Error";
  }
}
export type RunnerMode = "main" | "side" | "planning";
export interface CodexRunner {
  run(
    prompt: string,
    project: string,
    route: Route,
    threadId: string | undefined,
    onProgress: (progress: Progress) => void | Promise<void>,
    signal?: AbortSignal,
    mode?: RunnerMode,
    trustedFolders?: string[],
    approvalMode?: ApprovalMode,
    artifactDirectory?: string,
  ): Promise<Execution>;
}
