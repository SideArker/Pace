import { spawn } from "node:child_process";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import type { Line } from "./Transcript.js";

type Activity = Extract<Progress, { kind: "activity" }>;

type ShellRunnerOptions = {
  project: string;
  nextId: { current: number };
  shells: { current: Set<{ kill: () => boolean }> };
  setShellJobs: (update: (count: number) => number) => void;
  requestApproval: (command: string) => Promise<boolean>;
  activity: (event: Activity) => void;
  add: (role: Line["role"], text: string) => void;
};

export function manualApprovalCommand(command: string): boolean {
  return /\bgit\b[^;&|()\n]*\s(?:push|reset)\b/i.test(command);
}

function displayShellCommand(command: string): string | undefined {
  const invocation = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/.exec(command.trim());
  if (!invocation) return undefined;
  const executable = invocation[1] ?? invocation[2] ?? invocation[3] ?? "";
  const args = invocation[4] ?? "";
  const basename = executable.split(/[\\/]+/).at(-1) ?? "";
  const shell = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename)
    ? "PS"
    : /^bash(?:\.exe)?$/i.test(basename) ? "Bash" : undefined;
  if (!shell) return undefined;
  const commandFlag = shell === "Bash"
    ? /(?:^|\s)-(?:c|lc)\s+/i
    : /(?:^|\s)-(?:command|c)\s+/i;
  const flag = commandFlag.exec(args);
  const body = flag ? args.slice(flag.index + flag[0].length).trim() : args.trim();
  const script = body.length >= 2 && body[0] === body.at(-1) && (body[0] === "'" || body[0] === '"')
    ? body.slice(1, -1)
    : body;
  return `${shell}: ${script || args.trim()}`;
}

export function formatCommandActivity(title: string, detail?: string): { title: string; detail?: string } {
  const match = /^(Running|Ran|Failed): ([\s\S]*?)( \(exit [^)]+\))?$/.exec(title);
  if (!match) return { title, detail };
  const display = displayShellCommand(match[2]!);
  if (!display) return { title, detail };
  return {
    title: `${match[1]}: ${display}${match[3] ?? ""}`,
    detail: [`Command line: ${match[2]}`, detail ? `Output:\n${detail}` : undefined].filter(Boolean).join("\n\n"),
  };
}

export function createShellRunner(options: ShellRunnerOptions) {
  return async (command: string): Promise<void> => {
    if (manualApprovalCommand(command) && !await options.requestApproval(command)) return;
    const id = `shell-${options.nextId.current++}`;
    options.activity({ kind: "activity", id, category: "command", title: `Running: Bash: ${command}`, completed: false });
    const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    try {
      const child = spawn(executable, ["--noprofile", "--norc", "-c", command], {
        cwd: options.project,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      options.shells.current.add(child);
      options.setShellJobs(count => count + 1);
      let output = "";
      let clipped = false;
      let failed = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const remaining = 32768 - output.length;
        if (text.length > remaining) clipped = true;
        if (remaining > 0) output += text.slice(0, remaining);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", error => {
        failed = true;
        options.activity({ kind: "activity", id, category: "command", title: `Failed: Bash: ${command}`, detail: String(error), completed: true });
      });
      child.on("close", code => {
        options.shells.current.delete(child);
        options.setShellJobs(count => Math.max(0, count - 1));
        if (!failed) options.activity({
          kind: "activity",
          id,
          category: "command",
          title: `${code === 0 ? "Ran" : "Failed"}: Bash: ${command} (exit ${code ?? "unknown"})`,
          detail: `${output.trimEnd() || "(no output)"}${clipped ? "\n[output truncated]" : ""}`,
          completed: true,
        });
      });
    } catch (error) {
      options.add("error", `Shell error: ${String(error)}`);
    }
  };
}
