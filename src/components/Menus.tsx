import React from "react";
import { Box, Text } from "ink";
import { EFFORTS } from "../shared/config.js";
import type { Config, Session, TurnSummary } from "../shared/types.js";

export function ModelMenu({
  mode,
  models,
  selectedModel,
  selectedIndex,
  config,
}: {
  mode: "models" | "efforts";
  models: string[];
  selectedModel: string;
  selectedIndex: number;
  config?: Config;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#34D399" paddingX={1} marginBottom={1}>
      <Text color="#59E6A7" bold>
        ◈ {mode === "models" ? "Configured Models" : `${selectedModel} Reasoning Levels`}
      </Text>
      {(mode === "models" ? models : EFFORTS).map((item, index) => {
        const configured = config?.models.find(
          (model) => model.model === (mode === "models" ? item : selectedModel),
        );
        const enabled =
          mode === "models"
            ? !!configured && configured.enabled !== false
            : !!configured?.efforts.includes(item as (typeof EFFORTS)[number]);
        const selected = index === selectedIndex;
        return (
          <Box key={item} gap={1}>
            <Text color={selected ? "#38BDF8" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color={enabled ? "#34D399" : "#64748B"} bold={enabled}>
              {enabled ? "●" : "○"}
            </Text>
            <Text color={selected ? "#F0FDF4" : "white"} bold={selected}>
              {item}
            </Text>
            {mode === "models" && configured ? (
              <Text color="#64748B">({configured.efforts.join(", ")})</Text>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="#64748B">
          {mode === "models"
            ? "↑/↓ or Tab select · Space toggle · Enter edit reasoning · Esc close"
            : "↑/↓ or Tab select · Space/Enter toggle · Esc back"}
        </Text>
      </Box>
    </Box>
  );
}

export function ResumeMenu({
  choices,
  selectedIndex,
  runningIds = [],
  processIds = [],
}: {
  choices: Session[];
  selectedIndex: number;
  runningIds?: string[];
  processIds?: string[];
}) {
  const processChoices = choices.filter(choice => processIds.includes(choice.id));
  const globalChoices = choices.filter(choice => !processIds.includes(choice.id));
  const renderChoices = (items: Session[]) => items.map(choice => {
    const index = choices.indexOf(choice);
    const selected = index === selectedIndex;
    const cleanPrompt = (choice.turns.at(-1)?.prompt ?? "(empty)").replace(/\s+/g, " ").trim();
    const shortPrompt = cleanPrompt.length > 45 ? `${cleanPrompt.slice(0, 42)}…` : cleanPrompt;
    return (
      <Box key={choice.id} gap={1}>
        <Text color={selected ? "#38BDF8" : "gray"} bold={selected}>{selected ? "▶" : " "}</Text>
        <Text color={selected ? "#38BDF8" : "#94A3B8"} bold={selected}>{choice.id.slice(0, 8)}</Text>
        <Text color="#64748B">{choice.updatedAt.slice(0, 16).replace("T", " ")}</Text>
        {choice.projectPath !== process.cwd() ? <Text color="#64748B">{choice.projectPath}</Text> : null}
        <Text color={selected ? "white" : "#CBD5E1"}>{shortPrompt}</Text>
        {runningIds.includes(choice.id) ? <Text color="#FBBF24">(running)</Text> : null}
      </Box>
    );
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#34D399" paddingX={1} marginBottom={1}>
      <Text color="#59E6A7" bold>◈ Resume Conversation</Text>
      {processChoices.length ? <><Text color="#38BDF8" bold>This Pace Process</Text>{renderChoices(processChoices)}</> : null}
      {globalChoices.length ? <><Text color="#38BDF8" bold>Global</Text>{renderChoices(globalChoices)}</> : null}
      <Box marginTop={1}><Text color="#64748B">↑/↓ or Tab select · Enter resume · Esc close</Text></Box>
    </Box>
  );
}
export type ConversationChoice = {
  id: string;
  title?: string;
  prompt: string;
  state: "ready" | "running" | "approval";
};

export function ConversationPicker({ choices, activeId, selectedIndex, focused }: {
  choices: ConversationChoice[];
  activeId?: string;
  selectedIndex: number;
  focused: boolean;
}) {
  const anchor = focused ? selectedIndex : Math.max(0, choices.findIndex(choice => choice.id === activeId));
  const start = Math.max(0, Math.min(anchor - 2, choices.length - 5));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? "#38BDF8" : "#475569"} paddingX={1} marginTop={1}>
      <Text color="#94A3B8" bold>Conversations <Text dimColor>· ↓ from input to select · Enter switch · Esc back</Text></Text>
      {choices.slice(start, start + 5).map((choice, offset) => {
        const selected = focused && start + offset === selectedIndex;
        const current = choice.id === activeId;
        const prompt = (choice.title || choice.prompt).replace(/\s+/g, " ").trim();
        return (
          <Box key={choice.id} gap={1}>
            <Text color={selected ? "#38BDF8" : "#64748B"}>{selected ? "▶" : " "}</Text>
            <Text color={current ? "#59E6A7" : "#94A3B8"}>{choice.id.slice(0, 8)}</Text>
            <Text color={choice.state === "approval" ? "#FBBF24" : choice.state === "running" ? "#38BDF8" : "#64748B"}>{choice.state === "approval" ? "approval" : choice.state === "running" ? "running" : current ? "current" : "ready"}</Text>
            <Text color={selected ? "white" : "#CBD5E1"} wrap="truncate">{prompt.slice(0, 60) || "New conversation"}</Text>
          </Box>
        );
      })}
      {choices.length > 5 ? <Text color="#64748B">{start + 1}–{Math.min(start + 5, choices.length)} of {choices.length}</Text> : null}
    </Box>
  );
}

export function CommandMenu({
  matches,
  selectedIndex,
}: {
  matches: string[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1}>
      <Text color="#38BDF8" bold>◈ Commands</Text>
      {matches.map((match, index) => {
        const selected = index === selectedIndex;
        return (
          <Box key={match} gap={1}>
            <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color="#38BDF8" bold>
              {match}
            </Text>
          </Box>
        );
      })}
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
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#38BDF8" paddingX={1} marginBottom={1}>
      <Text color="#38BDF8" bold>
        ◈ Conversation Turns ({turns.length} message{turns.length === 1 ? "" : "s"})
      </Text>
      {turns.map((turn, index) => {
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
      <Box marginTop={1}>
        <Text color="#64748B">↑/↓ select · Enter edit from here · Backspace/d delete · Esc close</Text>
      </Box>
    </Box>
  );
}
