import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { BottomPanel } from "../src/components/BottomPanel.js";
import { Transcript } from "../src/components/Transcript.js";
import { linesFromSession } from "../src/components/session-transcript.js";
import { newSession } from "../src/core/sessions.js";
import { structuredHandoff, planningPrompt } from "../src/core/orchestrator-helpers.js";
import { shapeRequest } from "../src/core/vex/requests.js";
import { projectVexRequest } from "../src/core/vex/context.js";
import { linkOpenCommand, markdownLinks } from "../src/core/system/links.js";
import { showCommandInfo } from "../src/components/app/info-commands.js";
import * as links from "../src/core/system/links.js";
import { debugTurn, redactTrace, tracedRunner, type PromptTrace } from "../src/core/prompt-trace.js";
import { parseSession } from "../src/core/session-record.js";

const report = (count = 25) => ({ summary: "Read relevant routing code", findings: Array.from({ length: count }, (_, i) => ({ path: `src/file-${i}.ts`, line: i + 1, finding: "Evidence ".repeat(180), relevance: "Requested behavior" })), coverage: ["routing entry points and dependencies"], gaps: ["Live app not available; screenshots not taken"], nextSteps: ["Implement"], checks: ["Passed typecheck"], risks: ["Unverified terminal support"] });

describe("large complete scout reports", () => {
  it("preserves all findings and explicit gaps through validation, session reload and transcript", () => {
    const handoff = structuredHandoff(JSON.stringify(report()));
    expect(handoff.length).toBeGreaterThan(20_000);
    expect(JSON.parse(handoff)).toEqual(report());
    const session = newSession("/project", "manual");
    session.turns = [false, true].map(failed => ({ prompt: "Inspect", result: failed ? "Interrupted" : "Done", at: "2026-10-27", failed, scoutHandoff: handoff, stages: [{ objective: "Scout", route: {}, durationMs: 1, handoff }] }));
    const loaded = parseSession(JSON.parse(JSON.stringify(session)), "/project")!;
    const { lines } = linesFromSession(loaded, 1, x => x);
    expect(lines.filter(line => line.role === "handoff").map(line => line.text)).toEqual([handoff, handoff]);
    expect(linesFromSession({ ...session, turns: [{ prompt: "Legacy", result: "Done", at: "today" }] }, 1, x => x).lines.some(line => line.role === "handoff")).toBe(false);
  });
  it.each([{ ...report(1), gaps: [42] }, { ...report(1), findings: [{ path: "x", line: -1, finding: "x", relevance: "x" }] }, { summary: "Missing fields" }])("rejects malformed reports", value => {
    expect(() => structuredHandoff(JSON.stringify(value))).toThrow("Invalid stage handoff");
  });
});

it.each([[18, 2], [24, 4], [42, 8]])("shows height %s capacity %s across Pace and saved sections with stable queue capacity", (height, count) => {
  const choices = Array.from({ length: 16 }, (_, i) => ({ id: `row-${i.toString().padStart(3, "0")}`, prompt: `Task ${i}`, state: "ready" as const, section: i < 8 ? "pace" as const : "saved" as const }));
  for (const width of [60, 100, 160]) {
    const output = renderToString(<BottomPanel width={width} height={height} conversations={{ choices, selectedIndex: 15, focused: true }} queuedPrompts={Array.from({ length: 8 }, (_, i) => `queue-${i}`)} />, { columns: width });
    expect(output.match(/row-\d{3}/g)).toHaveLength(count);
    expect(output).toContain("row-015");
    expect(output).toContain("This pace");
    expect(output).toContain("Saved conversations");
    expect(output).toContain("queue-1");
    expect(output).not.toContain(`queue-${height < 24 ? 2 : 4}`);
    if (height === 42) expect(output.split("\n").length).toBeLessThan(height - 8);
  }
});

it("previews nine plan lines, expands the full entry, and recovers the saved execution handoff", () => {
  const session = newSession("/project", "manual");
  const plan = Array.from({ length: 15 }, (_, i) => `Plan line ${i + 1}`).join("\n");
  session.executionSource = { sessionId: "source", plan, prompt: `Full plan: ${plan}` };
  const { lines } = linesFromSession(session, 1, x => x);
  const folded = renderToString(<Transcript lines={lines} outputsExpanded={false} detailsExpanded={false} />);
  const full = renderToString(<Transcript lines={lines} outputsExpanded detailsExpanded />);
  expect(folded).toContain("Plan line 9");
  expect(folded).not.toContain("Plan line 10");
  expect(folded).toContain("More content folded");
  expect(full).toContain("Plan line 15");
  expect(session.executionSource.prompt).toContain(plan);
});

it("reserves room for a pending question or approval without reducing the queued-message limit", () => {
  const choices = Array.from({ length: 16 }, (_, i) => ({ id: `row-${i.toString().padStart(3, "0")}`, prompt: `Task ${i}`, state: i === 15 ? "question" as const : "ready" as const, section: i < 8 ? "pace" as const : "saved" as const }));
  const output = renderToString(<BottomPanel width={120} height={42} pendingInteraction conversations={{ choices, activeId: "row-000", selectedIndex: 0, focused: false }} queuedPrompts={Array.from({ length: 6 }, (_, i) => `queue-${i}`)} />, { columns: 120 });
  expect(output.match(/row-\d{3}/g)).toHaveLength(2);
  expect(output).toContain("row-015");
  expect(output).toContain("queue-3");
  expect(output).not.toContain("queue-4");
});

