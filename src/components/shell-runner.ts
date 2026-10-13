import { spawn } from "node:child_process";
import type { ApprovalDecision, Progress } from "../integrations/codex.js";
import type { Line } from "./Transcript.js";
import { commandRisk } from "../core/command-protection.js";

type Activity = Extract<Progress, { kind: "activity" }>;

type ShellRunnerOptions = {
  project: string;
  nextId: { current: number };
  shells: { current: Set<{ kill: () => boolean }> };
  setShellJobs: (update: (count: number) => number) => void;
  approvalMode: "full-access" | "request-approval" | "limited";
  requestApproval: (command: string, reason?: string) => Promise<boolean>;
  activity: (event: Activity) => void;
  add: (role: Line["role"], text: string) => void;
};

export function oneOffShellCommand(text: string): string | undefined {
  return text.startsWith("!") && text !== "!" ? text.slice(1).trimStart() : undefined;
}

export function manualApprovalCommand(command: string): boolean {
  return commandRisk(command).action === "approve";
}

export function displayCommand(command: string): string {
  if (/^(?:Bash|PS): /i.test(command)) return command;
  const single = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))$/.exec(command.trim());
  if (single) {
    const executable = single[1] ?? single[2] ?? single[3] ?? "";
    return executable.split(/[\\/]+/).at(-1) ?? command;
  }
  const invocation = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/.exec(command.trim());
  if (!invocation) return command;
  const executable = invocation[1] ?? invocation[2] ?? invocation[3] ?? "";
  const args = invocation[4] ?? "";
  const basename = executable.split(/[\\/]+/).at(-1) ?? "";
  const shell = /^(?:powershell|pwsh)(?:\.exe)?$/i.test(basename)
    ? "PS"
    : /^bash(?:\.exe)?$/i.test(basename) ? "Bash" : undefined;
  if (!shell) return executable === basename ? command : `${basename} ${args}`;
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

export function formatCommandStatus(title: string): string {
  const match = /^(?:Running|Ran|Failed): ([\s\S]*?)(?: \(exit [^)]+\))?$/.exec(title);
  const raw = match ? match[1]! : title;
  const shellMatch = /^(?:PS \(PowerShell\)|PS|Bash): ([\s\S]*)$/.exec(raw);
  const isPs = /^(?:PS \(PowerShell\)|PS):/i.test(raw);
  const body = (shellMatch ? shellMatch[1]! : raw).trim().replace(/\s+/g, " ");
  const maxLen = 45;
  const short = body.length > maxLen ? `${body.slice(0, maxLen).trimEnd()}…` : body;
  const shellName = isPs ? "PS" : "Bash";
  return `${shellName}(${short}) ...`;
}

export function previewLines(value: string, limit = 10): string {
  const lines = value.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length <= limit) return lines.join("\n");
  return `${lines.slice(0, limit).join("\n")}\n... <${lines.length - limit} more lines>`;
}

export function previewCommandDetail(detail: string): string {
  const marker = "\n\nOutput:\n";
  const outputAt = detail.indexOf(marker);
  if (outputAt < 0) return previewLines(detail);
  return `${previewLines(detail.slice(0, outputAt))}${marker}${previewLines(detail.slice(outputAt + marker.length))}`;
}

export function summarizeCommand(command: string, maxLength = 80): string {
  const lines = command.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const suffix = lines.length > 1 ? ` ... <${lines.length - 1} more lines>` : "";
  const first = lines[0]?.trim() ?? "";
  const available = Math.max(8, maxLength - suffix.length);
  return `${first.length > available ? `${first.slice(0, available - 3)}...` : first}${suffix}`;
}

export function formatCommandActivity(title: string, detail?: string): { title: string; detail?: string } {
  const match = /^(Running|Ran|Failed): ([\s\S]*?)( \(exit [^)]+\))?$/.exec(title);
  if (!match) return { title, detail: detail === undefined ? undefined : previewLines(detail) };
  const display = displayCommand(match[2]!);
  const output = detail === undefined ? undefined : previewLines(detail);
  if (display === match[2] && !match[2]!.includes("\n")) return { title, detail: output };
  return {
    title: `${match[1]}: ${display}${match[3] ?? ""}`,
    detail: [`Command line: ${previewLines(match[2]!)}`, output ? `Output:\n${output}` : undefined].filter(Boolean).join("\n\n"),
  };
}

export function createShellRunner(options: ShellRunnerOptions) {
  return async (command: string): Promise<void> => {
    const risk = commandRisk(command);
    if (risk.action === "block") { options.add("error", `${risk.reason} Command: ${command}`); return; }
    if (options.approvalMode !== "full-access" && (options.approvalMode === "limited" || risk.action === "approve") && !await options.requestApproval(command, risk.reason)) return;
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
        options.activity({ kind: "activity", id, category: "command", title: `Failed: Bash: ${command}`, detail: String(error), completed: true, outcome: "failure" });
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
          outcome: code === 0 ? "success" : "failure",
        });
      });
    } catch (error) {
      options.add("error", `Shell error: ${String(error)}`);
    }
  };
}
