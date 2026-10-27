import { isDebugBuild } from "../../core/build-mode.js";

export const commands = [
  "/plan",
  "/execute",
  "/verify",
  "/models",
  "/mcp",
  "/version",
  "/auto",
  "/manual",
  "/workflow",
  "/new",
  "/convo",
  "/undo",
  "/redo",
  "/diff",
  "/retry",
  "/cancelretry",
  "/btw",
  "/adopt",
  "/artifacts",
  "/links",
  "/debug",
  "/trust",
  "/skills",
  "/stats",
  "/approval",
  "/remote",
  ...(isDebugBuild ? ["/feedback", "/benchmark"] : []),
  "/tasks",
  "/compact",
  "/context",
  "/clear",
  "/exit",
];
export const hiddenCommands = ["/help", "/run-plan", "/turns"];
export const isRegisteredCommand = (input: string, skillNames: readonly string[] = []): boolean => {
  const command = input.trim().split(/\s+/, 1)[0];
  return commands.includes(command) || hiddenCommands.includes(command) || skillNames.includes(command);
};
export const commandArguments: Record<string, string> = {
  "/plan": "[prompt|file]",
  "/execute": "[file] [prompt]",
  "/verify": "[file] [prompt]",
  "/manual": "[model] [effort]",
  "/workflow": "[name|auto]",
  "/approval": "[mode]",
  "/mcp": "[list]",
  "/skills": "[folder|enable|disable|auto|off]",
  "/btw": "<question>",
  "/adopt": "<side-answer-id>",
  "/links": "[number]",
  "/debug": "[turn-number]",
};
export const skillArguments = (skillName: string): string => {
  if (skillName === "caveman") return "[mode]";
  return "[request]";
};
export const commandDescriptions: Record<string, string> = {
  "/plan": "Start/toggle planning or load plan file (e.g. /plan plan.md)",
  "/execute": "Dispatch plan to fresh session via Vex (e.g. /execute [plan.md])",
  "/verify": "Verify plan and propose changes (e.g. /verify [file] [focus prompt])",
  "/models": "Choose model and reasoning effort",
  "/mcp": "Manage external MCP servers interactively",
  "/version": "Show Pace and price catalog versions",
  "/auto": "Let Pace route models automatically",
  "/manual": "Configure workflow stages, models, and effort",
  "/workflow": "Choose workflow strategy (single, scout, plan, scout-plan)",
  "/new": "Start a new conversation",
  "/convo": "Browse and manage conversation turns",
  "/undo": "Revert latest turn and file changes",
  "/redo": "Restore the last undone turn and file changes",
  "/diff": "Browse agent file changes and undo or redo individual files",
  "/retry": "Retry the latest failed request in this conversation",
  "/cancelretry": "Cancel automatic retry and clear its queue",
  "/btw": "Ask a read-only side question with a separate agent",
  "/adopt": "Forward a selected side answer to the active task",
  "/artifacts": "Show generated artifacts",
  "/links": "List transcript links; /links <number> opens a link",
  "/debug": "Inspect local prompt provenance and separate routing decisions",
  "/trust": "Manage trusted project folders",
  "/skills": "Discover and manage agent skills",
  "/stats": "Show conversation stats and token costs",
  "/approval": "Set command approval mode",
  "/remote": "Pair and control this Pace session from a phone",
  ...(isDebugBuild ? { "/benchmark": "Open debug Benchmark Center: run profiles and review results", "/feedback": "Save this conversation locally for review, with an optional comment" } : {}),
  "/tasks": "Show background agent tasks",
  "/compact": "Compact conversation context to save tokens",
  "/context": "Show context window usage breakdown",
  "/clear": "Clear screen and conversation",
  "/exit": "Quit Pace",
};
export const normalizeNewCommand = (input: string) => input.trim().replace(/^(?:\.\/(?!clear(?=\s|$))|\/\.)(new|clear|approval)(?=\s|$)/, "/$1");
