import React from "react";
import { Box, Text } from "ink";
import { displayCommand, summarizeCommand } from "./shell-runner.js";
import type { Progress } from "../integrations/codex.js";

export type RunningProcess = { id: string; sessionId: string; command: string; startedAt: number };

export function updateProcesses(processes: RunningProcess[], sessionId: string, event: Extract<Progress, { kind: "activity" }>, now: number): RunningProcess[] {
  if (event.category !== "command") return processes;
  if (event.completed) return processes.filter(process => process.id !== event.id);
  if (processes.some(process => process.id === event.id)) return processes;
  return [...processes, { id: event.id, sessionId, command: event.title.replace(/^Running: /, ""), startedAt: now }];
}

export function RunningProcesses({ processes, now }: { processes: RunningProcess[]; now: number }) {
  if (!processes.length) return null;
  return <Box flexDirection="column" marginTop={1}>
    <Text color="#FBBF24">Running processes ({processes.length})</Text>
    {processes.slice(-4).map(process => <Text key={process.id} color="#94A3B8" wrap="truncate">
      {`  ${summarizeCommand(displayCommand(process.command))} · ${Math.floor((now - process.startedAt) / 1000)}s`}
    </Text>)}
    {processes.length > 4 ? <Text dimColor>{`  +${processes.length - 4} more`}</Text> : null}
  </Box>;
}
