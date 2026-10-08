import React from "react";
import { Box, Text } from "ink";
import type { ApprovalMode, Route, TurnSummary } from "../shared/types.js";

export type ConversationChoice = {
  id: string;
  section?: "pace" | "saved";
  title?: string;
  prompt: string;
  state: "ready" | "running" | "approval" | "question" | "done";
  updatedAt?: string;
};

export function sortConversations<T extends { state: "ready" | "running" | "approval" | "question" | "done"; updatedAt?: string }>(
  items: T[],
): T[] {
  const getRank = (state: string): number => {
    if (state === "running") return 1;
    if (state === "approval" || state === "question") return 2;
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

export function sectionConversations<T extends { id: string; state: "ready" | "running" | "approval" | "question" | "done"; updatedAt?: string }>(
  items: T[], thisPaceIds: ReadonlySet<string>,
): (T & { section: "pace" | "saved" })[] {
  const current = sortConversations(items.filter(item => thisPaceIds.has(item.id)));
  const saved = items.filter(item => !thisPaceIds.has(item.id)).sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return [
    ...current.map(item => ({ ...item, section: "pace" as const })),
    ...saved.map(item => ({ ...item, section: "saved" as const })),
  ];
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
  const pace = choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => (choice.section ?? "pace") === "pace");
  const saved = choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.section === "saved");
  const paceLimit = saved.length ? Math.min(pace.length, Math.max(1, Math.ceil(maxItems / 2))) : maxItems;
  const savedLimit = pace.length ? Math.max(1, maxItems - paceLimit) : maxItems;
  const windowFor = (items: typeof pace, limit: number) => {
    const selected = items.findIndex(item => item.index === anchor);
    const waiting = !focused ? items.findIndex(item => (item.choice.state === "approval" || item.choice.state === "question") && item.choice.id !== activeId) : -1;
    const { start } = menuWindow(items.length, Math.max(0, waiting >= 0 ? waiting : selected), limit);
    return items.slice(start, start + limit);
  };
  const visiblePace = windowFor(pace, paceLimit);
  const visibleSaved = windowFor(saved, savedLimit);
  const showHints = width === undefined || width >= 50;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "#38BDF8" : "#475569"} paddingX={1} width={width} marginTop={marginTop}>
      <Text color="#94A3B8" bold wrap="truncate">
        Conversations {showHints ? <Text dimColor>· ↓ to select · Enter switch · Esc back</Text> : null}
      </Text>
      {(["pace", "saved"] as const).map(section => {
        const visible = section === "pace" ? visiblePace : visibleSaved;
        const count = section === "pace" ? pace.length : saved.length;
        return <React.Fragment key={section}>
          <Text color="#64748B" bold>{section === "pace" ? "This pace" : "Saved conversations"} ({count})</Text>
          {visible.map(({ choice, index }) => {
        const selected = focused && index === selectedIndex;
        const current = choice.id === activeId;
        const prompt = (choice.title || choice.prompt).replace(/\s+/g, " ").trim();
        const stateColor = choice.state === "approval" ? "#FBBF24" : choice.state === "question" ? "#A5B4FC" : choice.state === "running" ? "#38BDF8" : choice.state === "done" ? "#59E6A7" : "#64748B";
        const stateLabel = choice.state === "approval" ? "approve" : choice.state === "question" ? "answer" : choice.state === "running" ? "running" : choice.state === "done" ? "done" : current ? "current" : "ready";
        return (
          <Box key={choice.id} gap={1}>
            <Box flexShrink={0}><Text color={selected ? "#38BDF8" : "#64748B"}>{selected ? "▶" : " "}</Text></Box>
            <Box flexShrink={0}><Text color={current ? "#59E6A7" : "#94A3B8"}>{choice.id.slice(0, 8)}</Text></Box>
            <Box flexShrink={0}><Text color={stateColor}>{stateLabel}</Text></Box>
            <Text color={selected ? "white" : "#CBD5E1"} wrap="truncate">{prompt.slice(0, 60) || "New conversation"}</Text>
          </Box>
        );
          })}
        </React.Fragment>;
      })}
      {choices.length > visiblePace.length + visibleSaved.length ? <Text color="#64748B">Showing {visiblePace.length + visibleSaved.length} of {choices.length}</Text> : null}
    </Box>
  );
}

export function ApprovalModeMenu({ selectedIndex, currentMode }: { selectedIndex: number; currentMode: ApprovalMode }) {
  const modes: { id: ApprovalMode; description: string }[] = [
    { id: "request-approval", description: "Sandboxed turns; ask for risky commands" },
    { id: "limited", description: "Read-only turns; ask before each typed Bash command" },
    { id: "full-access", description: "Unrestricted Codex turns; typed Bash still blocks destructive patterns" },
  ];
  return <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1} marginTop={1}>
    <Text color="#FBBF24" bold>Approval mode</Text>
    {modes.map((mode, index) => <Box key={mode.id} gap={1}>
      <Text color={index === selectedIndex ? "#59E6A7" : "#64748B"}>{index === selectedIndex ? "▶" : " "}</Text>
      <Text color={index === selectedIndex ? "white" : "#CBD5E1"}>{mode.id}{mode.id === currentMode ? " (current)" : ""}</Text>
      <Text color="#64748B">{mode.description}</Text>
    </Box>)}
    <Text color="#64748B">↑/↓ select · Enter save · Esc close</Text>
  </Box>;
}

export function ManualRouteMenu({
  routes,
  selectedIndex,
  currentRoute,
}: {
  routes: Route[];
  selectedIndex: number;
  currentRoute: Route;
}) {
  const formatName = (route: Route) => {
    const name =
      route.model?.replace(
        /^gpt-(\d+)-(.+)$/,
        (_match, ver: string, n: string) =>
          `GPT-${ver} ${n[0]!.toUpperCase()}${n.slice(1)}`,
      ) ?? route.model ?? "Unknown";
    const effort = route.effort
      ? ` · ${route.effort[0]!.toUpperCase()}${route.effort.slice(1)}`
      : "";
    return `${name}${effort}`;
  };
  const isCurrent = (route: Route) =>
    route.model === currentRoute.model && route.effort === currentRoute.effort;
  const { start, end } = menuWindow(routes.length, selectedIndex);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#38BDF8" paddingX={1} marginTop={1}>
      <Text color="#38BDF8" bold>Manual Route</Text>
      {routes.slice(start, end).map((route, offset) => {
        const index = start + offset;
        const selected = index === selectedIndex;
        const current = isCurrent(route);
        return (
          <Box key={`${route.model}-${route.effort}`} gap={1}>
            <Text color={selected ? "#38BDF8" : "#64748B"}>{selected ? "▶" : " "}</Text>
            <Text color={current ? "#59E6A7" : "#64748B"}>{current ? "●" : "○"}</Text>
            <Text color={selected ? "white" : "#CBD5E1"}>
              {formatName(route)}
              {current ? " (current)" : ""}
            </Text>
          </Box>
        );
      })}
      {routes.length > 5 ? (
        <Text color="#64748B">
          {start + 1}–{end} of {routes.length}
        </Text>
      ) : null}
      <Text color="#64748B">↑/↓ select · Enter save · Esc close</Text>
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
        <Text color="#64748B">↑/↓ select · → edit in composer · Alt+Del/Backspace/d delete · Esc close</Text>
      </Box>
    </Box>
  );
}
