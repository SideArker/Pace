import React from "react";
import { Box, Text } from "ink";
import { menuWindow, truncateWithEllipsis } from "./conversation-menu-utils.js";

export function CommandMenu({
  matches,
  descriptions = {},
  args = {},
  selectedIndex,
  width,
  skillNames,
  autoLaunchSkills = [],
}: {
  matches: string[];
  descriptions?: Record<string, string>;
  args?: Record<string, string>;
  selectedIndex: number;
  width?: number;
  skillNames?: ReadonlySet<string> | readonly string[];
  autoLaunchSkills?: readonly string[];
}) {
  const { start, end } = menuWindow(matches.length, selectedIndex);
  const skillSet = skillNames instanceof Set ? skillNames : new Set(skillNames ?? []);
  const isSkill = (cmd: string) =>
    (cmd.startsWith("/skills auto ") && (skillSet.has(`/${cmd.slice("/skills auto ".length)}`) || skillSet.has(cmd.slice("/skills auto ".length)))) ||
    cmd.startsWith("/@") ||
    cmd.startsWith("@") ||
    skillSet.has(cmd) ||
    skillSet.has(cmd.replace(/^[/@]/, ""));

  const termWidth = width ?? 80;
  const maxColWidth = Math.max(12, Math.min(32, Math.floor(termWidth * 0.4)));
  const commandDisplayLength = (command: string) =>
    command.length + (args[command] ? args[command]!.length + 1 : 0);
  const maxMatchLength = matches.length > 0 ? Math.max(...matches.map(commandDisplayLength)) : 14;
  const commandColWidth = Math.max(12, Math.min(maxColWidth, maxMatchLength));
  const maxDescWidth = Math.max(15, termWidth - commandColWidth - 8);

  const selectedMatch = matches[selectedIndex];
  const selectedDescription = selectedMatch ? descriptions[selectedMatch] : undefined;
  const selectedArg = selectedMatch ? args[selectedMatch] : undefined;

  const visibleMatches = matches.slice(start, end);
  const allVisibleAreSkills = visibleMatches.length > 0 && visibleMatches.every(isSkill);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#475569" paddingX={1} marginTop={1} width={width}>
      <Text color={allVisibleAreSkills ? "#A855F7" : "#38BDF8"} bold>
        {allVisibleAreSkills ? "◈ Skills" : "◈ Commands"}
      </Text>
      {visibleMatches.map((match, offset) => {
        const selected = start + offset === selectedIndex;
        const argText = args[match];
        const rawDesc = descriptions[match] ?? "";
        const firstLine = rawDesc.split(/\r?\n/)[0]?.trim() ?? "";
        const displayDescription = truncateWithEllipsis(firstLine, maxDescWidth);
        const matchIsSkill = isSkill(match);
        const autoSkillName = match.startsWith("/skills auto ") ? match.slice("/skills auto ".length) : match.replace(/^[/@]/, "");
        const onLaunch = matchIsSkill && autoLaunchSkills.includes(autoSkillName);
        const isFirstSkillInWindow = !allVisibleAreSkills && matchIsSkill && (offset === 0 ? false : !isSkill(visibleMatches[offset - 1]!));

        return (
          <React.Fragment key={match}>
            {isFirstSkillInWindow ? (
              <Box marginTop={0}>
                <Text color="#A855F7" bold>◈ Skills</Text>
              </Box>
            ) : null}
            <Box gap={1}>
              <Text color={selected ? "#59E6A7" : "gray"} bold={selected}>
                {selected ? "▶" : " "}
              </Text>
              <Box width={commandColWidth} flexShrink={0}>
                <Text wrap="truncate">
                  <Text color={matchIsSkill ? "#C084FC" : "#38BDF8"} bold>
                    {match}
                  </Text>
                  {argText ? <Text color="#94A3B8"> {argText}</Text> : null}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={selected ? "#CBD5E1" : "#64748B"} wrap="truncate">
                  {onLaunch ? "ON-LAUNCH · " : ""}{truncateWithEllipsis(displayDescription, Math.max(4, maxDescWidth - (onLaunch ? 12 : 0)))}
                </Text>
              </Box>
            </Box>
          </React.Fragment>
        );
      })}
      {matches.length > 5 ? <Text color="#64748B">{start + 1}–{end} of {matches.length}</Text> : null}
      {selectedMatch && selectedDescription ? (
        <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="single" borderColor="#334155" width={width ? Math.max(20, width - 2) : undefined}>
          <Box gap={1}>
            <Text wrap="truncate">
              <Text color={isSkill(selectedMatch) ? "#C084FC" : "#38BDF8"} bold>{selectedMatch}</Text>
              {selectedArg ? <Text color="#94A3B8"> {selectedArg}</Text> : null}
            </Text>
          </Box>
          <Text color="#E2E8F0" wrap="wrap">
            {selectedDescription.split(/\r?\n/).slice(0, 4).join("\n")}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={0}>
        <Text color="#64748B">↑/↓ select · Tab complete · Alt+A toggle skill</Text>
      </Box>
    </Box>
  );
}
