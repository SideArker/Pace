import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { Header, Transcript, type Line } from "../src/components/Transcript.js";

describe("Header component", () => {
  it("creates React element without error", () => {
    const el = React.createElement(Header, {
      project: process.cwd(),
      vexState: "connected",
      width: 80,
    });
    expect(el).toBeDefined();
    expect(el.props.project).toBe(process.cwd());
    expect(el.props.vexState).toBe("connected");
  });

  it("handles responsive narrow widths", () => {
    const narrow = React.createElement(Header, {
      project: "/some/path/my-project",
      vexState: "connecting",
      width: 30,
    });
    expect(narrow).toBeDefined();

    const tiny = React.createElement(Header, {
      project: "/some/path/my-project",
      vexState: "failed",
      width: 15,
    });
    expect(tiny).toBeDefined();
  });
});

describe("activity transcript", () => {
  const lines: Line[] = [
    { id: 1, role: "activity", sourceId: "thought-1", text: "Thinking", spaceBefore: false, activity: { category: "thinking", completed: false } },
    { id: 2, role: "activity", text: "Ran: PS (PowerShell): rg -n foo src (exit 0)", spaceBefore: false, activity: { category: "command", completed: true, detail: "Output" } },
  ];
  const render = (completed = false) => renderToString(React.createElement(Transcript, {
    lines: [{ ...lines[0]!, activity: { ...lines[0]!.activity!, completed } }, lines[1]!],
    outputsExpanded: false, detailsExpanded: false, rows: 24, scrollBack: 0,
  }), { columns: 80 });

  it("keeps thinking in the transcript and compacts completed commands", () => {
    const first = render();
    expect(first).toContain("Thinking");
    expect(first).not.toContain("✔");
    expect(first).not.toContain("Ran:");
    expect(first).toContain("</> PS (PowerShell): rg -n foo src (exit 0)");
    expect(first).not.toContain("Output");
    expect(render(true)).toContain("Thinking");
  });

  it("groups adjacent thoughts while keeping every summary available", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: [
        { id: 1, role: "activity", text: "Thinking", spaceBefore: false, activity: { category: "thinking", detail: "First clue", completed: true } },
        { id: 2, role: "activity", text: "Thinking", spaceBefore: false, activity: { category: "thinking", detail: "Second clue", completed: true } },
        { id: 3, role: "activity", text: "Ran: rg foo", spaceBefore: false, activity: { category: "command", completed: true } },
        { id: 4, role: "activity", text: "Thinking", spaceBefore: false, activity: { category: "thinking", detail: "After command", completed: true } },
      ],
      outputsExpanded: false, detailsExpanded: true, rows: 24, scrollBack: 0,
    }), { columns: 80 });
    expect(output).toContain("2 thoughts");
    expect(output).toContain("First clue");
    expect(output).toContain("Second clue");
    expect(output).toContain("</> rg foo");
    expect(output).toContain("After command");
    expect(output).not.toContain("3 thoughts");
  });

  it("renders only one terminal screen of transcript while scrolling back", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: Array.from({ length: 40 }, (_, index) => ({
        id: index,
        role: "info" as const,
        text: `entry-${index}`,
        spaceBefore: false,
      })),
      outputsExpanded: false, detailsExpanded: false, rows: 24, scrollBack: 4,
    }), { columns: 80 });

    expect(output).toContain("entry-24");
    expect(output).toContain("entry-35");
    expect(output).not.toContain("entry-23");
    expect(output).not.toContain("entry-36");
  });
});
