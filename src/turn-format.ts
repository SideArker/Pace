import type { Usage } from "@openai/codex-sdk";
import type { Route } from "./types.js";

const compact = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count);
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function modelName(route?: Route): string {
  const model = route?.model ?? "Codex default";
  const family = /^gpt-[\d.]+-(.+)$/.exec(model)?.[1];
  return family ? title(family) : model;
}

function routeSource(note?: string): string {
  if (!note) return "saved";
  if (note.startsWith("Selected by Vex")) return "auto";
  if (note.startsWith("Selected from Vex model consensus")) return "auto (consensus)";
  if (note.startsWith("Policy fallback")) return "auto (policy)";
  if (note.startsWith("Vex abstained") || note.startsWith("Auto needs") || note.startsWith("Vex supports")) return "auto (default)";
  if (note.includes("manual") || note === "Manual route" || note === "Configured default") return "manual";
  return "saved";
}

export function formatTurnFooter(route?: Route, note?: string, usage?: Usage, durationMs?: number): string {
  const model = modelName(route);
  const first = [model, title(route?.effort ?? "default")];
  if (durationMs !== undefined) first.push(`${(durationMs / 1000).toFixed(1)}s`);
  if (usage) first.push(`${compact(usage.input_tokens)} input`, `${compact(usage.output_tokens)} output`);
  const second = [usage ? `Cache: ${compact(usage.cached_input_tokens)} hit` : undefined, `Route: ${routeSource(note)} → ${model}`].filter(Boolean);
  return `↳ ${first.join(" · ")}\n${second.join(" · ")}`;
}
