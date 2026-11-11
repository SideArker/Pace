import { expect, it } from "vitest";
import { updateAgentTasks, taskSummary } from "../src/core/tasks.js";
import { appItemProgress } from "../src/integrations/codex-events.js";
import { updateProcesses } from "../src/components/RunningProcesses.js";
import { RunningProcesses } from "../src/components/RunningProcesses.js";
import React from "react";
import { renderToString } from "ink";

it("mirrors App Server plan steps without managing separate user tasks", () => {
  const progress = appItemProgress({ id: "plan-1", type: "plan", steps: [
    { step: "Run Django tests", status: "inProgress" },
    { step: "Fix failures", status: "completed" },
  ] }, "item/updated", "/project");
  expect(progress).toMatchObject({ kind: "tasks", items: [
    { text: "Run Django tests", completed: false },
    { text: "Fix failures", completed: true },
  ] });
  if (!progress || progress.kind !== "tasks") throw new Error("Missing plan tasks");
  const tasks = updateAgentTasks([{ id: "user-1", text: "Review output", completed: false, source: "user" }], progress.items);
  expect(taskSummary(tasks)).toContain("Run Django tests");
  expect(tasks.every(task => task.source === "agent")).toBe(true);
  expect(updateAgentTasks(tasks, [{ text: "Run Django tests", completed: true }])[0]).toMatchObject({ id: "agent-0", completed: true });
});

it("keeps a command visible until its completed event arrives", () => {
  const started = { kind: "activity" as const, id: "turn-1-cmd", category: "command" as const,
    title: "Running: /usr/bin/python3 manage.py test", completed: false };
  const active = updateProcesses([], "session-1", started, 1000);
  expect(active).toEqual([{ id: "turn-1-cmd", sessionId: "session-1", command: "/usr/bin/python3 manage.py test", startedAt: 1000 }]);
  expect(updateProcesses(active, "session-1", started, 3000)).toBe(active);
  expect(updateProcesses(active, "session-1", { ...started, completed: true }, 4000)).toEqual([]);
});

it("shows current command output and the turn stop action", () => {
  const output = renderToString(React.createElement(RunningProcesses, {
    processes: [{ id: "turn-1-cmd", sessionId: "s", command: "npm test", startedAt: 1000 }], now: 3000,
    lines: [{ id: 1, role: "activity", sourceId: "turn-1-cmd", text: "Running: npm test", spaceBefore: false,
      activity: { category: "command", completed: false, detail: "Suite started\nTest A passed\nTest B passed" } }],
  }), { columns: 80 });
  expect(output).toContain("Test B passed");
  expect(output).toContain("Stop turn: Ctrl+C");
});
