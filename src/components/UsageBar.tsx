import React from "react";
import { Box, Text } from "ink";
import type { UsageLimits, UsageWindow } from "../integrations/usage.js";

function Meter({ label, window }: { label: string; window: UsageWindow }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const blocks = Math.round(used / 5);
  const empty = Math.max(0, 20 - blocks);
  const barColor = used > 90 ? "#F87171" : used > 75 ? "#FBBF24" : "#34D399";

  return (
    <Box gap={1}>
      <Text color="#94A3B8" bold>
        [{label}]
      </Text>
      <Text color={barColor}>{"█".repeat(blocks)}</Text>
      <Text color="#334155">{"░".repeat(empty)}</Text>
      <Text color={barColor} bold>
        {used.toFixed(0)}%
      </Text>
      <Text color="#64748B">({Math.round(100 - used)}% left)</Text>
    </Box>
  );
}

export function UsageBar({ limits, error }: { limits?: UsageLimits; error?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#334155" paddingX={1} marginTop={1}>
      <Text color="#59E6A7" bold>◈ Rate Limits & Usage</Text>
      {limits?.primary ? <Meter label={windowLabel(limits.primary)} window={limits.primary} /> : null}
      {limits?.secondary ? <Meter label={windowLabel(limits.secondary)} window={limits.secondary} /> : null}
      {!limits?.primary && !limits?.secondary ? (
        <Text color="gray">{error ?? "Loading usage…"}</Text>
      ) : null}
    </Box>
  );
}

function windowLabel(window: UsageWindow): string {
  const minutes = window.windowDurationMins;
  return minutes === null ? "Window" : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
