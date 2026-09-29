export type CheckpointNote = {
  complete: true;
  goal: string;
  constraints: string[];
  findings: { detail: string; file?: string }[];
  changes: { detail: string; file?: string }[];
  checks: { command: string; outcome: string }[];
  unfinished: string[];
  questions: string[];
  risks: string[];
};

export const CHECKPOINT_MAX_CHARS = 10_000;

export function checkpointPrompt(): string {
  return `Create a checkpoint for continuing this coding task in a fresh Codex thread. Use the tool results and conversation still visible to you. Return exactly one JSON object, no Markdown fence, with these fields: complete (boolean), goal (string), constraints (string[]), findings ({detail,file?}[]), changes ({detail,file?}[]), checks ({command,outcome}[]), unfinished (string[]), questions (string[]), risks (string[]). Include exact user constraints, verified findings with file references, changes and check outcomes, and remaining work. Do not perform new work. Aim for roughly 2,000 tokens and keep the JSON under ${CHECKPOINT_MAX_CHARS} characters. Set complete to false if the state cannot fit or important facts are missing; never silently omit them.`;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function entries(value: unknown): value is { detail: string; file?: string }[] {
  return Array.isArray(value) && value.every(item => item && typeof item === "object" && !Array.isArray(item) &&
    typeof item.detail === "string" && item.detail.trim().length > 0 &&
    (item.file === undefined || typeof item.file === "string"));
}

export function parseCheckpoint(text: string): CheckpointNote {
  const source = text.trim();
  if (source.length > CHECKPOINT_MAX_CHARS) throw new Error(`Checkpoint exceeds ${CHECKPOINT_MAX_CHARS} characters`);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Checkpoint is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Checkpoint must be an object");
  const note = value as Record<string, unknown>;
  if (note.complete !== true || typeof note.goal !== "string" || !note.goal.trim() ||
    !strings(note.constraints) || !entries(note.findings) || !entries(note.changes) ||
    !Array.isArray(note.checks) || !note.checks.every(item => item && typeof item === "object" &&
      typeof item.command === "string" && item.command.trim() &&
      typeof item.outcome === "string" && item.outcome.trim()) ||
    !strings(note.unfinished) || !strings(note.questions) || !strings(note.risks))
    throw new Error("Checkpoint is missing required structured fields");
  return note as CheckpointNote;
}

export function checkpointHandoff(note: CheckpointNote, recent: { user: string; assistant: string }[], request: string): string {
  return `Continue this coding task from the validated checkpoint. Verify any important repository state before editing.\n\nCheckpoint:\n${JSON.stringify(note)}\n\nRecent exchanges:\n${JSON.stringify(recent.slice(-3))}\n\nCurrent user request:\n${request}`;
}
