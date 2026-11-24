import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Progress } from "../integrations/codex.js";
import type { Line } from "./Transcript.js";
import { commandRisk } from "../core/command-protection.js";

type Activity = Extract<Progress, { kind: "activity" }>;

export type RunningShell = { sessionId: string; kill: () => boolean };
export type ShellDirectory = { cwd: string; oldpwd?: string };

type ShellRunnerOptions = {
  project: string;
  sessionId: string;
  directories: { current: Map<string, ShellDirectory> };
  nextId: { current: number };
  shells: { current: Set<RunningShell> };
  setShellJobs: (update: (count: number) => number) => void;
  approvalMode: "full-access" | "request-approval" | "limited";
  requestApproval: (command: string, reason: string | undefined, cwd: string) => Promise<boolean>;
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
    const directory = options.directories.current.get(options.sessionId);
    const cwd = directory?.cwd ?? options.project;
    if (options.approvalMode !== "full-access" && (options.approvalMode === "limited" || risk.action === "approve") && !await options.requestApproval(command, risk.reason, cwd)) return;
    const id = `shell-${options.nextId.current++}`;
    options.activity({ kind: "activity", id, category: "command", title: `Running: Bash: ${command}`, completed: false });
    const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
    let metadataDirectory: string | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let cancelled = false;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals): boolean => {
      if (!child?.pid) return false;
      try {
        if (process.platform === "win32") {
          return spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).status === 0;
        }
        return process.kill(-child.pid, signal);
      } catch { return false; }
    };
    const running: RunningShell = {
      sessionId: options.sessionId,
      kill: () => {
        if (closed || cancelled) return false;
        cancelled = true;
        if (!child) return true;
        const killed = killGroup("SIGINT");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 1000);
        killTimer.unref();
        return killed;
      },
    };
    const finish = () => {
      closed = true;
      clearTimeout(killTimer);
      options.shells.current.delete(running);
      options.setShellJobs(count => Math.max(0, count - 1));
    };
    options.shells.current.add(running);
    options.setShellJobs(count => count + 1);
    try {
      metadataDirectory = await mkdtemp(join(tmpdir(), "pace-shell-cwd-"));
      if (cancelled) {
        await rm(metadataDirectory, { recursive: true, force: true });
        finish();
        options.activity({ kind: "activity", id, category: "command", title: `Cancelled: Bash: ${command}`, completed: true, outcome: "failure" });
        return;
      }
      const directoryFile = join(metadataDirectory, "cwd");
      // Capture Bash's own directory changes without parsing cd or mixing metadata into output.
      // shortcut: exec or replacing the EXIT trap skips cwd capture; full shell state needs a persistent shell.
      const reportDirectory = process.platform === "win32"
        ? 'builtin printf "%s\\0" "$(builtin pwd -W)" "$(cygpath -am -- "${OLDPWD-}" 2>/dev/null)" > "$PACE_SHELL_CWD_FILE"'
        : 'builtin printf "%s\\0" "$PWD" "${OLDPWD-}" > "$PACE_SHELL_CWD_FILE"';
      child = spawn(executable, ["--noprofile", "--norc", "-c", `trap '${reportDirectory}' EXIT\n${command}`], {
        cwd,
        env: { ...process.env, PWD: cwd, OLDPWD: directory?.oldpwd,
          PACE_SHELL_CWD_FILE: process.platform === "win32" ? directoryFile.replace(/\\/g, "/") : directoryFile },
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let clipped = false;
      let failed = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const detail = () => `${clipped ? "[earlier output truncated; showing latest 32,768 characters]\n" : ""}${output.trimEnd() || "(no output)"}`;
      const append = (text: string) => {
        output += text;
        if (output.length > 32768) {
          clipped = true;
          output = output.slice(-32768);
        }
        flushTimer ??= setTimeout(() => {
          flushTimer = undefined;
          if (!failed) options.activity({ kind: "activity", id, category: "command", title: `Running: Bash: ${command}`, detail: detail(), completed: false });
        }, 50);
      };
      child.stdout!.setEncoding("utf8").on("data", append);
      child.stderr!.setEncoding("utf8").on("data", append);
      child.on("error", error => {
        failed = true;
        options.activity({ kind: "activity", id, category: "command", title: `Failed: Bash: ${command}`, detail: String(error), completed: true, outcome: "failure" });
      });
      child.on("close", async (code, signal) => {
        closed = true;
        clearTimeout(flushTimer);
        if (cancelled) killGroup("SIGKILL");
        clearTimeout(killTimer);
        const directoryReport = await readFile(directoryFile, "utf8").catch(() => "");
        await rm(metadataDirectory!, { recursive: true, force: true }).catch(error => options.add("error", `Could not remove Bash directory metadata: ${String(error)}`));
        const [nextCwd, oldpwd, end] = directoryReport.split("\0");
        if (!failed && !cancelled && nextCwd && end === "" &&
          options.directories.current.get(options.sessionId) === directory &&
          (nextCwd !== cwd || (oldpwd || undefined) !== directory?.oldpwd)) {
          options.directories.current.set(options.sessionId, { cwd: nextCwd, oldpwd: oldpwd || undefined });
        }
        finish();
        if (!failed) options.activity({
          kind: "activity",
          id,
          category: "command",
          title: `${cancelled ? "Cancelled" : code === 0 ? "Ran" : "Failed"}: Bash: ${command} (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})`,
          detail: detail(),
          completed: true,
          outcome: !cancelled && code === 0 ? "success" : "failure",
        });
      });
    } catch (error) {
      if (metadataDirectory) await rm(metadataDirectory, { recursive: true, force: true }).catch(() => {});
      finish();
      options.activity({ kind: "activity", id, category: "command", title: `Failed: Bash: ${command}`, detail: String(error), completed: true, outcome: "failure" });
    }
  };
}
