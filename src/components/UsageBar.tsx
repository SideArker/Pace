import React from "react";
import { Box, Text } from "ink";
import type { UsageLimits, UsageWindow } from "../integrations/usage.js";

function Meter({ label, window }: { label: string; window: UsageWindow }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const blocks = Math.round(used / 10);
  return <Box gap={1}><Text color="gray">{label}</Text><Text color={used > 85 ? "yellow" : "greenBright"}>{"━".repeat(blocks)}</Text><Text color="gray">{"╍".repeat(10 - blocks)} {Math.round(100 - used)}% left</Text></Box>;
}

export function UsageBar({ limits, error }: { limits?: UsageLimits; error?: string }) {
  return <Box flexDirection="column" marginLeft={2}>
    {limits?.primary ? <Meter label={windowLabel(limits.primary)} window={limits.primary} /> : null}
    {limits?.secondary ? <Meter label={windowLabel(limits.secondary)} window={limits.secondary} /> : null}
    {!limits?.primary && !limits?.secondary ? <Text color="gray">{error ?? "Loading usage…"}</Text> : null}
  </Box>;
}

function windowLabel(window: UsageWindow): string {
  const minutes = window.windowDurationMins;
  return minutes === null ? "Window" : minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
