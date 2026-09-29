import type { Usage } from "@openai/codex-sdk";
import type { Session, TurnSummary } from "../shared/types.js";
import type { RoutingPrompts } from "./routing/routing-prompts.js";
import type { StageRecord } from "./orchestrator.js";
export async function awaitRouting<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException("This operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
export function addUsage(stages: StageRecord[]): Usage | undefined {
  const values = stages.map((stage) => stage.usage);
  if (values.some((value) => !value)) return undefined;
  return values.reduce<Usage>(
    (sum, usage) => ({
      input_tokens: sum.input_tokens + usage!.input_tokens,
      cached_input_tokens: sum.cached_input_tokens + usage!.cached_input_tokens,
      cache_write_input_tokens:
        sum.cache_write_input_tokens + usage!.cache_write_input_tokens,
      output_tokens: sum.output_tokens + usage!.output_tokens,
      reasoning_output_tokens:
        sum.reasoning_output_tokens + usage!.reasoning_output_tokens,
    }),
    {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
  );
}
export function handoffPrompt(
  kind: "scout" | "plan_execute",
  request: string,
  turns: TurnSummary[],
  prompts: RoutingPrompts,
): string {
  const objective =
    kind === "scout"
      ? prompts.handoff.scoutObjective
      : prompts.handoff.planObjective;
  const conversation = turns
    .slice(-6)
    .map((turn) => ({ user: turn.prompt, assistant: turn.result }));
  return `${objective} ${prompts.handoff.instructions}\n\n${prompts.handoff.recentConversationLabel}\n${JSON.stringify(conversation)}\n\n${prompts.handoff.originalRequestLabel}\n${request}`;
}
export function retainedConversationPrompt(prompt: string, session: Session): string {
  if (session.threadId) return prompt;
  const turns = session.turns
    .filter((turn) => !turn.failed)
    .map((turn) => ({ user: turn.prompt, assistant: turn.result }));
  if (!turns.length) return prompt;
  return `Continue this conversation using only the retained exchanges below. The current user request follows the history.\n\nRetained conversation:\n${JSON.stringify(turns)}\n\nCurrent user request:\n${prompt}`;
}
export function structuredHandoff(result: string): string {
  const cleaned = result
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error(
      "Planning or scout agent did not return structured JSON handoff",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid stage handoff");
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== "string" ||
    !record.summary.trim() ||
    !Array.isArray(record.findings) ||
    record.findings.length > 12 ||
    !record.findings.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const finding = item as Record<string, unknown>;
      return (
        typeof finding.path === "string" &&
        !!finding.path.trim() &&
        (finding.line === undefined ||
          (typeof finding.line === "number" &&
            Number.isInteger(finding.line) &&
            finding.line > 0)) &&
        typeof finding.finding === "string" &&
        !!finding.finding.trim() &&
        typeof finding.relevance === "string" &&
        !!finding.relevance.trim()
      );
    }) ||
    !["nextSteps", "checks", "risks"].every(
      (key) =>
        Array.isArray(record[key]) &&
        (record[key] as unknown[]).every((item) => typeof item === "string"),
    )
  )
    throw new Error("Invalid stage handoff");
  const handoff = JSON.stringify({
    summary: record.summary,
    findings: record.findings.map((item) => {
      const finding = item as Record<string, unknown>;
      return {
        path: finding.path,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        finding: finding.finding,
        relevance: finding.relevance,
      };
    }),
    nextSteps: record.nextSteps,
    checks: record.checks,
    risks: record.risks,
  });
  if (handoff.length > 20_000)
    throw new Error("Stage handoff exceeds 20,000 characters");
  return handoff;
}
