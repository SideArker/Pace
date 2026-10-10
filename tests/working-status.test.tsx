import React from "react";
import { renderToString } from "ink";
import { expect, it } from "vitest";
import { WorkingStatus } from "../src/components/WorkingStatus.js";

it("puts the action, live usage, and tip on separate rows", () => {
  for (const width of [40, 80]) {
    const output = renderToString(<WorkingStatus
      busy status="Thinking..." runningCount={1} shellJobs={0} tick={0}
      usage="120 input · 30 output · ~$0.0020" tip="Use /context"
    />, { columns: width });
    const lines = output.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Thinking...");
    expect(lines[0]).not.toContain("input");
    expect(lines[0]).not.toContain("Tip:");
    expect(lines[1]).toContain("120 input · 30 output");
    expect(lines[2]).toContain("Tip: Use /context");
    expect(lines.every(line => line.length <= width)).toBe(true);
  }
});

it("shows only available rows and keeps background work on the action row", () => {
  const tipOnly = renderToString(<WorkingStatus
    busy status="Editing files" runningCount={1} shellJobs={0} tick={1} tip="Use /tasks"
  />).trim().split("\n");
  expect(tipOnly).toHaveLength(2);
  expect(tipOnly[0]).toContain("Editing files");
  expect(tipOnly[1]).toContain("Tip: Use /tasks");

  const background = renderToString(<WorkingStatus
    busy={false} status="Ready" runningCount={2} shellJobs={1} tick={2}
    usage="old usage" tip="old tip"
  />).trim().split("\n");
  expect(background).toHaveLength(1);
  expect(background[0]).toContain("2 background turns running");
  expect(background[0]).toContain("1 Bash command running");
  expect(background[0]).not.toContain("old usage");
  expect(background[0]).not.toContain("old tip");

  expect(renderToString(<WorkingStatus busy={false} status="Ready" runningCount={0} shellJobs={0} tick={0} />)).toBe("");
});
