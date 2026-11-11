import { useTheme } from "../shared/colors.js";
import React from "react";
import { Box, Text } from "ink";
import { displayCommand, summarizeCommand } from "./shell-runner.js";
import type { Progress } from "../integrations/codex.js";
import type { Line } from "./Transcript.js";

export type RunningProcess = { id: string; sessionId: string; command: string; startedAt: number };

export function updateProcesses(processes: RunningProcess[], sessionId: string, event: Extract<Progress, { kind: "activity" }>, now: number): RunningProcess[] {
  if (event.category !== "command") return processes;
  if (event.completed) return processes.filter(process => process.id !== event.id);
  if (processes.some(process => process.id === event.id)) return processes;
  return [...processes, { id: event.id, sessionId, command: event.title.replace(/^Running: /, ""), startedAt: now }];
}

export function RunningProcesses({ processes, now, lines = [] }: { processes: RunningProcess[]; now: number; lines?: Line[] }) {
  const theme = useTheme();
  if (!processes.length) return null;
  const current = processes.at(-1)!;
  const output = lines.find(line => line.sourceId === current.id)?.activity?.detail?.trim().split("\n").slice(-3) ?? [];
  return <Box flexDirection="column" marginTop={1}>
    <Text color={theme.warning} wrap="truncate">{`Running: ${summarizeCommand(displayCommand(current.command))} · ${Math.floor((now - current.startedAt) / 1000)}s${processes.length > 1 ? ` · ${processes.length} processes` : ""}`}</Text>
    {output.map((line, index) => <Text key={index} color={theme.muted} wrap="truncate">{`  ${line || " "}`}</Text>)}
    <Text color={theme.dim}>Stop turn: Ctrl+C</Text>
  </Box>;
}
