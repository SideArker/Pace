export type CommandRisk = { action: "allow" | "approve" | "block"; reason?: string };

// This is a guard for recognizable command lines, not a shell parser or a sandbox.
// Check the whole line so wrappers such as `bash -c` and command chains are covered.
export function commandRisk(command: string): CommandRisk {
  const text = command.replace(/\\\s*\n/g, " ").trim();
  if (/\brm\s+(?:(?:-[^\s]*[rR][^\s]*[fF][^\s]*|-[^\s]*[fF][^\s]*[rR][^\s]*|-[rR]\s+-[fF]|-[fF]\s+-[rR]|--recursive\s+--force|--force\s+--recursive)\s+)(?:--\s+)?(?:\/|~\/|\$HOME\/)(?:\S*)/i.test(text) ||
      /\b(?:mkfs(?:\.[\w-]+)?|wipefs|shred)\b/i.test(text) ||
      /\bdd\b[^\n;&|]*\bof=\/dev\//i.test(text) ||
      /\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+)?(?:bash|sh)\b/i.test(text)) {
    return { action: "block", reason: "Blocked a destructive disk or remote-script command." };
  }
  if (/\bgit\b[^;&|()\n]*\s(?:push|reset|clean)\b/i.test(text) ||
      /\brm\s+(?:-[^\s]*[rR][^\s]*\s+|--recursive\s+)/i.test(text) ||
      /\b(?:sudo|doas)\b/i.test(text) ||
      /\b(?:chmod\s+(?:-[^\s]+\s+)*777|chown\s+-R)\b/i.test(text) ||
      /\b(?:curl|wget)\b[^\n;]*\s(?:--data(?:-binary|-raw)?|-d|--upload-file|-T)\b/i.test(text)) {
    return { action: "approve", reason: "This command may change protected data, publish changes, or send data externally." };
  }
  return { action: "allow" };
}
