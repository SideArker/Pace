import type { Route, Session } from "../shared/types.js";
import type { CodexRunner, RunnerMode } from "../integrations/codex-types.js";

export type PromptSection = { source: string; text: string; replaced?: string };
export type PromptTrace = {
  version: 1;
  request: string;
  workflow?: string;
  sections: PromptSection[];
  calls: { mode: RunnerMode; route: Route; assembledPrompt: string; resumedThreadId?: string; threadId?: string; input?: unknown[] }[];
  vex: { objective: string; request: unknown; decision?: unknown; error?: string }[];
};

/** Remove credentials before persistence or display; secret question values are supplied separately. */
export function redactTrace<T>(value: T, secrets: string[] = []): T {
  secrets = [...secrets, ...Object.entries(process.env).flatMap(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) && value && value.length >= 4 ? [value] : [])];
  const redact = (text: string) => {
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
    return text
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
      .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted credential]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\n]+)/gi, "$1[redacted]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@");
  };
  const visit = (item: unknown): unknown => typeof item === "string" ? redact(item)
    : Array.isArray(item) ? item.map(visit)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, val]) => [redact(key), /^(?:.*[_-])?(?:password|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key)$/i.test(key) ? "[redacted]" : visit(val)]))
    : item;
  return visit(value) as T;
}

/** Record the changed region, preserving insertion provenance without duplicating the whole prompt. */
export function promptChange(source: string, before: string, after: string): PromptSection[] {
  if (before === after) return [];
  let first = 0, last = 0;
  while (first < Math.min(before.length, after.length) && before[first] === after[first]) first++;
  while (last < Math.min(before.length, after.length) - first && before[before.length - last - 1] === after[after.length - last - 1]) last++;
  return [{ source, text: after.slice(first, after.length - last), ...(before.length - last > first ? { replaced: before.slice(first, before.length - last) } : {}) }];
}

export function tracedRunner(runner: CodexRunner, trace: PromptTrace): CodexRunner {
  return { async run(...args) {
    const call: PromptTrace["calls"][number] = redactTrace({ mode: args[6] ?? "main", route: args[2], assembledPrompt: args[0], resumedThreadId: args[3] });
    trace.calls.push(call);
    const output = args[4];
    args[4] = progress => {
      if (progress.kind === "prompt") { call.input = redactTrace(progress.input); call.threadId = progress.threadId; return; }
      if (progress.kind === "thread") call.threadId = progress.text;
      // Secret questions never enter the trace, including their headers and option values.
      return output(progress);
    };
    const result = await runner.run(...args);
    call.threadId = result.threadId ?? call.threadId;
    return result;
  } };
}

export function debugTurn(session: Session, index = session.turns.length - 1): string {
  const turn = session.turns[index];
  if (!turn) return "No saved turn selected.";
  const trace = turn.promptTrace;
  if (!trace) return `Turn ${index + 1}: legacy turn; effective Codex input was not recorded.\nUser request:\n${redactTrace(turn.prompt)}\nRouting decisions:\n${JSON.stringify(redactTrace(turn.routing ?? []), null, 2)}`;
  return redactTrace([
    `Turn ${index + 1} · local read-only trace · redacted where needed`,
    `User request:\n${trace.request}`,
    `Workflow: ${trace.workflow ?? "unavailable"}`,
    "Pace-added sections (source and exact changed text):",
    ...trace.sections.map(section => `${section.source}:\n${section.text}${section.replaced ? `\nReplaced:\n${section.replaced}` : ""}`),
    ...trace.calls.map((call, i) => `Codex call ${i + 1} · ${call.mode} · ${call.route.model} / ${call.route.effort}\nResumed thread: ${call.resumedThreadId ?? "none (fresh; retained history may be in input)"}\nActual thread: ${call.threadId ?? "unavailable"}\nAssembled runner prompt:\n${call.assembledPrompt}\nActual turn/start input:\n${call.input ? JSON.stringify(call.input, null, 2) : "Unavailable: transport did not emit input; assembled prompt above is not proof of turn/start."}`),
    "Vex request / validated decision (separate decision agent; this is NOT Codex input):",
    JSON.stringify(trace.vex, null, 2),
  ].join("\n\n"));
}

export function isPromptTrace(value: unknown): value is PromptTrace {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  return record(value) && value.version === 1 && typeof value.request === "string" &&
    (value.workflow === undefined || typeof value.workflow === "string") &&
    Array.isArray(value.sections) && value.sections.every(item => record(item) && typeof item.source === "string" && typeof item.text === "string" && (item.replaced === undefined || typeof item.replaced === "string")) &&
    Array.isArray(value.calls) && value.calls.every(item => record(item) && ["main", "side", "planning"].includes(String(item.mode)) && record(item.route) && typeof item.assembledPrompt === "string" &&
      ["threadId", "resumedThreadId"].every(key => item[key] === undefined || typeof item[key] === "string") && (item.input === undefined || Array.isArray(item.input))) &&
    Array.isArray(value.vex) && value.vex.every(item => record(item) && typeof item.objective === "string" && (item.error === undefined || typeof item.error === "string"));
}
