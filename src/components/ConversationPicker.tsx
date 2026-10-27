import React from "react";
import { Box, Text } from "ink";
import { menuWindow, type ConversationChoice } from "./conversation-menu-utils.js";

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
  const paceLimit = saved.length ? Math.min(pace.length, Math.max(1, maxItems - saved.length, Math.ceil(maxItems / 2))) : maxItems;
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
