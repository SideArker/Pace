import React from "react";
import { Box, Text } from "ink";

const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function WorkingStatus({ busy, status, runningCount, shellJobs, tick, usage, tip }: {
  busy: boolean;
  status: string;
  runningCount: number;
  shellJobs: number;
  tick: number;
  usage?: string;
  tip?: string;
}) {
  if (!runningCount && !shellJobs) return null;
  const action = busy ? status : runningCount
    ? `${runningCount} background turn${runningCount === 1 ? "" : "s"} running`
    : "Ready";
  return <Box flexDirection="column" flexShrink={0}>
    <Box gap={1}>
      <Text color="#59E6A7" bold>{spinner[tick % spinner.length]}</Text>
      <Text color="#38BDF8" wrap="truncate">{action}</Text>
      {shellJobs ? <Text color="#FBBF24">· ⚡ {shellJobs} Bash command{shellJobs === 1 ? "" : "s"} running</Text> : null}
    </Box>
    {busy && usage ? <Text color="#94A3B8" wrap="truncate">{usage}</Text> : null}
    {busy && tip ? <Text color="#64748B" wrap="truncate">Tip: {tip}</Text> : null}
  </Box>;
}
