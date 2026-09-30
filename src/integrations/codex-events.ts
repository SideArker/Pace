import type { ThreadEvent } from "@openai/codex-sdk";
import type { Progress } from "./codex-types.js";
import { isRecord } from "../shared/config.js";
import { isAbsolute, relative } from "node:path";

type JsonRecord = Record<string, unknown>;

export function eventProgress(event: ThreadEvent): Progress | undefined {
  if (event.type === "error") return { kind: "error", text: event.message };
  if (event.type === "turn.failed")
    return { kind: "error", text: event.error.message };
  if (event.type === "turn.started")
    return { kind: "status", text: "Working…" };
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  )
    return undefined;
  const item = event.item;
  if (item.type === "reasoning")
    return { kind: "activity", id: item.id, category: "thinking", title: "Thinking", detail: item.text, completed: event.type === "item.completed" };
  if (item.type === "agent_message" && event.type === "item.completed")
    return { kind: "message", text: item.text };
  if (item.type === "command_execution")
    return {
      kind: "activity", id: item.id, category: "command",
      title: `${item.status === "in_progress" ? "Running" : item.status === "failed" ? "Failed" : "Ran"}: ${item.command}${item.exit_code === undefined ? "" : ` (exit ${item.exit_code})`}`,
      detail: item.aggregated_output, completed: event.type === "item.completed",
    };
  if (item.type === "file_change")
    return {
      kind: "activity", id: item.id, category: "files",
      title: `${item.status === "failed" ? "Failed to edit" : "Edited"} ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`,
      detail: item.changes.map(change => `${change.kind} ${change.path}`).join("\n"), completed: event.type === "item.completed",
    };
  if (item.type === "web_search")
    return { kind: "activity", id: item.id, category: "search", title: `Web search: ${item.query}`, completed: event.type === "item.completed" };
  if (item.type === "mcp_tool_call")
    return {
      kind: "activity", id: item.id, category: "tool", title: `Tool ${item.server}/${item.tool}: ${item.status}`,
      detail: item.error?.message, completed: event.type === "item.completed",
    };
  if (item.type === "todo_list")
    return { kind: "tasks", items: item.items.map(step => ({ text: step.text, completed: step.completed })) };
  if (item.type === "error") return { kind: "error", text: item.message };
  return undefined;
}

export function fileChangeProgress(item: JsonRecord, completed: boolean, project: string): Progress {
  const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
  const displayPath = (path: string) => isAbsolute(path) ? relative(project, path) : path;
  const title = changes.length === 1 && typeof changes[0]?.path === "string"
    ? displayPath(changes[0].path)
    : `${changes.length} files`;
  return {
    kind: "activity",
    id: typeof item.id === "string" ? item.id : "codex-item",
    category: "files",
    title: `${item.status === "failed" ? "Failed to edit" : "Edited"} ${title}`,
    detail: changes.map(change => {
      const path = typeof change.path === "string" ? displayPath(change.path) : "";
      const diff = typeof change.diff === "string" ? change.diff.trimEnd() : "";
      return changes.length === 1 ? diff || `${String(change.kind)} ${path}` : `${path}\n${diff || String(change.kind)}`;
    }).join("\n\n"),
    completed,
  };
}

export function appItemProgress(item: JsonRecord, event: string, project: string): Progress | undefined {
  const id = typeof item.id === "string" ? item.id : "codex-item";
  const completed = event === "item/completed";
  switch (item.type) {
    case "reasoning": return { kind: "activity", id, category: "thinking", title: "Thinking", detail: typeof item.summary === "string" ? item.summary : undefined, completed };
    case "agentMessage": return completed && typeof item.text === "string" ? { kind: "message", text: item.text } : undefined;
    case "commandExecution": return {
      kind: "activity", id, category: "command",
      title: `${completed ? item.status === "failed" || item.status === "declined" ? "Failed" : "Ran" : "Running"}: ${String(item.command ?? "command")}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
      detail: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      completed,
    };
    case "fileChange": return fileChangeProgress(item, completed, project);
    case "webSearch": return { kind: "activity", id, category: "search", title: `Web search: ${String(item.query ?? "")}`, completed };
    case "mcpToolCall": return { kind: "activity", id, category: "tool", title: `Tool ${String(item.server)}/${String(item.tool)}: ${String(item.status)}`, completed };
    case "plan": {
      const steps = Array.isArray(item.steps) ? item.steps.filter(isRecord) : [];
      if (steps.length) return { kind: "tasks", items: steps.map(step => ({
        text: String(step.step ?? step.text ?? ""), completed: step.status === "completed" || step.completed === true,
      })).filter(step => step.text) };
      return { kind: "activity", id, category: "plan", title: "Plan", detail: typeof item.text === "string" ? item.text : undefined, completed };
    }
    default: return undefined;
  }
}
