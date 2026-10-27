import type { Progress } from "./codex-types.js";
import { isRecord } from "../shared/config.js";
import { isAbsolute, relative } from "node:path";

type JsonRecord = Record<string, unknown>;

function toolTitle(server: string, tool: string, args: unknown): string {
  let input: JsonRecord = isRecord(args) ? args : {};
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (isRecord(parsed)) input = parsed;
    } catch { /* Display tool name when arguments are not JSON. */ }
  }
  const target = [input.path, input.file_path, input.filePath, input.command, input.cmd, input.query]
    .find(value => typeof value === "string");
  const name = /read/i.test(tool) ? "Read" : /edit|write|patch/i.test(tool) ? "Edit"
    : /exec|command|shell|bash/i.test(tool) ? "Bash" : /search/i.test(tool) ? "Search" : "Tool";
  return `${name}(${target ?? `${server}/${tool}`})`;
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
    outcome: item.status === "failed" ? "failure" : "success",
  };
}

export function reasoningSummaryParts(summary: unknown): string[] {
  if (typeof summary === "string") return [summary];
  if (!Array.isArray(summary)) return [];
  return summary.map(part => typeof part === "string" ? part
    : isRecord(part) && part.type === "summary_text" && typeof part.text === "string" ? part.text : "");
}

export function appPlanProgress(plan: unknown): Extract<Progress, { kind: "tasks" }> {
  const steps = Array.isArray(plan) ? plan.filter(isRecord) : [];
  return { kind: "tasks", items: steps.flatMap(step => {
    const text = step.step ?? step.text;
    return typeof text === "string" && text.trim()
      ? [{ text, completed: step.status === "completed" || step.completed === true }] : [];
  }) };
}

export function appItemProgress(item: JsonRecord, event: string, project: string): Progress | undefined {
  const id = typeof item.id === "string" ? item.id : "codex-item";
  const completed = event === "item/completed";
  switch (item.type) {
    case "reasoning": return { kind: "activity", id, category: "thinking", title: "Thinking", detail: reasoningSummaryParts(item.summary).filter(Boolean).join("\n\n") || undefined, completed };
    case "agentMessage": return typeof item.text === "string" ? { kind: "message", id, text: item.text, completed } : undefined;
    case "commandExecution": return {
      kind: "activity", id, category: "command",
      title: `${completed ? item.status === "failed" || item.status === "declined" ? "Failed" : "Ran" : "Running"}: ${String(item.command ?? "command")}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
      detail: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
      completed,
      outcome: completed ? item.status === "failed" || item.status === "declined" || (typeof item.exitCode === "number" && item.exitCode !== 0) ? "failure" : "success" : undefined,
    };
    case "fileChange": return fileChangeProgress(item, completed, project);
    case "webSearch": return { kind: "activity", id, category: "search", title: `Web search: ${String(item.query ?? "")}`, completed };
    case "mcpToolCall": return { kind: "activity", id, category: "tool", title: toolTitle(String(item.server ?? "unknown"), String(item.tool ?? "unknown"), item.arguments), completed, outcome: item.status === "failed" || item.error ? "failure" : "success" };
    case "plan": {
      const steps = Array.isArray(item.steps) ? item.steps.filter(isRecord) : [];
      if (steps.length) return appPlanProgress(steps);
      return { kind: "activity", id, category: "plan", title: "Plan", detail: typeof item.text === "string" ? item.text : undefined, completed };
    }
    default: return undefined;
  }
}
