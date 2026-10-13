import React from "react";
import { Box, Text } from "ink";
import type { UsageLimits, UsageWindow } from "../integrations/usage.js";

function windowLabel(window: UsageWindow): string {
  const minutes = window.windowDurationMins;
  return minutes === null ? "Window" : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function resetLabel(seconds?: number): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? `Resets ${date.toLocaleString()}` : undefined;
}

function Meter({
  label,
  window,
  compact,
  showUsed = true,
}: {
  label: string;
  window: UsageWindow;
  compact?: boolean;
  showUsed?: boolean;
}) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const left = 100 - used;
  const blocks = Math.round(left / (compact ? 10 : 5));
  const empty = Math.max(0, (compact ? 10 : 20) - blocks);
  const barColor = left < 10 ? "#F87171" : left < 25 ? "#FBBF24" : "#34D399";
  const reset = resetLabel(window.resetsAt);

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Box flexShrink={0}><Text color="#94A3B8" bold>
          [{label}]
        </Text></Box>
        <Box flexShrink={0}><Text>
          <Text color={barColor}>{"█".repeat(blocks)}</Text>
          <Text color="#334155">{"█".repeat(empty)}</Text>
        </Text></Box>
        <Box flexShrink={0}><Text color={barColor} bold>
          {left.toFixed(0)}% left
        </Text></Box>
        {showUsed ? (
          <Box flexShrink={0}><Text color="#64748B">
            ({used.toFixed(0)}% used)
          </Text></Box>
        ) : null}
      </Box>
      {reset ? <Text color="#94A3B8" wrap="wrap">{reset}</Text> : null}
    </Box>
  );
}

export function UsageBar({
  limits,
  error,
  width,
  marginTop = 0,
}: {
  limits?: UsageLimits;
  error?: string;
  width?: number;
  marginTop?: number;
}) {
  const compact = width !== undefined && width < 50;
  const showUsed = width === undefined || width >= 42;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#334155" paddingX={1} width={width} marginTop={marginTop}>
      <Text color="#59E6A7" bold>◈ Codex Usage</Text>
      {limits?.primary ? <Meter label={windowLabel(limits.primary)} window={limits.primary} compact={compact} showUsed={showUsed} /> : null}
      {limits?.secondary ? <Meter label={windowLabel(limits.secondary)} window={limits.secondary} compact={compact} showUsed={showUsed} /> : null}
      {error && (limits?.primary || limits?.secondary) ? <Text color="gray">{error} · showing last reading</Text> : null}
      {!limits?.primary && !limits?.secondary ? (
        <Text color="gray">{error ?? "Loading usage…"}</Text>
      ) : null}
    </Box>
  );
}
