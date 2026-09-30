import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { getGitBranch } from "../core/system/git.js";
import { contextPercent, measuredContext } from "../core/context.js";
import type { Session } from "../shared/types.js";

export function contextLabel(session: Session | undefined): string {
  const percent = session && contextPercent(measuredContext(session));
  const gauge = percent === undefined ? "○" : ["○", "◔", "◑", "◕", "●"][Math.min(4, Math.ceil(percent / 25))];
  return `${gauge} Context ${percent === undefined ? "?" : `${percent}%`}`;
}

const paceShadowLetters = [
  ["  ██████╗ ", "  █████╗ ", "  ██████╗ ", "███████╗"],
  ["  ██╔══██╗", " ██╔══██╗", " ██╔════╝ ", "██╔════╝"],
  ["  ██████╔╝", " ███████║", " ██║      ", "█████╗  "],
  ["  ██╔═══╝ ", " ██╔══██║", " ██║      ", "██╔══╝  "],
  ["  ██║     ", " ██║  ██║", " ╚██████╗ ", "███████╗"],
  ["  ╚═╝     ", " ╚═╝  ╚═╝", "  ╚═════╝ ", "╚══════╝"],
] as const;

const paceMicroLetters = [
  ["  █▀█ ", "▄▀█ ", "█▀▀ ", "█▀▀"],
  ["  █▀▀ ", "█▀█ ", "█▄▄ ", "██▄"],
] as const;

export const letterGradients = ["#59E6A7", "#4ADE80", "#2DD4BF", "#38BDF8"] as const;

export function HeaderLogo({ width }: { width: number }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {width >= 42 ? (
        <Box flexDirection="column">
          {paceShadowLetters.map((row, rIdx) => (
            <Box key={rIdx}>
              {row.map((letter, lIdx) => (
                <Text key={lIdx} color={letterGradients[lIdx]} bold>
                  {letter}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : width >= 24 ? (
        <Box flexDirection="column">
          {paceMicroLetters.map((row, rIdx) => (
            <Box key={rIdx}>
              {row.map((letter, lIdx) => (
                <Text key={lIdx} color={letterGradients[lIdx]} bold>
                  {letter}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : (
        <Text color="#59E6A7" bold>
          ⚡ PACE
        </Text>
      )}
    </Box>
  );
}

export function HeaderStatus({
  project,
  vexState,
  width,
  session,
}: {
  project: string;
  vexState: "connecting" | "connected" | "failed";
  width: number;
  session?: Session;
}) {
  const branch = useMemo(() => getGitBranch(project), [project]);
  const dividerLength = Math.max(20, Math.min(width - 4, 72));

  return (
    <Box flexDirection="column" marginBottom={1}>

      <Box gap={1} marginTop={1} flexWrap="wrap">
        <Text color="#A7F3D0" bold>
          📁 {basename(project)}
        </Text>
        {branch ? <Text color="#93C5FD">⎇ {branch}</Text> : null}
        <Text color="#A5B4FC">{contextLabel(session)}</Text>
        <Text
          color={
            vexState === "connected"
              ? "#34D399"
              : vexState === "failed"
                ? "#F87171"
                : "#FBBF24"
          }
        >
          {vexState === "connected"
            ? "● Vex MCP connected"
            : vexState === "failed"
              ? "⨯ Vex MCP unavailable"
              : "◌ Vex MCP connecting..."}
        </Text>
      </Box>

      <Box marginTop={0}>
        <Text dimColor>Type </Text>
        <Text color="#38BDF8" bold>
          /help
        </Text>
        <Text dimColor> for commands · </Text>
        <Text color="#38BDF8" bold>
          !cmd
        </Text>
        <Text dimColor> for bash · </Text>
        <Text color="#38BDF8" bold>
          /models
        </Text>
        <Text dimColor> for routing</Text>
      </Box>

      <Box marginTop={0}>
        <Text color="#334155">{"─".repeat(dividerLength)}</Text>
      </Box>
    </Box>
  );
}

export function Header(props: Parameters<typeof HeaderStatus>[0]) {
  return <Box flexDirection="column"><HeaderLogo width={props.width} /><HeaderStatus {...props} /></Box>;
}
