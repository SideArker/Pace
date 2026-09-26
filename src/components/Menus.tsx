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
}: {
  choices: Session[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#34D399" paddingX={1} marginBottom={1}>
      <Text color="#59E6A7" bold>◈ Saved Conversations</Text>
      {choices.map((choice, index) => {
        const selected = index === selectedIndex;
        const lastPrompt = choice.turns.at(-1)?.prompt ?? "(empty)";
        const cleanPrompt = lastPrompt.replace(/\s+/g, " ").trim();
        const shortPrompt = cleanPrompt.length > 45 ? `${cleanPrompt.slice(0, 42)}…` : cleanPrompt;
        return (
          <Box key={choice.id} gap={1}>
            <Text color={selected ? "#38BDF8" : "gray"} bold={selected}>
              {selected ? "▶" : " "}
            </Text>
            <Text color={selected ? "#38BDF8" : "#94A3B8"} bold={selected}>
              {choice.id.slice(0, 8)}
            </Text>
            <Text color="#64748B">{choice.updatedAt.slice(0, 16).replace("T", " ")}</Text>
            <Text color={selected ? "white" : "#CBD5E1"}>{shortPrompt}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="#64748B">↑/↓ or Tab select · Enter resume · Esc close</Text>
      </Box>
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
            <Text color={selected ? "#59E6A7" : "#CBD5E1"} bold={selected}>
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
