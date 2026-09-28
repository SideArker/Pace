import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";

export function isNewlineKey(input: string, key: { return: boolean; shift: boolean; ctrl: boolean; meta: boolean }): boolean {
  return (key.return && (key.shift || key.ctrl || key.meta)) || (key.ctrl && input === "j") || input === "\n";
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  history: string[];
  disabled: boolean;
  shellMode: boolean;
  placeholder: string;
  completion?: string;
  onComplete: () => void;
  onHistory?: (direction: "up" | "down") => boolean;
};

export function Composer({ value, onChange, onSubmit, history, disabled, shellMode, placeholder, completion, onComplete, onHistory }: Props) {
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number>();
  const [savedDraft, setSavedDraft] = useState("");
  const insert = (text: string) => {
    onChange(value.slice(0, cursor) + text + value.slice(cursor));
    setCursor(cursor + text.length);
    setHistoryIndex(undefined);
  };
  usePaste((text) => { if (!disabled) insert(text.replace(/\r\n?/g, "\n")); }, { isActive: !disabled });
  useInput((input, key) => {
    if (key.ctrl && input === "c") return;
    if (isNewlineKey(input, key)) { insert("\n"); return; }
    if (key.upArrow || key.downArrow) {
      if (onHistory?.(key.upArrow ? "up" : "down")) return;
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
    if (key.tab) { if (completion) { onComplete(); setCursor(completion.length); } return; }
    if (key.return) {
      if (completion && value.trim() !== completion && value.startsWith("/")) {
        onChange(completion);
        setCursor(completion.length);
        onComplete();
        return;
      }
      if (value.trim()) onSubmit(value);
      setCursor(0);
      setHistoryIndex(undefined);
      return;
    }
    if (key.leftArrow) { setCursor(Math.max(0, cursor - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(value.length, cursor + 1)); return; }
    if (key.home) { setCursor(value.lastIndexOf("\n", cursor - 1) + 1); return; }
    if (key.end) { const end = value.indexOf("\n", cursor); setCursor(end < 0 ? value.length : end); return; }
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
  const hasGhost = !!(completion && value && completion.startsWith(value) && cursor === value.length);
  const ghostText = hasGhost ? completion.slice(value.length) : "";

  return (
    <Box flexDirection="column">
      <Box>
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
        <Text color="white">{value ? before : ""}</Text>
        <Text inverse color={value ? "#59E6A7" : "gray"}>
          {value ? at : placeholder[0] ?? " "}
        </Text>
        <Text color={value ? "white" : "gray"}>
          {value ? after : placeholder.slice(1)}
        </Text>
        {hasGhost ? (
          <Text color="#64748B" italic>
            {ghostText}
            <Text color="#475569" dimColor> (Tab)</Text>
          </Text>
        ) : null}
      </Box>
      {value.includes("\n") ? (
        <Text color="#64748B">Shift/Ctrl/Alt+Enter or Ctrl+J newline · Enter send</Text>
      ) : null}
    </Box>
  );
}
