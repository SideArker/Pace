import React from "react";
import { Box, Text } from "ink";
import type { TurnSummary } from "../shared/types.js";

export type ConversationChoice = {
  id: string;
  title?: string;
  prompt: string;
  state: "ready" | "running" | "approval" | "done";
  updatedAt?: string;
};

export function sortConversations<T extends { state: "ready" | "running" | "approval" | "done"; updatedAt?: string }>(
  items: T[],
): T[] {
  const getRank = (state: string): number => {
    if (state === "running") return 1;
    if (state === "approval") return 2;
    return 3; // done | ready
  };

  return [...items].sort((a, b) => {
    const rankA = getRank(a.state);
    const rankB = getRank(b.state);
    if (rankA !== rankB) return rankA - rankB;

    const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return timeB - timeA;
  });
}

export function menuWindow(length: number, selectedIndex: number, size = 5): { start: number; end: number } {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(size / 2), length - size));
  return { start, end: Math.min(start + size, length) };
}

export function ConversationPicker({
  choices,
  activeId,
  selectedIndex,
  focused,
  width,
  maxItems = 5,
  marginTop = 0,
}: {
  choices: ConversationChoice[];
  activeId?: string;
  selectedIndex: number;
  focused: boolean;
  width?: number;
  maxItems?: number;
  marginTop?: number;
}) {
  const anchor = focused ? selectedIndex : Math.max(0, choices.findIndex(choice => choice.id === activeId));
  const { start } = menuWindow(choices.length, anchor, maxItems);
  const showHints = width === undefined || width >= 50;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "#38BDF8" : "#475569"} paddingX={1} width={width} marginTop={marginTop}>
      <Text color="#94A3B8" bold wrap="truncate">
        Conversations {showHints ? <Text dimColor>· ↓ to select · Enter switch · Esc back</Text> : null}
      </Text>
      {choices.slice(start, start + maxItems).map((choice, offset) => {
        const selected = focused && start + offset === selectedIndex;
        const current = choice.id === activeId;
        const prompt = (choice.title || choice.prompt).replace(/\s+/g, " ").trim();
        const stateColor = choice.state === "approval" ? "#FBBF24" : choice.state === "running" ? "#38BDF8" : choice.state === "done" ? "#59E6A7" : "#64748B";
        const stateLabel = choice.state === "approval" ? "approve" : choice.state === "running" ? "running" : choice.state === "done" ? "done" : current ? "current" : "ready";
        return (
          <Box key={choice.id} gap={1}>
            <Text color={selected ? "#38BDF8" : "#64748B"}>{selected ? "▶" : " "}</Text>
            <Text color={current ? "#59E6A7" : "#94A3B8"}>{choice.id.slice(0, 8)}</Text>
            <Text color={stateColor}>{stateLabel}</Text>
            <Text color={selected ? "white" : "#CBD5E1"} wrap="truncate">{prompt.slice(0, 60) || "New conversation"}</Text>
          </Box>
        );
      })}
      {choices.length > maxItems ? <Text color="#64748B">{start + 1}–{Math.min(start + maxItems, choices.length)} of {choices.length}</Text> : null}
    </Box>
  );
}

export function CommandMenu({
  matches,
  descriptions = {},
  selectedIndex,
}: {
  matches: string[];
  descriptions?: Record<string, string>;
  selectedIndex: number;
}) {
  const { start, end } = menuWindow(matches.length, selectedIndex);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1}>
      <Text color="#38BDF8" bold>◈ Commands</Text>
      {matches.slice(start, end).map((match, offset) => {
        const selected = start + offset === selectedIndex;
        return (
          <Box key={match} gap={1}>
            <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color="#38BDF8" bold>
              {match}
            </Text>
            <Text color="#64748B" wrap="truncate">{descriptions[match] ?? ""}</Text>
          </Box>
        );
      })}
      {matches.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {matches.length}</Text> : null}
      <Box marginTop={0}>
        <Text color="#64748B">↑/↓ select · Tab complete</Text>
      </Box>
    </Box>
  );
}

export function ConvoMenu({
  turns,
  selectedIndex,
}: {
  turns: TurnSummary[];
  selectedIndex: number;
}) {
  const { start, end } = menuWindow(turns.length, selectedIndex);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#38BDF8" paddingX={1} marginBottom={1}>
      <Text color="#38BDF8" bold>
        ◈ Conversation Turns ({turns.length} message{turns.length === 1 ? "" : "s"})
      </Text>
      {turns.slice(start, end).map((turn, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        const cleanPrompt = turn.prompt.replace(/\s+/g, " ").trim();
        const shortPrompt = cleanPrompt.length > 40 ? `${cleanPrompt.slice(0, 37)}…` : cleanPrompt;
        const model = turn.route?.model ?? "auto";
        return (
          <Box key={index} gap={1}>
            <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color={selected ? "#38BDF8" : "#94A3B8"} bold={selected}>
              #{index + 1}
            </Text>
            <Text color="#64748B">{turn.at.slice(11, 16)}</Text>
            <Text color={selected ? "white" : "#CBD5E1"} bold={selected}>
              {shortPrompt}
            </Text>
            <Text color="#64748B">({model})</Text>
          </Box>
        );
      })}
      {turns.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {turns.length}</Text> : null}
      <Box marginTop={1}>
        <Text color="#64748B">↑/↓ select · Enter edit from here · Backspace/d delete · Esc close</Text>
      </Box>
    </Box>
  );
}

export function QueueMenu({
  prompts,
  selectedIndex,
}: {
  prompts: readonly string[];
  selectedIndex: number;
}) {
  const { start, end } = menuWindow(prompts.length, selectedIndex);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1} marginTop={1}>
      <Text color="#FBBF24" bold>
        Queued messages ({prompts.length})
      </Text>
      {prompts.slice(start, end).map((prompt, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        const cleanPrompt = prompt.replace(/\s+/g, " ").trim();
        const shortPrompt = cleanPrompt.length > 50 ? `${cleanPrompt.slice(0, 47)}…` : cleanPrompt;
        return (
          <Box key={index} gap={1}>
            <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color={selected ? "#38BDF8" : "#94A3B8"} bold={selected}>
              #{index + 1}
            </Text>
            <Text color={selected ? "white" : "#CBD5E1"} bold={selected}>
              {shortPrompt}
            </Text>
          </Box>
        );
      })}
      {prompts.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {prompts.length}</Text> : null}
      <Box marginTop={1}>
        <Text color="#64748B">↑/↓ select · Enter edit in composer · Alt+Del/Backspace/d delete · Esc close</Text>
      </Box>
    </Box>
  );
}
