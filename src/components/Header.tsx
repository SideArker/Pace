import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { getGitBranch } from "../core/system/git.js";

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
    <Box flexDirection="column">
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
  sessionKind,
}: {
  project: string;
  vexState: "connecting" | "connected" | "failed";
  sessionKind?: "normal" | "planning";
  width?: number;
}) {
  const branch = useMemo(() => getGitBranch(project), [project]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1} flexWrap="wrap">
        <Text color="#A7F3D0" bold>
          📁 {basename(project)}
        </Text>
        {branch ? <Text color="#93C5FD">⎇ {branch}</Text> : null}
        {sessionKind === "planning" ? <Text color="#C084FC" bold>◈ PLANNING</Text> : null}
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
    </Box>
  );
}

export function Header(props: Parameters<typeof HeaderStatus>[0]) {
  return <Box flexDirection="column"><HeaderLogo width={props.width ?? 80} /><HeaderStatus {...props} /></Box>;
}
