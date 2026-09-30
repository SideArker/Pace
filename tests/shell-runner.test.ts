import { expect, it } from "vitest";
import { createShellRunner, displayCommand, formatCommandActivity, oneOffShellCommand } from "../src/components/shell-runner.js";

it("accepts one-off Bash commands with or without a space", () => {
  expect(oneOffShellCommand("!pwd")).toBe("pwd");
  expect(oneOffShellCommand("! pwd")).toBe("pwd");
  expect(oneOffShellCommand("!")).toBeUndefined();
  expect(oneOffShellCommand("plain prompt")).toBeUndefined();
});

it("asks before every typed command in limited mode", async () => {
  const requested: string[] = [];
  const events: string[] = [];
  const run = createShellRunner({
    project: process.cwd(), nextId: { current: 0 }, shells: { current: new Set() },
    setShellJobs: () => {}, approvalMode: "limited",
    requestApproval: async command => { requested.push(command); return false; },
    activity: event => { events.push(event.title); }, add: () => {},
  });
  await run("pwd");
  expect(requested).toEqual(["pwd"]);
  expect(events).toEqual([]);
});

it("uses shell aliases and short executable names while keeping command details", () => {
  expect(displayCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-ChildItem"')).toBe('PS: Get-ChildItem');
  expect(displayCommand('/usr/bin/python3 manage.py test')).toBe('python3 manage.py test');
  expect(formatCommandActivity('Running: /usr/bin/python3 manage.py test')).toEqual({
    title: 'Running: python3 manage.py test', detail: 'Command line: /usr/bin/python3 manage.py test',
  });
});
