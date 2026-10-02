import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
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

export function commandRanges(value: string): { start: number; end: number }[] {
  return [...value.matchAll(/(?:^|\s)([\/@][^\s]*)/g)].map(match => {
    const start = match.index + match[0].length - match[1]!.length;
    return { start, end: start + match[1]!.length };
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
  placeholder: string;
  completion?: string;
  completionStart?: number;
  onComplete: () => void;
  onHistory?: (direction: "up" | "down") => boolean;
  onMoveDown?: () => boolean;
  onQueueEdit?: () => string | undefined;
  onDeleteQueued?: () => boolean;
  width?: number;
};

export function Composer({ value, onChange, onSubmit, onImagePaste, history, disabled, shellMode, placeholder, completion, completionStart, onComplete, onHistory, onMoveDown, onQueueEdit, onDeleteQueued, width }: Props) {
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
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [savedDraft, setSavedDraft] = useState("");
  const previousValue = useRef(value);
  useEffect(() => {
    if (!previousValue.current && value) setCursor(value.length);
    previousValue.current = value;
  }, [value]);
  const insert = (text: string) => {
    onChange(value.slice(0, cursor) + text + value.slice(cursor));
    setCursor(cursor + text.length);
    setHistoryIndex(undefined);
  };
  const insertLatest = useRef(insert);
  insertLatest.current = insert;
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  usePaste((text) => { if (!disabled) insert(text.replace(/\r\n?/g, "\n")); }, { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && input === "c") return;
    if (!shellMode && onImagePaste && ((key.ctrl && input === "v") || (key.meta && input === "v"))) {
      void onImagePaste().then(marker => { if (active.current && marker) insertLatest.current(`${value ? " " : ""}${marker} `); });
      return;
    }
    if (isNewlineKey(input, key)) { insert("\n"); return; }
    if (key.upArrow || key.downArrow) {
      const nextCursor = verticalCursor(value, cursor, key.upArrow ? "up" : "down");
      if (nextCursor !== undefined) { setCursor(nextCursor); return; }
      if (onHistory?.(key.upArrow ? "up" : "down")) return;
      if (key.downArrow && historyIndex === undefined && onMoveDown?.()) return;
      if (!history.length) return;
      const next = key.upArrow ? Math.min((historyIndex ?? history.length) - 1, history.length - 1) : Math.min((historyIndex ?? history.length) + 1, history.length);
      if (next < 0) return;
      if (historyIndex === undefined) setSavedDraft(value);
      const recalled = next === history.length ? savedDraft : history[next]!;
      onChange(recalled);
      setCursor(recalled.length);
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
      setHistoryIndex(undefined);
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) {
      if (!value) {
        const queued = onQueueEdit?.();
        if (queued !== undefined) { onChange(queued); setCursor(queued.length); setHistoryIndex(undefined); return; }
      }
      setCursor(Math.min(value.length, cursor + 1));
      return;
    }
    if (key.home) { setCursor(value.lastIndexOf("\n", cursor - 1) + 1); return; }
    if (key.end) { const end = value.indexOf("\n", cursor); setCursor(end < 0 ? value.length : end); return; }
    if (isAltDeleteKey(input, key)) {
      if (!value) {
        if (onDeleteQueued?.()) return;
      }
      if (cursor < value.length) {
        const next = deleteWordForward(value, cursor);
        onChange(next.value);
        setCursor(next.cursor);
      } else if (cursor > 0) {
        const next = deleteWordBackward(value, cursor);
        onChange(next.value);
        setCursor(next.cursor);
      }
      return;
    }
    if (isAltBackspaceKey(input, key)) {
      if (cursor > 0) {
        const next = deleteWordBackward(value, cursor);
        onChange(next.value);
        setCursor(next.cursor);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (key.backspace && cursor > 0) { onChange(value.slice(0, cursor - 1) + value.slice(cursor)); setCursor(cursor - 1); }
      if (key.delete && cursor < value.length) onChange(value.slice(0, cursor) + value.slice(cursor + 1));
      return;
    }
    if (!key.escape && !key.ctrl && !key.meta && input) insert(input);
  }, { isActive: !disabled });
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + (cursor < value.length ? 1 : 0));
  const ranges = shellMode ? [] : commandRanges(value);
  const isCommand = (index: number) => shellMode || value.startsWith("!") || ranges.some(range => index >= range.start && index < range.end);
  const colorAt = (index: number) => isCommand(index) ? "#38BDF8" : paceGradient(columns[index]!, terminalWidth);
  const columns = inputColumns(value, terminalWidth, shellMode);
  const renderText = (text: string, start: number) => {
    let position = start;
    // Keep each word together as one Ink text node so its word-aware wrapper
    // can move it intact to the next line.
    return text
      .split(/(\s+)/)
      .filter((part) => part.length > 0)
      .map((part) => {
      const index = position;
      position += part.length;
      return <Text key={index} color={colorAt(index)} bold={isCommand(index)}>{part}</Text>;
    });
  };
  const prefix = completionStart === undefined ? "" : value.slice(completionStart);
  const hasGhost = !!(completion && prefix && completion.startsWith(prefix) && cursor === value.length);
  const ghostText = hasGhost ? completion.slice(prefix.length) : "";

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
        <Box flexGrow={1} flexShrink={1} minWidth={1}>
          <Text wrap="wrap">
            {value ? renderText(before, 0) : null}
            <Text inverse color={value ? colorAt(cursor) : "gray"}>
              {value ? <Text bold={isCommand(cursor)}>{at}</Text> : placeholder[0] ?? " "}
            </Text>
            {value ? renderText(after, cursor + (cursor < value.length ? 1 : 0)) : <Text color="gray">{placeholder.slice(1)}</Text>}
            {hasGhost ? (
              <Text color="#64748B" italic>
                {ghostText}
                <Text color="#475569" dimColor> (Tab)</Text>
              </Text>
            ) : null}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
