export function conversationState(running: boolean, pendingApproval: boolean): "running" | "approval" | "done" {
  if (pendingApproval) return "approval";
  return running ? "running" : "done";
}
