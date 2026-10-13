import React from "react";
import { Box, Text } from "ink";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { ApprovalMode, Route, Session, TurnSummary } from "../shared/types.js";

export type ConversationChoice = {
  id: string;
  kind?: Session["kind"];
  projectPath?: string;
  section?: "pace" | "saved";
  sectionTitle?: string;
  sectionKey?: string;
  title?: string;
  prompt: string;
  state: "ready" | "running" | "approval" | "question" | "done";
  updatedAt?: string;
};

export function resolveRepoTitle(
  projectPath: string,
  allProjectPaths: string[] = [],
): { title: string; isRepo: boolean } {
  const isGit = existsSync(join(projectPath, ".git"));
  const base = basename(projectPath);
  const duplicates = allProjectPaths.filter(
    (p) => p !== projectPath && basename(p) === base,
  );
  if (duplicates.length > 0) {
    return { title: projectPath, isRepo: isGit };
  }
  return { title: base, isRepo: isGit };
}

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
  items: T[],
  thisPaceIds: ReadonlySet<string>,
  currentProjectPath?: string,
): (T & { section: "pace" | "saved"; sectionTitle: string; sectionKey: string })[] {
  const current = sortConversations(items.filter(item => thisPaceIds.has(item.id)));

  const allProjectPaths = Array.from(
    new Set(items.map(item => item.projectPath).filter((p): p is string => Boolean(p))),
  );

  const savedItems = items.filter(item => !thisPaceIds.has(item.id));
  const savedGroups = new Map<string, T[]>();
  for (const item of savedItems) {
    const key = item.projectPath ?? item.id;
    savedGroups.set(key, [...(savedGroups.get(key) ?? []), item]);
  }

  // Sort groups: currentProjectPath first (if present in savedGroups), then by newest updatedAt
  const sortedGroupKeys = [...savedGroups.keys()].sort((keyA, keyB) => {
    const isCurrentA = currentProjectPath && keyA === currentProjectPath;
    const isCurrentB = currentProjectPath && keyB === currentProjectPath;
    if (isCurrentA && !isCurrentB) return -1;
    if (!isCurrentA && isCurrentB) return 1;

    const groupA = savedGroups.get(keyA)!;
    const groupB = savedGroups.get(keyB)!;
    const maxTimeA = groupA.reduce((max, i) => (i.updatedAt && i.updatedAt > max ? i.updatedAt : max), "");
    const maxTimeB = groupB.reduce((max, i) => (i.updatedAt && i.updatedAt > max ? i.updatedAt : max), "");
    return maxTimeB.localeCompare(maxTimeA);
  });

  const saved: (T & { section: "pace" | "saved"; sectionTitle: string; sectionKey: string })[] = [];
  for (const key of sortedGroupKeys) {
    const group = sortConversations(savedGroups.get(key)!);
    const firstItem = group[0];
    const resolved = firstItem?.projectPath
      ? resolveRepoTitle(firstItem.projectPath, allProjectPaths).title
      : "Saved conversations";
    for (const item of group) {
      saved.push({
        ...item,
        section: "saved" as const,
        sectionTitle: resolved,
        sectionKey: key,
      });
    }
  }

  return [
    ...current.map(item => ({
      ...item,
      section: "pace" as const,
      sectionTitle: "This pace",
      sectionKey: "pace",
    })),
    ...saved,
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
  searchQuery = "",
}: {
  choices: ConversationChoice[];
  activeId?: string;
  selectedIndex: number;
  focused: boolean;
  width?: number;
  maxItems?: number;
  marginTop?: number;
  missingProjectPaths?: string[];
  searchQuery?: string;
}) {
  const query = searchQuery.trim().toLowerCase();
  const filteredChoices = query
    ? choices.filter(choice => {
        const title = (choice.title ?? "").toLowerCase();
        const prompt = (choice.prompt ?? "").toLowerCase();
        const id = choice.id.toLowerCase();
        const path = (choice.projectPath ?? "").toLowerCase();
        const sectionTitle = (choice.sectionTitle ?? "").toLowerCase();
        return (
          title.includes(query) ||
          prompt.includes(query) ||
          id.includes(query) ||
          path.includes(query) ||
          sectionTitle.includes(query)
        );
      })
    : choices;

  const anchor = focused ? selectedIndex : Math.max(0, filteredChoices.findIndex(choice => choice.id === activeId));
  const pace = filteredChoices.map((choice, index) => ({ choice, index })).filter(({ choice }) => (choice.section ?? "pace") === "pace");
  const saved = filteredChoices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.section === "saved");
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

  // Group counts for headers
  const sectionCounts = new Map<string, number>();
  for (const choice of filteredChoices) {
    const title = choice.sectionTitle || (choice.section === "pace" ? "This pace" : "Saved conversations");
    sectionCounts.set(title, (sectionCounts.get(title) ?? 0) + 1);
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "#38BDF8" : "#475569"} paddingX={1} width={width} marginTop={marginTop}>
      <Text color="#94A3B8" bold wrap="truncate">
        Conversations {showHints ? <Text dimColor>· ↓ to select · Enter switch · Esc back</Text> : null}
      </Text>
      {focused ? (
        <Box gap={1} marginY={0}>
          <Text color="#38BDF8">Search repo/convo:</Text>
          <Text color="white" bold>{searchQuery || ""}</Text>
          <Text color="#38BDF8">█</Text>
          {query && filteredChoices.length === 0 ? <Text color="#EF4444">(no matches)</Text> : null}
        </Box>
      ) : null}
      {(["pace", "saved"] as const).map(section => {
        const visible = section === "pace" ? visiblePace : visibleSaved;
        if (!visible.length) return null;
        return (
          <React.Fragment key={section}>
            {section === "pace" ? (
              <Text color="#64748B" bold>This pace ({pace.length})</Text>
            ) : null}
            {visible.map(({ choice, index }, position) => {
              const selected = focused && index === selectedIndex;
              const current = choice.id === activeId;
              const prompt = (choice.title || choice.prompt).replace(/\s+/g, " ").trim();
              const stateColor = choice.state === "approval" ? "#FBBF24" : choice.state === "question" ? "#A5B4FC" : choice.state === "running" ? "#38BDF8" : choice.state === "done" ? "#59E6A7" : "#64748B";
              const stateLabel = choice.state === "approval" ? "approve" : choice.state === "question" ? "answer" : choice.state === "running" ? "running" : choice.state === "done" ? "done" : current ? "current" : "ready";

              const sectionTitle = choice.sectionTitle || "Saved conversations";
              const prevSectionTitle = position > 0 ? (visible[position - 1]?.choice.sectionTitle || "Saved conversations") : undefined;
              const isFirstInSavedSection = section === "saved" && (position === 0 || sectionTitle !== prevSectionTitle);
              const count = sectionCounts.get(sectionTitle) ?? visible.length;

              return (
                <React.Fragment key={choice.id}>
                  {isFirstInSavedSection ? (
                    <Text color="#64748B" bold>{sectionTitle} ({count})</Text>
                  ) : null}
                  {isFirstInSavedSection && choice.projectPath && missingProjectPaths.includes(choice.projectPath)
                    ? <Text color="#F87171">(missing; use pace reconnect)</Text>
                    : null}
                  <Box gap={1}>
                    <Box flexShrink={0}><Text color={selected ? (choice.kind === "planning" ? "#C084FC" : "#38BDF8") : "#64748B"}>{selected ? "▶" : " "}</Text></Box>
                    <Box flexShrink={0}><Text color={current ? (choice.kind === "planning" ? "#C084FC" : "#59E6A7") : (choice.kind === "planning" ? "#D8B4FE" : "#94A3B8")}>{choice.id.slice(0, 8)}</Text></Box>
                    {choice.kind === "planning" ? <Box flexShrink={0}><Text color="#C084FC" bold>[plan]</Text></Box> : null}
                    <Box flexShrink={0}><Text color={stateColor}>{stateLabel}</Text></Box>
                    <Text color={selected ? "white" : (choice.kind === "planning" ? "#F3E8FF" : "#CBD5E1")} wrap="truncate">{prompt.slice(0, 60) || (choice.kind === "planning" ? "New plan" : "New conversation")}</Text>
                  </Box>
                </React.Fragment>
              );
            })}
          </React.Fragment>
        );
      })}
      {filteredChoices.length > visiblePace.length + visibleSaved.length ? <Text color="#64748B">Showing {visiblePace.length + visibleSaved.length} of {filteredChoices.length}</Text> : null}
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
  skillNames,
}: {
  matches: string[];
  descriptions?: Record<string, string>;
  args?: Record<string, string>;
  selectedIndex: number;
  width?: number;
  skillNames?: ReadonlySet<string> | readonly string[];
}) {
  const { start, end } = menuWindow(matches.length, selectedIndex);
  const skillSet = skillNames instanceof Set ? skillNames : new Set(skillNames ?? []);
  const isSkill = (cmd: string) =>
    cmd.startsWith("/@") ||
    cmd.startsWith("@") ||
    skillSet.has(cmd) ||
    skillSet.has(cmd.replace(/^[/@]/, ""));

  const termWidth = width ?? 80;
  const maxColWidth = Math.max(12, Math.min(32, Math.floor(termWidth * 0.4)));
  const commandDisplayLength = (command: string) =>
    command.length + (args[command] ? args[command]!.length + 1 : 0);
  const maxMatchLength = matches.length > 0 ? Math.max(...matches.map(commandDisplayLength)) : 14;
  const commandColWidth = Math.max(12, Math.min(maxColWidth, maxMatchLength));
  const maxDescWidth = Math.max(15, termWidth - commandColWidth - 8);

  const selectedMatch = matches[selectedIndex];
  const selectedDescription = selectedMatch ? descriptions[selectedMatch] : undefined;
  const selectedArg = selectedMatch ? args[selectedMatch] : undefined;

  const visibleMatches = matches.slice(start, end);
  const allVisibleAreSkills = visibleMatches.length > 0 && visibleMatches.every(isSkill);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1} width={width}>
      <Text color={allVisibleAreSkills ? "#A855F7" : "#38BDF8"} bold>
        {allVisibleAreSkills ? "◈ Skills" : "◈ Commands"}
      </Text>
      {visibleMatches.map((match, offset) => {
        const selected = start + offset === selectedIndex;
        const argText = args[match];
        const rawDesc = descriptions[match] ?? "";
        const firstLine = rawDesc.split(/\r?\n/)[0]?.trim() ?? "";
        const displayDescription = truncateWithEllipsis(firstLine, maxDescWidth);
        const matchIsSkill = isSkill(match);
        const isFirstSkillInWindow = !allVisibleAreSkills && matchIsSkill && (offset === 0 ? false : !isSkill(visibleMatches[offset - 1]!));

        return (
          <React.Fragment key={match}>
            {isFirstSkillInWindow ? (
              <Box marginTop={0}>
                <Text color="#A855F7" bold>◈ Skills</Text>
              </Box>
            ) : null}
            <Box gap={1}>
              <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
                {selected ? "▶" : " "}
              </Text>
              <Box width={commandColWidth} flexShrink={0}>
                <Text wrap="truncate">
                  <Text color={matchIsSkill ? "#C084FC" : "#38BDF8"} bold>
                    {match}
                  </Text>
                  {argText ? <Text color="#94A3B8"> {argText}</Text> : null}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={selected ? "#CBD5E1" : "#64748B"} wrap="truncate">
                  {displayDescription}
                </Text>
              </Box>
            </Box>
          </React.Fragment>
        );
      })}
      {matches.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {matches.length}</Text> : null}
      {selectedMatch && selectedDescription ? (
        <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="#334155" width={width ? Math.max(20, width - 2) : undefined}>
          <Box gap={1}>
            <Text wrap="truncate">
              <Text color={isSkill(selectedMatch) ? "#C084FC" : "#38BDF8"} bold>{selectedMatch}</Text>
              {selectedArg ? <Text color="#94A3B8"> {selectedArg}</Text> : null}
            </Text>
          </Box>
          <Text color="#E2E8F0" wrap="wrap">
            {selectedDescription.split(/\r?\n/).slice(0, 4).join("\n")}
          </Text>
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
