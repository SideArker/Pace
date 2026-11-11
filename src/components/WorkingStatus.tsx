import React, { useContext } from "react";
import { Box, Text, useStdout } from "ink";
import { ColorSchemeContext, supportsAnimation, useTheme } from "../shared/colors.js";

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function WorkSpinner({ tick }: { tick: number }) {
  const theme = useTheme();
  const scheme = useContext(ColorSchemeContext);
  const { stdout } = useStdout();
  return <Text color={theme.secondary}>{supportsAnimation(stdout, process.env, scheme) ? spinner[tick % spinner.length] : "•"}</Text>;
}

export function ColorSweep({ text, tick, animated }: { text: string; tick: number; animated?: boolean }) {
  const theme = useTheme();
  const scheme = useContext(ColorSchemeContext);
  const { stdout } = useStdout();
  const moving = animated ?? supportsAnimation(stdout, process.env, scheme);
  if (!moving) return <Text bold>{text}</Text>;
  const position = tick % (text.length + 4);
  return <Text bold>{[...text].map((letter, index) => <Text key={index}
    color={index === position ? theme.primary : index === position - 1 ? theme.secondary : theme.dim}>{letter}</Text>)}</Text>;
}

export function workLabel(status: string): string {
  return status.trim() && !/^working(?:…|\.\.\.)?$/i.test(status.trim()) ? status : "Working";
}

export function WorkingStatus({ busy, status, runningCount, shellJobs, tick, usage, tip, hasActivity = false }: {
  busy: boolean; status: string; runningCount: number; shellJobs: number; tick: number;
  usage?: string; tip?: string; hasActivity?: boolean;
}) {
  const theme = useTheme();
  if (!busy && !runningCount && !shellJobs) return null;
  const action = busy ? workLabel(status) : runningCount
    ? `${runningCount} background turn${runningCount === 1 ? "" : "s"} running` : "Ready";
  const actionable = /^(?:waiting\b|approval\b|question\b|failed\b|error\b|blocked\b)/i.test(action);
  const moving = busy && !actionable;
  const showAction = !busy || !hasActivity || actionable;
  return <Box flexDirection="column" flexShrink={0}>
    {showAction || shellJobs ? <Box gap={1}>
      {showAction ? <>
        {moving ? <WorkSpinner tick={tick} /> : null}
        <Text wrap="truncate-end"><ColorSweep text={action} tick={tick} animated={moving ? undefined : false} /></Text>
      </> : null}
      {shellJobs ? <Text color={theme.warning}>· ⚡ {shellJobs} Bash command{shellJobs === 1 ? "" : "s"} running</Text> : null}
    </Box> : null}
    {busy && usage ? <Text color={theme.muted} wrap="truncate">{usage}</Text> : null}
    {busy && tip ? <Text color={theme.dim} wrap="truncate">Tip: {tip}</Text> : null}
  </Box>;
}
