import React from "react";
import { Box, Text } from "ink";
import type { Session } from "../shared/types.js";

export function ResumeMenu({
  choices,
  selectedIndex,
  runningIds = [],
  processIds = [],
  missingProjectPaths = [],
}: {
  choices: Session[];
  selectedIndex: number;
  runningIds?: string[];
  processIds?: string[];
  missingProjectPaths?: string[];
}) {
  const processChoices = choices.filter(choice => processIds.includes(choice.id));
  const globalChoices = choices.filter(choice => !processIds.includes(choice.id));
  const renderChoice = (choice: Session) => {
    const index = choices.indexOf(choice);
    const selected = index === selectedIndex;
    const cleanPrompt = (choice.turns.at(-1)?.prompt ?? "(empty)").replace(/\s+/g, " ").trim();
    const shortPrompt = cleanPrompt.length > 45 ? `${cleanPrompt.slice(0, 42)}…` : cleanPrompt;
    const missing = missingProjectPaths.includes(choice.projectPath);
    return (
      <Box key={choice.id} gap={1}>
        <Text color={selected ? "#38BDF8" : "gray"} bold={selected}>{selected ? "▶" : " "}</Text>
        <Text color={selected ? "#38BDF8" : "#94A3B8"} bold={selected}>{choice.id.slice(0, 8)}</Text>
        <Text color="#64748B">{choice.updatedAt.slice(0, 16).replace("T", " ")}</Text>
        {missing ? <Text color="#F87171">(unavailable)</Text> : null}
        <Text color={selected ? "white" : "#CBD5E1"}>{shortPrompt}</Text>
        {runningIds.includes(choice.id) ? <Text color="#FBBF24">(running)</Text> : null}
      </Box>
    );
  };
  const renderGroups = (items: Session[]) => {
    const groups = new Map<string, Session[]>();
    for (const choice of items) groups.set(choice.projectPath, [...(groups.get(choice.projectPath) ?? []), choice]);
    return [...groups].map(([path, sessions]) => (
      <React.Fragment key={path}>
        <Text color={missingProjectPaths.includes(path) ? "#F87171" : "#94A3B8"}>
          {path} {missingProjectPaths.includes(path) ? "(missing; restore this folder)" : ""}
        </Text>
        {sessions.map(renderChoice)}
      </React.Fragment>
    ));
  };
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#34D399" paddingX={1} marginBottom={1}>
      <Text color="#59E6A7" bold>◈ Resume Conversation</Text>
      {processChoices.length ? <><Text color="#38BDF8" bold>This Pace Process</Text>{renderGroups(processChoices)}</> : null}
      {globalChoices.length ? <><Text color="#38BDF8" bold>Saved Projects</Text>{renderGroups(globalChoices)}</> : null}
      <Box marginTop={1}><Text color="#64748B">↑/↓ or Tab select · Enter resume available project · Esc close</Text></Box>
    </Box>
  );
}
