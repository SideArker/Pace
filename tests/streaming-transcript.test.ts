import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToString } from "ink";
import { createTurnRunner, type TurnJob } from "../src/components/turn-runner.js";
import { createTranscriptActions } from "../src/components/app/transcript-actions.js";
import { splitTranscript, Transcript, type Line } from "../src/components/Transcript.js";
import { linesFromSession } from "../src/components/session-transcript.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import type { CodexRunner } from "../src/integrations/codex-types.js";
import type { Config } from "../src/shared/types.js";
import { singleVex } from "./routing-fixture.js";

vi.mock("../src/core/routing/pricing.js", async original => {
  const module = await original<typeof import("../src/core/routing/pricing.js")>();
  return { ...module, refreshVersionManifest: async () => module.currentVersionManifest() };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pace-streaming-ui-")); roots.push(root);
  const store = new PaceStore(join(root, "storage")); const session = newSession(root, "manual");
  session.title = "Streaming"; session.route = { model: "gpt-6-sol", effort: "high" };
  const config: Config = { routingMode: "manual", defaultRoute: session.route, models: [{ model: "gpt-6-sol", efforts: ["high"] }], skillFolder: null };
  const activeSessionId = { current: session.id }; const sessionLines = { current: new Map<string, Line[]>() };
  const jobs = { current: new Map<string, TurnJob>() };
  let visible: Line[] = [];
  const transcript = createTranscriptActions({
    store, activeSessionId, sessionLines, nextId: { current: 1 }, preSessionLines: { current: [] }, lastReasoningTokens: { current: new Map() },
    setLines: value => { visible = typeof value === "function" ? value(visible) : value; }, setProcesses: () => {},
  });
  const runner: CodexRunner = { async run() { return { completed: true, result: "Default result" }; } };
  const runTurn = createTurnRunner({
    turnSequence: { current: 0 }, activeSessionId, jobs, sessionLines, runner,
    promptQueue: { current: new PromptQueue() }, titleAborts: { current: new Map() }, pendingApprovals: { current: new Map() }, pendingQuestions: { current: new Map() }, unreadCompletions: { current: new Set() },
    orchestrator: new Orchestrator(store, runner, singleVex("0:high")), store, rememberSession: () => {}, onTurnStart: () => {},
    setRunningIds: () => {}, ...transcript, resetThoughtUsage: () => {},
    getTurnActivities: (sessionId, turnId) => (sessionLines.current.get(sessionId) ?? []).filter(line => line.sourceId?.startsWith(`turn-${turnId}-`) && line.activity?.completed).map(line => ({ category: line.activity!.category, text: line.text, detail: line.activity!.detail })),
    setStatusFor: () => {}, showApproval: () => {}, showQuestion: () => {}, dismissQuestion: () => {}, setSession: () => {}, setVexState: () => {}, refreshUsage: () => {}, setQueueVersion: () => {}, setProcesses: () => {}, setLiveUsage: () => {}, getConfig: () => config,
  });
  return { root, session, store, config, runner, runTurn, transcript, jobs, activeSessionId, sessionLines, lines: () => sessionLines.current.get(session.id) ?? [], visible: () => visible };
}

it("redraws partial messages in place, preserves chronological order, and settles final text once", async () => {
  const env = await fixture();
  env.runner.run = async (_prompt, _project, _route, _thread, output) => {
    await output({ kind: "message", id: "first", text: "Checking", completed: false });
    const firstId = env.lines().find(line => line.role === "codex")!.id;
    expect(splitTranscript(env.lines()).live.some(line => line.id === firstId)).toBe(true);
    expect(splitTranscript(env.lines()).history.flat().some(line => line.id === firstId)).toBe(false);
    await output({ kind: "message", id: "first", text: "Checking files", completed: false });
    await output({ kind: "message", id: "first", text: "Checked files.", completed: true });
    expect(env.lines().filter(line => line.role === "codex")).toMatchObject([{ id: firstId, text: "Checked files.", streaming: false }]);
    await output({ kind: "activity", id: "command", category: "command", title: "Running: npm test", detail: "One test", completed: false });
    await output({ kind: "activity", id: "command", category: "command", title: "Ran: npm test", detail: "All tests passed", completed: true });
    await output({ kind: "message", id: "second", text: "Finishing", completed: false });
    await output({ kind: "message", id: "second", text: "Finished.", completed: true });
    return { completed: true, result: "Finished.", threadId: "thread" };
  };
  expect(await env.runTurn("Work", env.session, env.config)).toBe(true);
  expect(env.lines().filter(line => line.role === "codex" || line.role === "activity").map(line => line.text)).toEqual(["Checked files.", "Ran: npm test", "Finished."]);
  expect(splitTranscript(env.lines()).live).toEqual([]);
  const loaded = (await env.store.load(env.root, env.session.id))!;
  expect(loaded.turns.at(-1)?.result).toBe("Finished.");
  expect(loaded.turns.at(-1)?.activities).toMatchObject([{ detail: "All tests passed" }]);
});

for (const cancelled of [false, true]) it(`keeps partial text and settles its row after ${cancelled ? "cancellation" : "stream failure"}`, async () => {
  const env = await fixture();
  env.runner.run = async (_prompt, _project, _route, _thread, output) => {
    await output({ kind: "message", id: "partial", text: "Partial", completed: false });
    await output({ kind: "message", id: "partial", text: "Partial answer", completed: false });
    if (cancelled) env.jobs.current.get(env.session.id)!.controller.abort();
    throw new Error("Stream interrupted");
  };
  expect(await env.runTurn("Work", env.session, env.config)).toBe(false);
  expect(env.lines().filter(line => line.role === "codex")).toMatchObject([{ text: "Partial answer", streaming: false }]);
  expect(splitTranscript(env.lines()).live).toEqual([]);
  const loaded = (await env.store.load(env.root, env.session.id))!;
  expect(loaded.attempts![0]!.observations.filter(item => item.kind === "answer")).toEqual([{ kind: "answer", text: "Partial answer" }]);
});

it("keeps stream updates isolated by session and attempt, including background conversations", async () => {
  const env = await fixture();
  env.transcript.addFor(env.session.id, "codex", "Main partial", { sourceId: "main-message", streaming: true });
  const mainVisible = env.visible();
  env.transcript.addFor("background", "codex", "Background partial", { sourceId: "main-message", streaming: true });
  env.transcript.addFor("background", "codex", "Background final", { sourceId: "main-message", streaming: false });
  expect(env.visible()).toBe(mainVisible);
  expect(env.sessionLines.current.get("background")).toMatchObject([{ text: "Background final", streaming: false }]);
  env.transcript.addFor(env.session.id, "codex", "Another attempt", { sourceId: "other-message", streaming: false });
  env.transcript.addFor(env.session.id, "codex", "Main final", { sourceId: "main-message", streaming: false });
  expect(env.lines().map(line => line.text)).toEqual(["Main final", "Another attempt"]);
});

it("updates task snapshots during the turn and restores reasoning summaries behind the detail toggle", async () => {
  const env = await fixture();
  env.runner.run = async (_prompt, _project, _route, _thread, output) => {
    await output({ kind: "tasks", items: [{ text: "Inspect code", completed: false }] });
    expect(env.session.tasks?.[0]).toMatchObject({ text: "Inspect code", completed: false });
    await output({ kind: "activity", id: "thinking", category: "thinking", title: "Thinking", detail: "Checking", completed: false });
    await output({ kind: "activity", id: "thinking", category: "thinking", title: "Thinking", detail: "Checked repository", completed: true });
    await output({ kind: "tasks", items: [{ text: "Inspect code", completed: true }] });
    expect(env.session.tasks?.[0]?.completed).toBe(true);
    return { completed: true, result: "Done" };
  };
  await env.runTurn("Work", env.session, env.config);
  const loaded = (await env.store.load(env.root, env.session.id))!;
  const { lines } = linesFromSession(loaded, 1, reference => reference);
  const render = (expanded: boolean) => renderToString(React.createElement(Transcript, { lines, outputsExpanded: expanded, detailsExpanded: expanded }), { columns: 80 });
  expect(render(false)).not.toContain("Checked repository");
  expect(render(true)).toContain("Checked repository");
  expect(loaded.turns.at(-1)?.activities).toMatchObject([{ category: "thinking", detail: "Checked repository" }]);
});
