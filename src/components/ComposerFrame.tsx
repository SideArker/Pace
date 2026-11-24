import React from "react";
import { Box, Text } from "ink";
import { contextPercent, measuredContext } from "../core/context.js";
import type { ApprovalMode, Session } from "../shared/types.js";
import { useTheme } from "../shared/colors.js";

import { terminalLayout } from "./layout.js";

export function contextLabel(session: Session | undefined): string {
  const percent = session && contextPercent(measuredContext(session));
  const gauge = percent === undefined ? "○" : ["○", "◔", "◑", "◕", "●"][Math.min(4, Math.ceil(percent / 25))];
  return `${gauge} Context ${percent === undefined ? "?" : `${percent}%`}`;
}

export function ComposerFrame({ children, width, session, shellMode, shellCwd, approvalMode = "request-approval", memoryEnabled = false, memoryUnavailable = false, compact = false }: {
  children: React.ReactNode;
  width: number;
  session?: Session;
  shellMode: boolean;
  shellCwd?: string;
  approvalMode?: ApprovalMode;
  memoryEnabled?: boolean;
  memoryUnavailable?: boolean;
  compact?: boolean;
}) {
  const theme = useTheme(session?.kind);
  const isPlanning = session?.kind === "planning";
  const rule = "─".repeat(Math.max(1, width - 4));
  const mode = shellMode ? "bash" : session?.routingMode === "manual" ? "manual" : "auto";
  const approval = approvalMode === "full-access" ? "Full Access" : approvalMode === "limited" ? "Limited" : "Request Approval";
  const details = `${isPlanning ? "◈ PLANNING · " : ""}${contextLabel(session)} · ${mode} · ${approval}`;
  const layout = terminalLayout(width);
  const wide = layout.wideComposer;
  const hints = (
    <Box flexDirection={wide ? "row" : "column"} justifyContent={wide ? "space-between" : "flex-start"} width={wide ? undefined : "100%"} flexGrow={wide ? 1 : 0} flexShrink={1}>
      <Text color={isPlanning ? theme.accent : theme.dim} wrap="truncate">
        {shellMode ? `cwd: ${shellCwd ?? session?.projectPath ?? ""}` : layout.narrow ? (isPlanning ? "/execute · /verify · Alt+P plan" : "/ commands · ← review") : isPlanning ? "/execute to run plan · /verify to review · Shift+Enter newline" : "/ for commands · ← at start: review · Shift+Enter newline"}
      </Text>
      {width >= 72 ? <Text color={theme.dim} wrap="truncate">{isPlanning ? "Alt+P/Ctrl+P toggle plan" : "! for shell"}</Text> : null}
    </Box>
  );
  return (
    <Box flexDirection="column" width="100%" marginTop={compact ? 0 : 1} flexShrink={0}>
      <Text color={theme.border} wrap="truncate">{rule}</Text>
      {children}
      {!compact ? <Text color={theme.border} wrap="truncate">{rule}</Text> : null}
      {!compact ? <>
      <Box flexDirection={wide ? "row" : "column"} justifyContent="space-between" gap={wide ? 2 : 0} width="100%">
        {hints}
        {layout.narrow ? <Box flexDirection="column"><Text color={theme.muted} wrap="truncate">{`${isPlanning ? "[PLAN] " : ""}${contextLabel(session)} · ${mode}`}</Text><Text color={theme.muted} wrap="truncate">{`Approval: ${approval}`}</Text></Box>
          : <Box flexShrink={0}><Text color={theme.muted} wrap="truncate">{details}</Text></Box>}
      </Box>
      {memoryEnabled ? <Text color={memoryUnavailable ? theme.warning : theme.secondary} wrap="truncate">Memory Enabled{memoryUnavailable ? ' · connection/configuration unavailable' : ''}</Text> : null}
      </> : null}
    </Box>
  );
}
