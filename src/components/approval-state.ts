export function conversationState(running: boolean, pendingApproval: boolean, pendingQuestion = false): "running" | "approval" | "question" | "done" {
  if (pendingApproval) return "approval";
  if (pendingQuestion) return "question";
  return running ? "running" : "done";
}