it("keeps positive/negative workflow examples protected within the Vex budget", () => {
  for (const request of ["Inspect routing, persistence and UI, then implement fixes", "Capture app screenshots using Argent and compare navigation", "Review this focused diff for correctness"]) {
    const shape = shapeRequest(request, [], [{ model: "gpt-6.1-sol", efforts: ["medium"] }]);
    const result = projectVexRequest(shape);
    expect(result.request.options).toEqual(shape.options);
    expect(result.projection.requiredEvidenceOmitted).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result.request))).toBeLessThan(22000);
    expect(shape.options.find(option => option.id === "scout")?.description).toContain("Positive:");
    expect(shape.options.find(option => option.id === "single")?.description).toContain("Code review itself needs a capable");
    expect(shape.options.find(option => option.id === "clarify")?.description).toContain("actionable command");
  }
});

it("keeps planning native progress/questions in the runtime contract alongside custom instructions", () => {
  const prompt = planningPrompt("Plan it", "/project", "/artifacts/plan.md", undefined, "user customization");
  expect(prompt).toContain("native plan updates");
  expect(prompt).toContain("item/tool/requestUserInput");
  expect(prompt).toContain("user customization");
  expect(prompt).toContain("Only /artifacts is writable");
});

it("opens the numbered supported link using an argument array and never a shell", async () => {
  expect(markdownLinks("[docs](https://example.com/a_(b)) [bad](javascript:alert(1)) ` [code](https://ignored)`")).toEqual([{ label: "docs", target: "https://example.com/a_(b)" }]);
  const target = "https://example.com/$(touch%20bad);anything";
  expect(linkOpenCommand(target, "linux")).toEqual(["xdg-open", [target]]);
  expect(() => linkOpenCommand("javascript:alert(1)")).toThrow();
  const session = newSession("/project", "manual");
  session.turns.push({ prompt: "Read", result: "[docs](https://example.com)", at: "now" });
  const opened = vi.spyOn(links, "openLink").mockResolvedValue();
  const add = vi.fn();
  const options = { session, add } as unknown as Parameters<typeof showCommandInfo>[2];
  try {
    await showCommandInfo("/links", [], options);
    expect(add).toHaveBeenCalledWith("info", expect.stringContaining("1. docs"));
    await showCommandInfo("/links", ["1"], options);
    expect(opened).toHaveBeenCalledWith("https://example.com/");
    await showCommandInfo("/links", ["-1"], options);
    expect(opened).toHaveBeenCalledTimes(1);
  } finally { opened.mockRestore(); }
});

it("captures final transport input separately from Vex and redacts secret values and credentials", async () => {
  const trace: PromptTrace = { version: 1, request: "User", sections: [], calls: [], vex: [{ objective: "workflow", request: "Vex-only text", decision: { choice: "single" } }] };
  const runner = tracedRunner({ run: async (_prompt, _cwd, _route, _thread, progress) => {
    await progress({ kind: "prompt", threadId: "new-thread", input: [{ type: "text", text: "Actual input with artifact instruction" }] });
    return { completed: true, result: "done", threadId: "new-thread" };
  } }, trace);
  await runner.run("Assembled input", "/project", {}, undefined, () => {});
  const session = newSession("/project", "manual");
  session.turns = [{ prompt: "User", result: "done", at: "now", promptTrace: trace }];
  expect(trace.calls[0]?.input).toEqual([{ type: "text", text: "Actual input with artifact instruction" }]);
  expect(trace.calls[0]?.assembledPrompt).not.toContain("Vex-only");
  expect(debugTurn(session)).toContain("NOT Codex input");
  expect(debugTurn(session)).toContain("none (fresh");
  expect(JSON.stringify(redactTrace({ question: "Secret question value", answer: "my answer", prompt: "api_key=abcdefgh Authorization: Bearer abcdefghij" }, ["Secret question value", "my answer"]))).not.toMatch(/Secret question value|my answer|abcdefgh/);
});

it("passes available app skill guidance to the scout and the entire large validated report to completion", async () => {
  const { runPlanningStage } = await import('../src/core/workflow-stages.js');
  const { DEFAULT_ROUTING_PROMPTS } = await import('../src/core/routing/routing-prompts.js');
  const { prepareTurnPrompt } = await import('../src/core/orchestrator-prompts.js');
  let received = '';
  const handoff = await runPlanningStage({ request: 'Inspect the app and capture requested screenshots with Argent', routingTurns: [], enabled: [{ model: "fixture", efforts: ["low"] }], prompts: DEFAULT_ROUTING_PROMPTS,
    choose: async () => { throw Error('Fixed route'); }, routeOverride: { model: 'fixture', effort: 'low' },
    runner: { run: async prompt => { received = prompt; return { completed: true, result: JSON.stringify(report()) }; } },
    session: { projectPath: '/project' }, onProgress: () => {}, stages: [],
    skills: [{ name: 'argent-device-interact', description: 'App screenshots and inspection', path: '/skills/argent-device-interact/SKILL.md' }],
  });
  expect(received).toContain('/skills/argent-device-interact/SKILL.md');
  expect(received).toContain('Do not claim unavailable tools were used');
  const prompt = prepareTurnPrompt({ prompt: 'Deliver requested result', session: newSession('/project','manual'), taskRelation: 'replace', priorTask: undefined, usedThreadForClarification: false, prompts: DEFAULT_ROUTING_PROMPTS, skills: [], handoff }).promptWithHandoff;
  expect(prompt.endsWith(handoff)).toBe(true);
  expect(prompt).toContain('original user request is authoritative');
  expect(JSON.parse(handoff).findings).toHaveLength(25);
});
