import React from "react";
import { Box, Text } from "ink";
import type { ApprovalMode, Route, Session, TurnSummary } from "../shared/types.js";

export type ConversationChoice = {
  id: string;
  kind?: Session["kind"];
  projectPath?: string;
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

export function sectionConversations<T extends { id: string; projectPath?: string; state: "ready" | "running" | "approval" | "question" | "done"; updatedAt?: string }>(
  items: T[], thisPaceIds: ReadonlySet<string>,
): (T & { section: "pace" | "saved" })[] {
  const current = sortConversations(items.filter(item => thisPaceIds.has(item.id)));
  const savedByTime = items.filter(item => !thisPaceIds.has(item.id)).sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const savedGroups = new Map<string, T[]>();
  for (const item of savedByTime) {
    const key = item.projectPath ?? item.id;
    savedGroups.set(key, [...(savedGroups.get(key) ?? []), item]);
  }
  const saved = [...savedGroups.values()].flat();
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
  missingProjectPaths = [],
}: {
  choices: ConversationChoice[];
  activeId?: string;
  selectedIndex: number;
  focused: boolean;
  width?: number;
  maxItems?: number;
  marginTop?: number;
  missingProjectPaths?: string[];
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
          {visible.map(({ choice, index }, position) => {
            const selected = focused && index === selectedIndex;
            const current = choice.id === activeId;
            const prompt = (choice.title || choice.prompt).replace(/\s+/g, " ").trim();
            const stateColor = choice.state === "approval" ? "#FBBF24" : choice.state === "question" ? "#A5B4FC" : choice.state === "running" ? "#38BDF8" : choice.state === "done" ? "#59E6A7" : "#64748B";
            const stateLabel = choice.state === "approval" ? "approve" : choice.state === "question" ? "answer" : choice.state === "running" ? "running" : choice.state === "done" ? "done" : current ? "current" : "ready";
            return <React.Fragment key={choice.id}>
              {choice.projectPath && (position === 0 || visible[position - 1]?.choice.projectPath !== choice.projectPath)
                ? <Text color={missingProjectPaths.includes(choice.projectPath) ? "#F87171" : "#94A3B8"} wrap="truncate">{choice.projectPath}{missingProjectPaths.includes(choice.projectPath) ? " (missing; use pace reconnect)" : ""}</Text>
                : null}
              <Box gap={1}>
                <Box flexShrink={0}><Text color={selected ? (choice.kind === "planning" ? "#C084FC" : "#38BDF8") : "#64748B"}>{selected ? "▶" : " "}</Text></Box>
                <Box flexShrink={0}><Text color={current ? (choice.kind === "planning" ? "#C084FC" : "#59E6A7") : (choice.kind === "planning" ? "#D8B4FE" : "#94A3B8")}>{choice.id.slice(0, 8)}</Text></Box>
                {choice.kind === "planning" ? <Box flexShrink={0}><Text color="#C084FC" bold>[plan]</Text></Box> : null}
                <Box flexShrink={0}><Text color={stateColor}>{stateLabel}</Text></Box>
                <Text color={selected ? "white" : (choice.kind === "planning" ? "#F3E8FF" : "#CBD5E1")} wrap="truncate">{prompt.slice(0, 60) || (choice.kind === "planning" ? "New plan" : "New conversation")}</Text>
              </Box>
            </React.Fragment>;
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

export function ManualWorkflowMenu({ title, options, selectedIndex }: {
  title: string;
  options: string[];
  selectedIndex: number;
}) {
  const { start, end } = menuWindow(options.length, selectedIndex);
  return <Box flexDirection="column" borderStyle="round" borderColor="#38BDF8" paddingX={1} marginTop={1}>
    <Text color="#38BDF8" bold>{title}</Text>
    {options.slice(start, end).map((option, offset) => <Box key={start + offset} gap={1}>
      <Text color={start + offset === selectedIndex ? "#38BDF8" : "#64748B"}>{start + offset === selectedIndex ? "▶" : " "}</Text>
      <Text color={start + offset === selectedIndex ? "white" : "#CBD5E1"}>{option}</Text>
    </Box>)}
    {options.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {options.length}</Text> : null}
    <Text color="#64748B">↑/↓ select · Enter next · Esc close</Text>
  </Box>;
}

export function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function CommandMenu({
  matches,
  descriptions = {},
  args = {},
  selectedIndex,
  width,
}: {
  matches: string[];
  descriptions?: Record<string, string>;
  args?: Record<string, string>;
  selectedIndex: number;
  width?: number;
}) {
  const { start, end } = menuWindow(matches.length, selectedIndex);
  const commandDisplayLength = (command: string) =>
    command.length + (args[command] ? args[command]!.length + 1 : 0);
  const commandColWidth = Math.min(
    32,
    Math.max(18, ...matches.map(commandDisplayLength)),
  );
  const maxDescWidth = Math.max(20, (width ?? 80) - commandColWidth - 8);
  const selectedMatch = matches[selectedIndex];
  const selectedDescription = selectedMatch ? descriptions[selectedMatch] : undefined;
  const selectedArg = selectedMatch ? args[selectedMatch] : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1}>
      <Text color="#38BDF8" bold>◈ Commands</Text>
      {matches.slice(start, end).map((match, offset) => {
        const selected = start + offset === selectedIndex;
        const argText = args[match];
        const rawDesc = descriptions[match] ?? "";
        const firstLine = rawDesc.split(/\r?\n/)[0]?.trim() ?? "";
        const displayDescription = truncateWithEllipsis(firstLine, maxDescWidth);
        return (
          <Box key={match} gap={1}>
            <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Box width={commandColWidth} flexShrink={0}>
              <Text color="#38BDF8" bold>
                {match}
              </Text>
              {argText ? <Text color="#94A3B8"> {argText}</Text> : null}
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={selected ? "#CBD5E1" : "#64748B"} wrap="truncate">
                {displayDescription}
              </Text>
            </Box>
          </Box>
        );
      })}
      {matches.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {matches.length}</Text> : null}
      {selectedMatch && selectedDescription ? (
        <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="#334155">
          <Box gap={1}>
            <Text color="#38BDF8" bold>{selectedMatch}</Text>
            {selectedArg ? <Text color="#94A3B8">{selectedArg}</Text> : null}
          </Box>
          <Text color="#E2E8F0">{selectedDescription}</Text>
        </Box>
      ) : null}
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
