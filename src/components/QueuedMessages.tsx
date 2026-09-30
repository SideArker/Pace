import React from "react";
import { Box, Text } from "ink";

export function QueuedMessages({ prompts }: { prompts: readonly string[] }) {
  if (!prompts.length) return null;
  const visible = prompts.slice(0, 5);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1}>
      <Text color="#FBBF24" bold>Queued messages ({prompts.length})</Text>
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
