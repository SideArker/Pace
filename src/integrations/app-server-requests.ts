import { commandRisk } from "../core/command-protection.js";
import type { ApprovalDecision, Progress, RunnerMode, UserAnswers, UserQuestion } from "./codex-types.js";
import { isRecord, type AppServerConnection } from "./app-server-process.js";

export function registerAppServerRequests(
  server: AppServerConnection,
  mode: RunnerMode,
  onProgress: (progress: Progress) => void | Promise<void>,
  approvals: Map<string, (decision: ApprovalDecision) => void>,
  questions: Map<string, (answers: UserAnswers) => void>,
): void {
  server.setRequestHandler(message => {
    if (message.id === undefined) return;
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "item/tool/requestUserInput") {
      const parsed: UserQuestion[] = Array.isArray(params.questions) ? params.questions.flatMap(value => {
        if (!isRecord(value) || typeof value.id !== "string" || typeof value.question !== "string") return [];
        return [{
          id: value.id,
          header: typeof value.header === "string" ? value.header : "Question",
          question: value.question,
          options: Array.isArray(value.options) ? value.options.flatMap(option =>
            isRecord(option) && typeof option.label === "string"
              ? [{ label: option.label, description: typeof option.description === "string" ? option.description : "" }]
              : []) : [],
          isOther: value.isOther === true,
          isSecret: value.isSecret === true,
        }];
      }) : [];
      if (mode === "side" || !parsed.length || new Set(parsed.map(item => item.id)).size !== parsed.length) {
        server.respond(message.id, { answers: {} });
        return;
      }
      const requestId = message.id;
      const key = String(requestId);
      const resolve = (answers: UserAnswers) => {
        if (!questions.delete(key)) return;
        server.respond(requestId, { answers });
      };
      questions.set(key, resolve);
      void onProgress({ kind: "question", id: key, questions: parsed, respond: resolve });
      return;
    }
    const isCommandApproval = message.method === "item/commandExecution/requestApproval";
    const isFileApproval = message.method === "item/fileChange/requestApproval";
    if (!isCommandApproval && !isFileApproval) {
      server.respond(message.id, { decision: "decline" });
      return;
    }
    if (mode !== "main") {
      server.respond(message.id, { decision: "decline" });
      return;
    }
    if (isCommandApproval && typeof params.command === "string" && commandRisk(params.command).action === "block") {
      server.respond(message.id, { decision: "decline" });
      void onProgress({ kind: "status", text: `Blocked command: ${params.command}` });
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
}
