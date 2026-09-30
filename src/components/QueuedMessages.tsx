import React from "react";
import { Box, Text } from "ink";

export function QueuedMessages({
  prompts,
  width,
  maxItems = 5,
  marginTop = 0,
}: {
  prompts: readonly string[];
  width?: number;
  maxItems?: number;
  marginTop?: number;
}) {
  if (!prompts.length) return null;
  const visible = prompts.slice(0, maxItems);
  const showHints = width === undefined || width >= 50;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} width={width} marginTop={marginTop}>
      <Text color="#FBBF24" bold wrap="truncate">
        ◈ Queued messages ({prompts.length}){showHints ? <Text color="#94A3B8" dimColor> · ↑ edit · Alt+Del remove</Text> : null}
      </Text>
      {visible.map((prompt, index) => (
        <Box key={index} gap={1}>
          <Text color="#FBBF24">{index + 1}.</Text>
          <Text color="#CBD5E1" wrap="truncate">{prompt.replace(/\s+/g, " ").trim()}</Text>
        </Box>
      ))}
      {prompts.length > visible.length ? <Text color="#64748B">+{prompts.length - visible.length} more queued</Text> : null}
    </Box>
  );
}
