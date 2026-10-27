import React from "react";
import { Box, Text } from "ink";
import type { ApprovalMode, Route, TurnSummary } from "../shared/types.js";
import { menuWindow } from "./conversation-menu-utils.js";

export { ConversationPicker } from "./ConversationPicker.js";
export { CommandMenu } from "./CommandMenu.js";
export { resolveRepoTitle, sortConversations, sectionConversations, menuWindow, truncateWithEllipsis, type ConversationChoice } from "./conversation-menu-utils.js";

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
      <Box marginTop={1} flexDirection="column">
        <Text color="#64748B">↑/↓ select · S steer now (or Alt+M) · → edit in composer</Text>
        <Text color="#64748B">Alt+Del/Backspace/d delete · Esc close</Text>
      </Box>
    </Box>
  );
}
