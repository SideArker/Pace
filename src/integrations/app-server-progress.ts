import type { Progress } from "./codex-types.js";
import { isRecord, type JsonRecord } from "./app-server-process.js";
import { appItemProgress, appPlanProgress, reasoningSummaryParts } from "./codex-events.js";

/** Per-turn snapshots keep deltas and authoritative item completion on the same progress path. */
export class AppServerProgress {
  private items = new Map<string, JsonRecord>();
  private summaries = new Map<string, Map<number, string>>();

  constructor(private readonly project: string) {}

  observe(method: string, params: JsonRecord): Progress | undefined {
    if (method === "turn/plan/updated" && Array.isArray(params.plan)) return appPlanProgress(params.plan);
    if (["item/started", "item/updated", "item/completed"].includes(method) && isRecord(params.item)) {
      const item = params.item;
      if (typeof item.id !== "string") return undefined;
      const snapshot = { ...this.items.get(item.id), ...item };
      this.items.set(item.id, snapshot);
      if (item.type === "reasoning" && item.summary !== undefined) {
        this.summaries.set(item.id, new Map(reasoningSummaryParts(item.summary).map((text, index) => [index, text])));
      }
      const progress = appItemProgress(snapshot, method, this.project);
      if (method === "item/completed") {
        this.items.delete(item.id);
        this.summaries.delete(item.id);
      }
      return progress;
    }
    if (typeof params.itemId !== "string") return undefined;
    const id = params.itemId;
    const previous = this.items.get(id);
    let snapshot: JsonRecord;
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      snapshot = { ...previous, id, type: "agentMessage", text: String(previous?.text ?? "") + params.delta };
    } else if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      snapshot = { ...previous, id, type: "commandExecution", aggregatedOutput: String(previous?.aggregatedOutput ?? "") + params.delta };
    } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded") {
      const index = params.summaryIndex;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
      const parts = this.summaries.get(id) ?? new Map<number, string>();
      if (method === "item/reasoning/summaryTextDelta") {
        if (typeof params.delta !== "string") return undefined;
        parts.set(index, (parts.get(index) ?? "") + params.delta);
      } else if (!parts.has(index)) parts.set(index, "");
      this.summaries.set(id, parts);
      snapshot = { ...previous, id, type: "reasoning", summary: [...parts].sort(([a], [b]) => a - b).map(([, text]) => text) };
    } else return undefined;
    this.items.set(id, snapshot);
    return appItemProgress(snapshot, "item/updated", this.project);
  }
}
