import stringWidth from "string-width";
import { letterGradients } from "./Transcript.js";

export function paceGradient(column: number, width: number): string {
  const position = Math.max(0, Math.min(1, column / Math.max(1, width - 1))) * (letterGradients.length - 1);
  const first = Math.min(Math.floor(position), letterGradients.length - 2);
  const blend = position - first;
  const start = letterGradients[first]!;
  const end = letterGradients[first + 1]!;
  const channel = (offset: number) => Math.round(
    parseInt(start.slice(offset, offset + 2), 16) * (1 - blend) +
    parseInt(end.slice(offset, offset + 2), 16) * blend,
  ).toString(16).padStart(2, "0");
  return `#${channel(1)}${channel(3)}${channel(5)}`.toUpperCase();
}

export function inputColumns(value: string, width: number, shellMode: boolean): number[] {
  const start = Math.min(shellMode ? 10 : 3, Math.max(0, width - 2)); // App padding, prompt, and margin.
  const lineWidth = Math.max(1, width - start - 1); // Keep App's right padding.
  const columns: number[] = [];
  let offset = 0;
  for (let index = 0; index <= value.length; index++) {
    columns.push(start + offset);
    if (value[index] === "\n") offset = 0;
    else offset = (offset + 1) % lineWidth;
  }
  return columns;
}

export function visibleInputRows(value: string, cursor: number, width: number, maxRows: number): { start: number; end: number }[] {
  const rows: { start: number; end: number }[] = [];
  let start = 0;
  let column = 0;
  let cursorRow = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "\n") {
      if (index === cursor) cursorRow = rows.length;
      rows.push({ start, end: index });
      start = index + 1;
      column = 0;
    } else {
      const charWidth = stringWidth(char);
      if (column && column + charWidth > width) {
        rows.push({ start, end: index });
        start = index;
        column = 0;
      }
      column += charWidth;
      if (index === cursor) cursorRow = rows.length;
    }
  }
  rows.push({ start, end: value.length });
  if (cursor === value.length) cursorRow = rows.length - 1;
  return rows.slice(Math.max(0, cursorRow - maxRows + 1), Math.max(maxRows, cursorRow + 1));
}

export function commandToken(value: string): { start: number; prefix: string } | undefined {
  const match = /(?:^|\s)([\/@][^\s]*)$/.exec(value);
  return match ? { start: value.length - match[1]!.length, prefix: match[1]! } : undefined;
}

export function commandRanges(value: string, registeredCommands: readonly string[] = []): { start: number; end: number }[] {
  return [...value.matchAll(/(?:^|\s)([\/@][^\s]*)/g)].filter(match => registeredCommands.includes(match[1]!)).map(match => {
    const start = match.index + match[0].length - match[1]!.length;
    return { start, end: start + match[1]!.length };
  });
}

type DraftStyle = "bold" | "italic" | "code" | "strike";

export function markdownDraftRanges(value: string): { start: number; end: number; style: DraftStyle }[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/g;
  return [...value.matchAll(pattern)].map(match => {
    const token = match[0];
    const two = token.startsWith("**") || token.startsWith("__") || token.startsWith("~~");
    const edge = two ? 2 : 1;
    const style: DraftStyle = token.startsWith("`") ? "code" : token.startsWith("~~") ? "strike" : two ? "bold" : "italic";
    return { start: match.index + edge, end: match.index + token.length - edge, style };
  });
}
