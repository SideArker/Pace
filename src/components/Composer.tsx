import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
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

export type PastedBlock = { start: number; end: number; lines: number };

export function insertDraftText(value: string, cursor: number, text: string, blocks: PastedBlock[]) {
  const length = text.length;
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + length,
    blocks: blocks.map(block => block.start >= cursor
      ? { ...block, start: block.start + length, end: block.end + length }
      : block),
  };
}

export function insertPastedBlock(value: string, cursor: number, text: string, blocks: PastedBlock[]) {
  const next = insertDraftText(value, cursor, text, blocks);
  const lines = text.split("\n").length;
  if (lines < 10) return next;
  return { ...next, blocks: [...next.blocks, { start: cursor, end: cursor + text.length, lines }]
    .sort((a, b) => a.start - b.start) };
}

export function deleteDraftRange(value: string, start: number, end: number, blocks: PastedBlock[]) {
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const block of blocks) {
      if (start < block.end && end > block.start && (start > block.start || end < block.end)) {
        start = Math.min(start, block.start);
        end = Math.max(end, block.end);
        expanded = true;
      }
    }
  }
  const length = end - start;
  return {
    value: value.slice(0, start) + value.slice(end),
    cursor: start,
    blocks: blocks.filter(block => block.end <= start || block.start >= end).map(block => block.start >= end
      ? { ...block, start: block.start - length, end: block.end - length }
      : block),
  };
}

export function skipPastedBlock(cursor: number, direction: "left" | "right", blocks: PastedBlock[]): number {
  const block = blocks.find(item => cursor > item.start && cursor < item.end);
  return block ? direction === "left" ? block.start : block.end : cursor;
}

export function displayPastedBlocks(value: string, cursor: number, blocks: PastedBlock[]) {
  let display = "";
  let rawIndex = 0;
  let displayCursor = cursor;
  const markers: { start: number; end: number }[] = [];
  for (const block of blocks) {
    display += value.slice(rawIndex, block.start);
    const marker = `[Pasted ${block.lines} line${block.lines === 1 ? "" : "s"}]`;
    const start = display.length;
    display += marker;
    markers.push({ start, end: display.length });
    if (cursor >= block.end) displayCursor += marker.length - (block.end - block.start);
    else if (cursor > block.start) displayCursor = start;
    rawIndex = block.end;
  }
  display += value.slice(rawIndex);
  return { value: display, cursor: displayCursor, markers };
}

export function verticalCursor(value: string, cursor: number, direction: "up" | "down"): number | undefined {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const column = cursor - lineStart;
  if (direction === "up") {
    if (lineStart === 0) return undefined;
    const end = lineStart - 1;
    const start = value.lastIndexOf("\n", end - 1) + 1;
    return Math.min(start + column, end);
  }
  const breakAt = value.indexOf("\n", cursor);
  if (breakAt < 0) return undefined;
  const start = breakAt + 1;
  const nextBreak = value.indexOf("\n", start);
  return Math.min(start + column, nextBreak < 0 ? value.length : nextBreak);
}

