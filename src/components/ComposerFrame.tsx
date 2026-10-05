import React from "react";
import { Box, Text } from "ink";
import { contextPercent, measuredContext } from "../core/context.js";
import type { ApprovalMode, Session } from "../shared/types.js";

export function contextLabel(session: Session | undefined): string {
  const percent = session && contextPercent(measuredContext(session));
  const gauge = percent === undefined ? "○" : ["○", "◔", "◑", "◕", "●"][Math.min(4, Math.ceil(percent / 25))];
  return `${gauge} Context ${percent === undefined ? "?" : `${percent}%`}`;
}

export function ComposerFrame({ children, width, session, shellMode, approvalMode = "request-approval" }: {
  children: React.ReactNode;
  width: number;
  session?: Session;
  shellMode: boolean;
  approvalMode?: ApprovalMode;
}) {
  const rule = "─".repeat(Math.max(1, width - 4));
  const mode = shellMode ? "bash" : session?.routingMode === "manual" ? "manual" : "auto";
  const approval = approvalMode === "full-access" ? "Full Access" : approvalMode === "limited" ? "Limited" : "Request Approval";
  const details = `${contextLabel(session)} · ${mode} · ${approval}`;
  const wide = width >= 112;
  const hints = (
    <Box flexDirection={wide ? "row" : "column"} justifyContent={wide ? "space-between" : "flex-start"} width="100%">
      <Text color="#64748B" wrap="truncate">type / for commands · Shift+Enter newline · Alt+V image</Text>
      {width >= 72 ? <Text color="#64748B" wrap="truncate">type ! to run commands</Text> : null}
    </Box>
  );
  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Text color="#334155" wrap="truncate">{rule}</Text>
      {children}
      <Text color="#334155" wrap="truncate">{rule}</Text>
      <Box flexDirection={wide ? "row" : "column"} justifyContent="space-between" width="100%">
        {hints}
        {width < 50 ? <Box flexDirection="column"><Text color="#A5B4FC" wrap="truncate">{`${contextLabel(session)} · ${mode}`}</Text><Text color="#A5B4FC" wrap="truncate">{`Approval: ${approval}`}</Text></Box>
          : <Text color="#A5B4FC" wrap="truncate">{details}</Text>}
      </Box>
    </Box>
  );
}
