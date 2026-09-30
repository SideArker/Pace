import type { Task } from "../shared/types.js";

export function updateAgentTasks(existing: Task[] = [], items: Pick<Task, "text" | "completed">[]): Task[] {
  const previous = existing.filter(task => task.source === "agent");
  return items.slice(0, 50).map((item, index) => ({
    id: previous[index]?.text === item.text ? previous[index]!.id : `agent-${index}`,
    text: item.text.slice(0, 500), completed: item.completed, source: "agent" as const,
  }));
}

export function taskSummary(tasks: Task[] = []): string {
  const plan = tasks.filter(task => task.source === "agent");
  if (!plan.length) return "Codex has not published a plan for this conversation.";
  return plan.map((task, index) => `${index + 1}. ${task.completed ? "✓" : "○"} ${task.text}`).join("\n");
}