export function isNewlineKey(input: string, key: { return: boolean; shift: boolean; ctrl: boolean; meta: boolean }): boolean {
  return (key.return && (key.shift || key.ctrl || key.meta)) || (key.ctrl && input === "j") || input === "\n"
    || /^\[(?:27;2;13|13;2)~$/.test(input);
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

export function deleteWordForward(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor >= value.length) return { value, cursor };
  const after = value.slice(cursor);
  const match = /^(\s*[\p{L}\p{N}_]+|\s*[^\s\p{L}\p{N}_]+|\s+)/u.exec(after);
  const count = match ? match[0].length : 1;
  return {
    value: value.slice(0, cursor) + value.slice(cursor + count),
    cursor,
  };
}

export function deleteWordBackward(value: string, cursor: number): { value: string; cursor: number } {
  if (cursor <= 0) return { value, cursor: 0 };
  const before = value.slice(0, cursor);
  const match = /([\p{L}\p{N}_]+\s*|[^\s\p{L}\p{N}_]+\s*|\s+)$/u.exec(before);
  const count = match ? match[0].length : 1;
  const newCursor = Math.max(0, cursor - count);
  return {
    value: value.slice(0, newCursor) + value.slice(cursor),
    cursor: newCursor,
  };
}

export function isAltDeleteKey(input: string, key: { delete?: boolean; meta?: boolean; ctrl?: boolean }): boolean {
  return !!((key.delete && (key.meta || key.ctrl))
    || input === "\x1b[3;3~" || input === "\x1b\x1b[3~" || input === "\x1b[3;5~" || (key.meta && input === "d"));
}

export function isAltBackspaceKey(input: string, key: { backspace?: boolean; meta?: boolean; ctrl?: boolean }): boolean {
  return !!((key.backspace && (key.meta || key.ctrl))
    || input === "\x1b\x7f" || input === "\x1b\b" || (key.ctrl && input === "w"));
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onImagePaste?: () => Promise<string | undefined>;
  history: string[];
  disabled: boolean;
  shellMode: boolean;
  registeredCommands?: readonly string[];
  placeholder: string;
  completion?: string;
  completionStart?: number;
  onComplete: () => void;
  onHistory?: (direction: "up" | "down") => boolean;
  onMoveDown?: () => boolean;
  onQueueEdit?: () => string | undefined;
  onDeleteQueued?: () => boolean;
  width?: number;
  maxRows?: number;
};

export function Composer({ value, onChange, onSubmit, onImagePaste, history, disabled, shellMode, registeredCommands = [], placeholder, completion, completionStart, onComplete, onHistory, onMoveDown, onQueueEdit, onDeleteQueued, width, maxRows = 4 }: Props) {
  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(width ?? stdout?.columns ?? 80);

  useEffect(() => {
    if (width !== undefined) {
      setTerminalWidth(width);
      return;
    }
    const stream = stdout ?? process.stdout;
    if (!stream) return;
    const onResize = () => setTerminalWidth(stream.columns ?? 80);
    stream.on?.("resize", onResize);
    process.stdout?.on?.("resize", onResize);
    return () => {
      stream.off?.("resize", onResize);
      process.stdout?.off?.("resize", onResize);
    };
  }, [width, stdout]);
  const [cursor, setCursor] = useState(0);
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [savedDraft, setSavedDraft] = useState("");
  const previousValue = useRef(value);
  const expectedValue = useRef(value);
  useEffect(() => {
    if (!previousValue.current && value) setCursor(value.length);
    if (value !== expectedValue.current) setPastedBlocks([]);
    previousValue.current = value;
    expectedValue.current = value;
  }, [value]);
  const changeDraft = (next: { value: string; cursor: number; blocks: PastedBlock[] }) => {
    expectedValue.current = next.value;
    onChange(next.value);
    setCursor(next.cursor);
    setPastedBlocks(next.blocks);
    setHistoryIndex(undefined);
  };
  const insert = (text: string) => {
    changeDraft(insertDraftText(value, cursor, text, pastedBlocks));
  };
  const insertLatest = useRef(insert);
  insertLatest.current = insert;
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  usePaste((text) => {
    if (!disabled && text) changeDraft(insertPastedBlock(value, cursor, text.replace(/\r\n?/g, "\n"), pastedBlocks));
  }, { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (value) {
        onChange("");
        setCursor(0);
        setHistoryIndex(undefined);
      }
      return;
    }
    if (!shellMode && onImagePaste && ((key.ctrl && input === "v") || (key.meta && input === "v"))) {
      void onImagePaste().then(marker => { if (active.current && marker) insertLatest.current(`${value ? " " : ""}${marker} `); });
      return;
    }
    if (isNewlineKey(input, key)) { insert("\n"); return; }
    if (key.upArrow || key.downArrow) {
      const nextCursor = verticalCursor(value, cursor, key.upArrow ? "up" : "down");
      if (nextCursor !== undefined) { setCursor(skipPastedBlock(nextCursor, key.upArrow ? "left" : "right", pastedBlocks)); return; }
      if (onHistory?.(key.upArrow ? "up" : "down")) return;
      if (key.downArrow && historyIndex === undefined && onMoveDown?.()) return;
      if (!history.length) return;
      const next = key.upArrow ? Math.min((historyIndex ?? history.length) - 1, history.length - 1) : Math.min((historyIndex ?? history.length) + 1, history.length);
      if (next < 0) return;
      if (historyIndex === undefined) setSavedDraft(value);
      const recalled = next === history.length ? savedDraft : history[next]!;
      onChange(recalled);
      setCursor(recalled.length);
      setPastedBlocks([]);
      setHistoryIndex(next === history.length ? undefined : next);
      return;
    }
    if (key.tab) { if (completion && completionStart !== undefined) { onComplete(); setCursor(completionStart + completion.length); } return; }
    if (key.return) {
      if (completion && completionStart === 0 && value.trim() !== completion && (value.startsWith("/") || value.startsWith("@"))) {
        onComplete();
        setCursor(completion.length);
        return;
      }
      if (value.trim()) onSubmit(value);
      setCursor(0);
      setPastedBlocks([]);
      setHistoryIndex(undefined);
      return;
    }
    if (key.leftArrow) { setCursor(skipPastedBlock(Math.max(0, cursor - 1), "left", pastedBlocks)); return; }
    if (key.rightArrow) {
      if (!value) {
        const queued = onQueueEdit?.();
        if (queued !== undefined) { onChange(queued); setCursor(queued.length); setPastedBlocks([]); setHistoryIndex(undefined); return; }
      }
      setCursor(skipPastedBlock(Math.min(value.length, cursor + 1), "right", pastedBlocks));
      return;
    }
    if (key.home) { setCursor(skipPastedBlock(value.lastIndexOf("\n", cursor - 1) + 1, "left", pastedBlocks)); return; }
    if (key.end) { const end = value.indexOf("\n", cursor); setCursor(skipPastedBlock(end < 0 ? value.length : end, "right", pastedBlocks)); return; }
    if (isAltDeleteKey(input, key)) {
      if (!value) {
        if (onDeleteQueued?.()) return;
      }
      if (cursor < value.length) {
        const next = deleteWordForward(value, cursor);
        changeDraft(deleteDraftRange(value, cursor, cursor + value.length - next.value.length, pastedBlocks));
      } else if (cursor > 0) {
        const next = deleteWordBackward(value, cursor);
        changeDraft(deleteDraftRange(value, next.cursor, cursor, pastedBlocks));
      }
      return;
    }
    if (isAltBackspaceKey(input, key)) {
      if (cursor > 0) {
        const next = deleteWordBackward(value, cursor);
        changeDraft(deleteDraftRange(value, next.cursor, cursor, pastedBlocks));
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (key.backspace && cursor > 0) changeDraft(deleteDraftRange(value, cursor - 1, cursor, pastedBlocks));
      if (key.delete && cursor < value.length) changeDraft(deleteDraftRange(value, cursor, cursor + 1, pastedBlocks));
      return;
    }
    if (!key.escape && !key.ctrl && !key.meta && input) insert(input);
  }, { isActive: !disabled });
  const display = displayPastedBlocks(value, cursor, pastedBlocks);
  const ranges = shellMode ? [] : commandRanges(display.value, registeredCommands);
  const markdownRanges = shellMode ? [] : markdownDraftRanges(display.value);
  const styleAt = (index: number) => markdownRanges.find(range => index >= range.start && index < range.end)?.style;
  const isMarker = (index: number) => display.markers.some(marker => index >= marker.start && index < marker.end);
  const isCommand = (index: number) => shellMode || display.value.startsWith("!") || ranges.some(range => index >= range.start && index < range.end);
  const colorAt = (index: number) => isMarker(index) ? "#A5B4FC" : isCommand(index) ? "#38BDF8" : paceGradient(columns[index]!, terminalWidth);
  const columns = inputColumns(display.value, terminalWidth, shellMode);
  const renderText = (text: string, start: number) => {
    let position = start;
    // Keep styled spans grouped within each visible row.
    return text
      .split(/(\s+)/)
      .filter((part) => part.length > 0)
      .flatMap((part) => {
        const begin = position;
        position += part.length;
        const cuts = [begin, position, ...markdownRanges.flatMap(range => [range.start, range.end]).filter(index => index > begin && index < position)].sort((a, b) => a - b);
        return cuts.slice(0, -1).map((index, offset) => {
          const style = styleAt(index);
          return <Text key={index} color={style === "code" ? "#FBBF24" : colorAt(index)} bold={isCommand(index) || style === "bold"} italic={style === "italic"} dimColor={style === "strike"} backgroundColor={style === "code" ? "#1E293B" : undefined}>{part.slice(index - begin, cuts[offset + 1]! - begin)}</Text>;
        });
      });
  };
  const prefix = completionStart === undefined ? "" : value.slice(completionStart);
  const hasGhost = !!(completion && prefix && completion.startsWith(prefix) && cursor === value.length);
  const ghostText = hasGhost ? completion.slice(prefix.length) : "";
  const inputWidth = Math.max(1, terminalWidth - (shellMode ? 10 : 3) - 1);
  const visibleRows = visibleInputRows(display.value, display.cursor, inputWidth, maxRows);

  return (
    <Box flexDirection="column" width="100%">
      <Box width="100%">
        {shellMode ? (
          <Box marginRight={1}>
            <Text backgroundColor="#D97706" color="#000000" bold> BASH </Text>
            <Text color="#FBBF24" bold> !</Text>
          </Box>
        ) : (
          <Box marginRight={1}>
            <Text color="#59E6A7" bold>❯</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1} minWidth={1} flexDirection="column">
          {visibleRows.map(({ start, end }) => {
            const hasCursor = display.cursor >= start && (display.cursor < end || (display.cursor === end && (display.value[display.cursor] === "\n" || display.cursor === display.value.length)));
            const before = display.value.slice(start, hasCursor ? display.cursor : end);
            const at = display.value[display.cursor] && display.cursor < end ? display.value[display.cursor]! : " ";
            const after = hasCursor ? display.value.slice(display.cursor + (display.cursor < end ? 1 : 0), end) : "";
            const isEmptyLine = !hasCursor && before.length === 0 && after.length === 0;
            return <Text key={start} wrap="truncate">
              {isEmptyLine ? " " : null}
              {display.value ? renderText(before, start) : null}
              {hasCursor ? <Text inverse color={display.value ? colorAt(display.cursor) : "gray"}>
                {display.value ? <Text bold={isCommand(display.cursor) || styleAt(display.cursor) === "bold"} italic={styleAt(display.cursor) === "italic"} dimColor={styleAt(display.cursor) === "strike"}>{at}</Text> : placeholder[0] ?? " "}
              </Text> : null}
              {display.value ? renderText(after, hasCursor ? display.cursor + (display.cursor < end ? 1 : 0) : end) : <Text color="gray">{placeholder.slice(1)}</Text>}
              {hasCursor && hasGhost ? <Text color="#64748B" italic>{ghostText}<Text color="#475569" dimColor> (Tab)</Text></Text> : null}
            </Text>;
          })}
        </Box>
      </Box>
    </Box>
  );
}
