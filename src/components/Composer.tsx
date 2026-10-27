import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, usePaste, useStdout } from "ink";
import {
  deleteDraftRange, deleteWordBackward, deleteWordForward, displayPastedBlocks,
  insertDraftText, insertPastedBlock, isAltBackspaceKey, isAltDeleteKey,
  isNewlineKey, isSteerShortcut, skipPastedBlock, verticalCursor,
  type PastedBlock,
} from "./composer-editing.js";
import {
  commandRanges, inputColumns, markdownDraftRanges, paceGradient, visibleInputRows,
} from "./composer-display.js";

export {
  deleteDraftRange, deleteWordBackward, deleteWordForward, displayPastedBlocks,
  insertDraftText, insertPastedBlock, isAltBackspaceKey, isAltDeleteKey,
  isNewlineKey, isSteerShortcut, skipPastedBlock, verticalCursor,
  type PastedBlock,
} from "./composer-editing.js";
export {
  commandRanges, commandToken, inputColumns, markdownDraftRanges, paceGradient, visibleInputRows,
} from "./composer-display.js";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, options?: { steer?: boolean }) => void;
  onImagePaste?: () => Promise<string | undefined>;
  history: string[];
  disabled: boolean;
  shellMode: boolean;
  registeredCommands?: readonly string[];
  placeholder: string;
  completion?: string;
  completionStart?: number;
  onComplete: () => void;
  onAutoLaunchToggle?: () => void;
  onHistory?: (direction: "up" | "down") => boolean;
  onMoveDown?: () => boolean;
  onQueueEdit?: () => string | undefined;
  onDeleteQueued?: () => boolean;
  width?: number;
  maxRows?: number;
};

export function Composer({ value, onChange, onSubmit, onImagePaste, history, disabled, shellMode, registeredCommands = [], placeholder, completion, completionStart, onComplete, onAutoLaunchToggle, onHistory, onMoveDown, onQueueEdit, onDeleteQueued, width, maxRows = 4 }: Props) {
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
    if (!shellMode && onImagePaste && key.ctrl && input === "v") {
      void onImagePaste().then(pasted => {
        if (!active.current || !pasted) return;
        if (pasted.startsWith("[Pace image: ")) {
          insertLatest.current(`${value ? " " : ""}${pasted} `);
        } else {
          changeDraft(insertPastedBlock(value, cursor, pasted.replace(/\r\n?/g, "\n"), pastedBlocks));
        }
      });
      return;
    }
    if (key.meta && input.toLowerCase() === "a") { onAutoLaunchToggle?.(); return; }
    if (isSteerShortcut(input, key)) {
      if (value.trim()) {
        onSubmit(value, { steer: true });
        setCursor(0);
        setPastedBlocks([]);
        setHistoryIndex(undefined);
      }
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
