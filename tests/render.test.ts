import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { Header, Transcript, splitTranscript, type Line } from "../src/components/Transcript.js";

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
  it("labels routing notices as System messages", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: [{ id: 1, role: "system", text: "Vex routed to GPT-6 Sol High.", spaceBefore: false }],
      outputsExpanded: false, detailsExpanded: false,
    }), { columns: 80 });
    expect(output).toContain("System");
    expect(output).toContain("Vex routed to GPT-6 Sol High.");
  });

  const lines: Line[] = [
    { id: 1, role: "activity", sourceId: "thought-1", text: "Thinking", spaceBefore: false, activity: { category: "thinking", completed: false } },
    { id: 2, role: "activity", text: "Ran: PS (PowerShell): rg -n foo src (exit 0)", spaceBefore: false, activity: { category: "command", completed: true, detail: "Output" } },
  ];
  const render = (completed = false) => renderToString(React.createElement(Transcript, {
    lines: [{ ...lines[0]!, activity: { ...lines[0]!.activity!, completed } }, lines[1]!],
    outputsExpanded: false, detailsExpanded: false,
  }), { columns: 80 });

  it("keeps thinking in the transcript and compacts completed commands", () => {
    const first = render();
    expect(first).toContain("Thinking");
    expect(first).not.toContain("✔");
    expect(first).not.toContain("Ran:");
    expect(first).toContain(">_ PS (PowerShell): rg -n foo src (exit 0)");
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
      outputsExpanded: false, detailsExpanded: true,
    }), { columns: 80 });
    expect(output).toContain("2 thoughts");
    expect(output).toContain("First clue");
    expect(output).toContain("Second clue");
    expect(output).toContain("</> rg foo");
    expect(output).toContain("After command");
    expect(output).not.toContain("3 thoughts");
  });

  it("collapses command, diff, and reasoning details until expanded", () => {
    const lines: Line[] = [
      { id: 1, role: "activity", text: "Ran: build", spaceBefore: false, activity: { category: "command", detail: "command output", completed: true } },
      { id: 2, role: "activity", text: "Edited src/example.ts", spaceBefore: false, activity: { category: "files", detail: "@@ -1 +1 @@\n-old\n+new", completed: true } },
      { id: 3, role: "activity", text: "Thinking", spaceBefore: false, activity: { category: "thinking", detail: "reasoning detail", completed: true } },
    ];
    const render = (expanded: boolean) => renderToString(React.createElement(Transcript, {
      lines, outputsExpanded: expanded, detailsExpanded: expanded,
    }), { columns: 80 });
    const collapsed = render(false);
    expect(collapsed).toContain("Edited src/example.ts");
    expect(collapsed).not.toContain("command output");
    expect(collapsed).not.toContain("-old");
    expect(collapsed).not.toContain("reasoning detail");
    const expanded = render(true);
    expect(expanded).toContain("command output");
    expect(expanded).toContain("-old");
    expect(expanded).toContain("+new");
    expect(expanded).toContain("reasoning detail");
  });

  it("renders the full transcript for terminal history", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: Array.from({ length: 40 }, (_, index) => ({
        id: index,
        role: "info" as const,
        text: `entry-${index}`,
        spaceBefore: false,
      })),
      outputsExpanded: false, detailsExpanded: false,
    }), { columns: 80 });

    expect(output).toContain("entry-0");
    expect(output).toContain("entry-39");
  });

  it("keeps live agent activity out of settled terminal history", () => {
    const lines: Line[] = [
      { id: 1, role: "you", text: "Question", spaceBefore: false },
      { id: 2, role: "activity", text: "Running: test", spaceBefore: false, sourceId: "cmd", activity: { category: "command", completed: false } },
      { id: 3, role: "info", text: "Following notice", spaceBefore: false },
    ];
    const before = splitTranscript(lines);
    expect(before.history.flat().map(line => line.id)).toEqual([1]);
    expect(before.live.map(line => line.id)).toEqual([2, 3]);

    const updated = splitTranscript(lines.map(line => line.id === 2
      ? { ...line, text: "Ran: test", activity: { category: "command" as const, completed: true } }
      : line));
    expect(updated.history.flat().map(line => line.id)).toEqual([1, 2, 3]);
    expect(updated.live).toEqual([]);
    expect(updated.history[0]).toEqual(before.history[0]);
  });
});

describe("Markdown transcript", () => {
  it("emits a terminal hyperlink for Markdown links", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: [{ id: 1, role: "codex", text: "Read [docs](https://example.com/page).", spaceBefore: false }],
      outputsExpanded: false, detailsExpanded: false,
    }), { columns: 80 });
    expect(output).toContain("\u001b]8;;https://example.com/page\u001b\\");
    expect(output).toContain("docs (https://example.com/page)");
    expect(output).toContain("\u001b]8;;\u001b\\");
  });

  it("supports parenthesized URLs and local file links without unsafe schemes", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: [{ id: 1, role: "codex", text: "[web](https://example.com/a_(b)) [file](src/components/App.tsx) [bad](javascript:alert(1))", spaceBefore: false }],
      outputsExpanded: false, detailsExpanded: false,
    }), { columns: 120 });
    expect(output).toContain("\u001b]8;;https://example.com/a_(b)\u001b\\");
    expect(output).toContain("\u001b]8;;file:///");
    expect(output).not.toContain("\u001b]8;;javascript:");
  });

  it("renders common Markdown for assistant and user messages", () => {
    const output = renderToString(React.createElement(Transcript, {
      lines: [
        { id: 1, role: "codex", text: "## Plan", spaceBefore: false },
        { id: 2, role: "codex", text: "Use **bold**, *italic*, `code`, and [docs](https://example.com).", spaceBefore: false },
        { id: 3, role: "codex", text: "- first item", spaceBefore: false },
        { id: 4, role: "codex", text: "> quoted", spaceBefore: false },
        { id: 5, role: "codex", text: "```ts\nconst answer = 42;\n```", spaceBefore: false },
      ],
      outputsExpanded: false, detailsExpanded: false,
    }), { columns: 80 });

    expect(output).toContain("Plan");
    expect(output).toContain("bold");
    expect(output).toContain("italic");
    expect(output).toContain("code");
    expect(output).toContain("docs (https://example.com)");
    expect(output).toContain("• first item");
    expect(output).toContain("│ quoted");
    expect(output).toContain("const answer = 42;");
    expect(output).not.toContain("## Plan");
    expect(output).not.toContain("```ts");
  });
});
