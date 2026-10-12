import type { ModelOption, TurnSummary } from "../shared/types.js";
import { modelName } from "./turn-format.js";

const routeName = (model?: string, effort?: string) =>
  [model ? modelName({ model }) : undefined, effort ? effort[0]!.toUpperCase() + effort.slice(1) : undefined]
    .filter(Boolean)
    .join(" ") || "unknown route";

function describeChoice(choice: string): string {
  if (choice === "single") return "one execution stage";
  if (choice === "scout") return "read only scan, then implementation";
  if (choice === "plan") return "save a read-only plan";
  if (choice === "scout_plan") return "read-only scan, then saved plan";
  if (choice === "clarify") return "ask for clarification";
  return /^\d+:[a-z]+$/.test(choice) ? `saved choice ${choice} (model label unavailable)` : choice;
}

/** Explain the latest persisted routing assessments and the route Pace used. */
export function formatLatestRoute(turns: TurnSummary[], _models: ModelOption[] = []): string[] {
  const turn = turns.at(-1);
  if (!turn) return ["No recorded turns yet."];

  const lines = [`Latest request: ${turn.prompt.replace(/\s+/g, " ").slice(0, 160)}${turn.prompt.length > 160 ? "…" : ""}`];
  const records = turn.routing ?? [];
  if (records.length) {
    lines.push("Vex decisions:");
    records.forEach((record) => {
      const probs = Object.entries(record.probabilities).sort((a, b) => b[1] - a[1]);
      const confidence = `${Math.round(record.confidence * 100)}% confidence`;
      const margin = probs.length > 1 ? `, ${Math.round((probs[0]![1] - probs[1]![1]) * 100)} point lead` : "";
      const choice = record.choiceLabel ?? describeChoice(record.choice);
      lines.push(`  ${record.objective}: ${choice} (${confidence}${margin}; ${record.attempts} attempt${record.attempts === 1 ? "" : "s"})`);
      if (record.objective === "workflow") lines.push(`  Workflow: ${choice}.`);
    });
  } else if (turn.routeNote?.toLowerCase().includes("manual")) {
    lines.push("Vex decisions: none; routing was manual.");
  } else {
    lines.push("Vex decisions: none recorded for this turn.");
  }

  const stages = turn.stages ?? [];
  if (stages.length > 1) {
    lines.push("Execution stages:");
    stages.forEach((stage) => lines.push(`  ${stage.objective}: ${routeName(stage.route.model, stage.route.effort)}${stage.durationMs ? ` · ${(stage.durationMs / 1000).toFixed(1)}s` : ""}`));
  }
  lines.push(`Route used: ${routeName(turn.route?.model, turn.route?.effort)}.`);
  if (turn.routeNote) lines.push(`Route note: ${turn.routeNote}.`);
  return lines;
}
