import React from "react";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/components/App.js";
import { PaceStore } from "../src/core/sessions.js";
import { FileEdits } from "../src/core/file-edits.js";
import { VexRouter } from "../src/core/vex/client.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import { COLOR_SCHEMES } from "../src/shared/colors.js";
import * as pricing from "../src/core/routing/pricing.js";
import * as models from "../src/integrations/models.js";
import * as usage from "../src/integrations/usage.js";
import * as npmVersion from "../src/core/npm-version.js";
import * as skills from "../src/core/system/skills.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import * as memoryConfig from '../src/core/memory/config.js';
import * as globalMemory from '../src/core/memory/global.js';
import { memorySetupService } from '../src/core/memory/setup.js';

vi.mock("../src/benchmark/preferences.js",()=>({loadPreferences:async()=>undefined,savePreferences:async()=>{},baselineChoices:async()=>[]}));

class Terminal extends Writable {
  isTTY = true;
  columns = 120;
  rows = 40;
  writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.writes.push(chunk.toString());
    done();
  }
}

const instances: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function mount(dimensions?: { columns: number; rows: number }) {
  vi.spyOn(memoryConfig, 'loadMemory').mockResolvedValue({ state: 'unconfigured' });
  vi.spyOn(globalMemory, 'loadGlobalMemory').mockResolvedValue({});
  vi.spyOn(PaceStore.prototype, "loadConfig").mockResolvedValue({ ...structuredClone(DEFAULT_CONFIG), skillFolder: null });
  vi.spyOn(PaceStore.prototype, "listProjects").mockResolvedValue([]);
  const save = vi.spyOn(PaceStore.prototype, "saveChanges").mockResolvedValue();
  const saveFeedback = vi.spyOn(PaceStore.prototype, "saveFeedback").mockResolvedValue("/tmp/pace/feedback/inbox/feedback.json");
  vi.spyOn(VexRouter.prototype, "start").mockResolvedValue();
  vi.spyOn(VexRouter.prototype, "close").mockResolvedValue();
  vi.spyOn(pricing, "refreshVersionManifest").mockResolvedValue(pricing.currentVersionManifest());
  vi.spyOn(models, "readAvailableModels").mockResolvedValue([]);
  vi.spyOn(usage, "readUsageLimits").mockResolvedValue({});
  vi.spyOn(npmVersion, "latestNpmVersion").mockResolvedValue(undefined);
  vi.spyOn(skills, "configuredSkills").mockResolvedValue([]);
  const stdout = Object.assign(new Terminal(), dimensions);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const onClear = vi.fn();
  const instance = render(<App onClear={onClear} />, {
    stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
    alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  await vi.waitFor(() => expect(stdout.writes.join("")).toMatch(/Ask Pace or type \/|Resize terminal/));
  await instance.waitUntilRenderFlush();
  return {
    stdout, stdin, instance, onClear, save, saveFeedback,
    async submit(text: string) {
      stdin.write(text);
      await instance.waitUntilRenderFlush();
      stdin.write("\r");
      await instance.waitUntilRenderFlush();
    },
  };
}

it("keeps the composer at 40 × 10 and requests resize below that boundary", async () => {
  const minimum = await mount({ columns: 40, rows: 10 });
  expect(minimum.stdout.writes.join("")).toContain("Ask Pace or type /");
  const tooSmall = await mount({ columns: 39, rows: 9 });
  expect(tooSmall.stdout.writes.join("")).toContain("Resize terminal to at least 40 × 10.");
});

it("dispatches information commands and the planning shortcut through the mounted application", async () => {
  const ui = await mount();
  await ui.submit("/tasks");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Codex has not published a plan"));
  ui.stdin.write("\x1bp");
  await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "planning" })));
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Planning mode active"));
});

for (const menu of [false, true]) it(`selects manual routing through ${menu ? "the menu" : "a command"} before sending any agent prompt`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-fresh-manual-ui-"));
  const isolated = new PaceStore(root);
  const saveChanges = PaceStore.prototype.saveChanges;
  const update = PaceStore.prototype.update;
  const ui = await mount();
  try {
    ui.save.mockImplementation(session => saveChanges.call(isolated, session, false));
    vi.spyOn(PaceStore.prototype, "update").mockImplementation((identity, mutate) => update.call(isolated, identity, mutate, false));
    const turn = vi.spyOn(Orchestrator.prototype, "turn");
    if (menu) {
      await ui.submit("/manual ");
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Manual workflow"));
      for (const moves of [1, 2, 2]) {
        for (let index = 0; index < moves; index++) { ui.stdin.write("\x1b[B"); await ui.instance.waitUntilRenderFlush(); }
        ui.stdin.write("\r"); await ui.instance.waitUntilRenderFlush();
      }
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Manual single workflow saved"));
    } else {
      await ui.submit("/manual gpt-6.2-sol high");
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Manual routing enabled:"));
    }
    const session = ui.save.mock.calls[0]![0];
    expect(await isolated.load(session.projectPath, session.id)).toMatchObject({ routingMode: "manual", turns: [],
      ...(menu ? { manualWorkflow: { shape: "single", routes: { final: { model: "gpt-6.2-sol", effort: "high" } } } } : { route: { model: "gpt-6.2-sol", effort: "high" } }),
    });
    expect(turn).not.toHaveBeenCalled();
  } finally { ui.instance.unmount(); await rm(root, { recursive: true, force: true }); }
});

it("saves feedback with or without an optional comment", async () => {
  const ui = await mount();
  await ui.submit("/feedback");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toMatch(/Feedback saved locally|Could not save feedback|Unknown command/));
  expect(ui.saveFeedback).toHaveBeenCalledWith(expect.anything(), "");
  await ui.submit("/feedback The answer missed the requested constraint");
  await vi.waitFor(() => expect(ui.saveFeedback).toHaveBeenLastCalledWith(expect.anything(), "The answer missed the requested constraint"));
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Feedback saved locally: /tmp/pace/feedback/inbox/feedback.json"));
});

it("clears and remounts terminal history only when terminal dimensions change", async () => {
  const ui = await mount();
  ui.stdout.emit("resize");
  await ui.instance.waitUntilRenderFlush();
  expect(ui.onClear).not.toHaveBeenCalled();
  ui.stdout.columns = 80;
  ui.stdout.rows = 24;
  ui.stdout.emit("resize");
  await ui.instance.waitUntilRenderFlush();
  expect(ui.onClear).toHaveBeenCalledOnce();
  ui.stdout.emit("resize");
  await ui.instance.waitUntilRenderFlush();
  expect(ui.onClear).toHaveBeenCalledOnce();
});

it("starts a fresh conversation after planning through the composed session actions", async () => {
  const ui = await mount();
  ui.stdin.write("\x1bp");
  await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "planning" })));
  const planning = ui.save.mock.calls.find(([session]) => session.kind === "planning")![0];

  await ui.submit("/new");
  await vi.waitFor(() => expect(ui.save.mock.calls.some(([session]) => session.id !== planning.id)).toBe(true));
  const fresh = ui.save.mock.calls.find(([session]) => session.id !== planning.id)![0];
  expect(fresh.kind).toBeUndefined();
  expect(fresh.id).not.toBe(planning.id);
  expect(fresh.turns).toEqual([]);
  expect(ui.onClear).toHaveBeenCalledOnce();

  await ui.submit("/tasks");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Codex has not published a plan"));
});

for (const command of ["/new", "/plan", "/execute"]) {
  for (const fail of [false, true]) it(`${command} preserves fresh-session activation and rollback (save failure: ${fail})`, async () => {
    const ui = await mount();
    ui.stdin.write("\x1bp");
    await ui.instance.waitUntilRenderFlush();
    await vi.waitFor(() => expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "planning" })));
    const source = ui.save.mock.calls.find(([session]) => session.kind === "planning")![0];
    source.title = "Original plan";
    source.plan = "# Saved plan\nImplement all requirements.";
    source.turns.push({ prompt: "Plan request", result: "Saved plan", at: "now" });
    const turn = vi.spyOn(Orchestrator.prototype, "turn").mockImplementation(async (_prompt, session) => ({
      session, result: "Execution finished", note: "Test route", route: session.route,
      durationMs: 1, artifacts: [], stages: [], routing: [],
    }));
    let freshWrites = 0;
    ui.save.mockImplementation(async target => {
      if (target.id === source.id) return;
      freshWrites++;
      // /execute first persists the prepared execution, then activates it.
      if (fail && (command !== "/execute" || freshWrites > 1)) throw new Error("disk full");
    });
    await ui.submit(command);
    if (command !== "/new") {
      // Commands with optional arguments first accept completion's trailing space.
      ui.stdin.write("\r");
      await ui.instance.waitUntilRenderFlush();
    }
    if (fail) {
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("disk full"));
      expect(ui.onClear).not.toHaveBeenCalled();
      expect(turn).not.toHaveBeenCalled();
      await ui.submit("/tasks");
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Codex has not published a plan"));
    } else {
      await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledOnce());
      const fresh = ui.save.mock.calls.find(([session]) => session.id !== source.id)![0];
      expect(fresh.turns).toEqual([]);
      expect(fresh.kind).toBe(command === "/new" ? undefined : command === "/plan" ? "planning" : "normal");
      if (command === "/execute") {
        await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
        expect(turn.mock.calls[0]?.[0]).toContain(source.plan);
        expect(turn.mock.calls[0]?.[1].id).toBe(fresh.id);
        expect(turn.mock.calls[0]?.[6]).toBe("execute_plan");
      } else expect(turn).not.toHaveBeenCalled();
    }
  });
}

it("opens Benchmark Center through the composed debug command without starting a turn", async () => {
  const ui = await mount();
  const turn = vi.spyOn(Orchestrator.prototype, "turn");
  await ui.submit("/benchmark");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Benchmark Center"));
  expect(turn).not.toHaveBeenCalled();
  ui.stdin.write("\x1b");
  await ui.instance.waitUntilRenderFlush();
});
it('opens benchmark results during a main job and blocks Start without cancelling the job',async()=>{
 const ui=await mount();let complete:(value:any)=>void=()=>{};let mainSignal:AbortSignal|undefined;
 const turn=vi.spyOn(Orchestrator.prototype,'turn').mockImplementation(async(_prompt,session,_config,_progress,signal)=>{mainSignal=signal;return await new Promise(resolve=>{complete=()=>resolve({session,result:'Finished mock main job',route:session.route,note:'Mock route',durationMs:1,stages:[],routing:[],artifacts:[]});});});
 await ui.submit('Keep this mocked job active');await vi.waitFor(()=>expect(turn).toHaveBeenCalledOnce());
 await ui.submit('/benchmark');await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Benchmark Center'));
 for(const ready of ['❯ Scout → same / fresh completion thread','❯ quick','❯ Start']){ui.stdin.write('\r');await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain(ready));await ui.instance.waitUntilRenderFlush();}
 ui.stdin.write('\r');await ui.instance.waitUntilRenderFlush();
 await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Wait for main/side jobs'));
 expect(turn).toHaveBeenCalledOnce();expect(mainSignal?.aborted).toBe(false);complete(undefined);
});

it('shows the execution plan preview and toggles the full handoff with Ctrl+O', async () => {
  const ui = await mount();
  ui.stdin.write('\x1bp'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({kind:'planning'})));
  const source = ui.save.mock.calls.find(([session]) => session.kind === 'planning')![0];
  source.plan = Array.from({length:15},(_,i)=>`Execution requirement ${i+1}`).join('\n');
  source.title = 'Plan'; source.turns.push({prompt:'Plan',result:'Saved',at:'now'});
  const turn = vi.spyOn(Orchestrator.prototype,'turn').mockImplementation(async(prompt,session)=>({session,result:'Done',route:session.route,note:'Mock',durationMs:1,stages:[],routing:[],artifacts:[]}));
  await ui.submit('/execute'); ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(()=>expect(turn).toHaveBeenCalledOnce());
  await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Execution requirement 9'));
  expect(ui.stdout.writes.join('')).not.toContain('Execution requirement 10');
  expect(turn.mock.calls[0]?.[0]).toContain(source.plan);
  ui.stdout.writes.length=0; ui.stdin.write('\x0f'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Execution requirement 15'));
  ui.stdout.writes.length=0; ui.stdin.write('\x0f'); await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).not.toContain('Execution requirement 15');
});

it('planning displays native tasks and interactive questions, and keeps output inspection available', async () => {
  const ui = await mount();
  ui.stdin.write('\x1bp'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(()=>expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({kind:'planning'})));
  const turn = vi.spyOn(Orchestrator.prototype,'turn').mockImplementation(async(_prompt,session,_config,progress)=>{
    session.tasks=[{id:'native-plan',text:'Inspect dependencies',completed:false,source:'agent'}];
    progress({kind:'tasks',items:[{text:'Inspect dependencies',completed:false}]});
    await new Promise<void>(resolve=>progress({kind:'question',id:'question',questions:[{id:'target',header:'Target',question:'Which platform?',options:[{label:'Android',description:'Android target'}],isSecret:false,isOther:true}],respond:()=>resolve()}));
    return {session,result:'Plan choice recorded',route:session.route,note:'Mock',durationMs:1,stages:[],routing:[],artifacts:[]};
  });
  await ui.submit('Plan platform work');
  await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Which platform?'));
  expect(ui.stdout.writes.join('')).toContain('Codex plan');
  ui.stdin.write('\x0f'); await ui.instance.waitUntilRenderFlush(); expect(ui.onClear).toHaveBeenCalled();
  ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Plan choice recorded'));
  expect(turn).toHaveBeenCalledOnce();
});

it.each([
  { repo: true, global: false, enabled: true },
  { repo: false, global: true, enabled: true },
  { repo: true, global: true, enabled: true },
  { repo: false, global: false, enabled: false },
])('shows Memory Enabled beneath the composer for repo=$repo global=$global', async ({ repo, global, enabled }) => {
  const ui = await mount();
  vi.mocked(memoryConfig.loadMemory).mockResolvedValue({ state: repo ? 'ready' : 'disabled', config: { enabled: repo } as memoryConfig.MemoryConfig });
  vi.mocked(globalMemory.loadGlobalMemory).mockResolvedValue({ config: { version: 1, revision: '11111111-1111-4111-8111-111111111111', enabled: global, content: 'Prefer Polish.' } });
  vi.spyOn(memorySetupService, 'load').mockResolvedValue({ state: 'unconfigured' });
  vi.spyOn(memorySetupService, 'loadGlobal').mockResolvedValue({});
  ui.stdout.writes.length = 0;
  await ui.submit('/memory');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Set up project memory'));
  ui.stdout.writes.length = 0; ui.stdin.write('\x1b');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Ask Pace or type /'));
  await ui.instance.waitUntilRenderFlush();
  const output = ui.stdout.writes.join('');
  expect(output.includes('Memory Enabled')).toBe(enabled);
  if (enabled) expect(output.indexOf('Memory Enabled')).toBeGreaterThan(output.indexOf('Ask Pace or type /'));
});

it.each([false, true])("opens review only after Left reaches the beginning of the input, multiline: %s", async multiline => {
  const ui = await mount();
  ui.stdin.write(multiline ? "first\nsecond" : "draft");
  await ui.instance.waitUntilRenderFlush();
  ui.stdin.write("\x1b[D");
  await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join("")).not.toContain("File review");
  ui.stdin.write("!");
  await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join("")).toContain(multiline ? "secon!d" : "draf!t");
  // Reaching the beginning of a later line still belongs to normal editing.
  ui.stdin.write("\x1b[H");
  await ui.instance.waitUntilRenderFlush();
  if (multiline) {
    ui.stdin.write("\x1b[D");
    await ui.instance.waitUntilRenderFlush();
    expect(ui.stdout.writes.join("")).not.toContain("File review");
    ui.stdin.write("\x1b[H");
    await ui.instance.waitUntilRenderFlush();
  }
  expect(ui.stdout.writes.join("")).not.toContain("File review");
  ui.stdin.write("\x1b[D");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("File review"));
});

it("opens review with Left from an empty chat input", async () => {
  const ui = await mount();
  ui.stdin.write("\x1b[D");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("File review"));
});

it.each([
  { running: false, closeKey: "\x1b" }, { running: true, closeKey: "\x1b" },
  { running: false, closeKey: "\x1b[C" }, { running: true, closeKey: "\x1b[C" },
])("preserves the chat draft and transcript through review with $closeKey while active: $running", async ({ running, closeKey }) => {
  const ui = await mount();
  const sourceText = "Keep this review turn running";
  const draft = "unfinished chat draft";
  let complete!: () => void;
  let signal: AbortSignal | undefined;
  const turn = vi.spyOn(Orchestrator.prototype, "turn").mockImplementation(async (_prompt, session, _config, _progress, activeSignal) => {
    signal = activeSignal;
    if (running) await new Promise<void>(resolve => { complete = resolve; });
    return { session, result: "Review turn finished", route: session.route, note: "Mock", durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  await ui.submit(sourceText);
  await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
  if (!running) await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Review turn finished"));
  ui.stdin.write(draft); await ui.instance.waitUntilRenderFlush();
  ui.stdin.write("\x1b[H"); await ui.instance.waitUntilRenderFlush();
  ui.stdin.write("\x1b[D");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("File review"));
  expect(turn).toHaveBeenCalledOnce();
  expect(signal?.aborted).toBe(false);
  ui.stdout.writes.length = 0; ui.stdin.write(closeKey);
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain(draft));
  expect(ui.stdout.writes.join("")).toContain(sourceText);
  expect(signal?.aborted).toBe(false);
  if (running) {
    complete();
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Review turn finished"));
  }
  expect(turn).toHaveBeenCalledOnce();
});

it.each([
  { mode: "idle", lineComment: false }, { mode: "steering", lineComment: false },
  { mode: "unavailable", lineComment: false }, { mode: "failed", lineComment: false },
  { mode: "idle", lineComment: true }, { mode: "steering", lineComment: true },
])("sends review comments through $mode with line context: $lineComment without consuming the chat draft", async ({ mode, lineComment }) => {
  const directory = await mkdtemp(join(tmpdir(), "pace-review-comment-"));
  const isolated = new PaceStore(directory);
  const saveChanges = PaceStore.prototype.saveChanges, update = PaceStore.prototype.update;
  const ui = await mount();
  const steer = vi.fn(async () => { if (mode === "failed") throw new Error("runner disconnected"); });
  let complete!: () => void;
  let session: Parameters<typeof saveChanges>[0] | undefined;
  try {
    ui.save.mockImplementation(target => saveChanges.call(isolated, target, false));
    vi.spyOn(PaceStore.prototype, "update").mockImplementation((identity, mutate) => update.call(isolated, identity, mutate, false));
    await ui.submit("/manual gpt-6.2-sol high");
    session = ui.save.mock.calls[0]![0];
    session.title = "Review conversation";
    if (lineComment) {
      vi.spyOn(FileEdits.prototype, "conversation").mockResolvedValue({ version: 1, project: session.projectPath, changes: [{
        path: "target.ts", before: { hash: "a".repeat(64), mode: 0o644, kind: "file" },
        after: { hash: "b".repeat(64), mode: 0o644, kind: "file" }, undone: false,
      }] });
      vi.spyOn(FileEdits.prototype, "diff").mockResolvedValue("--- a/target.ts\n+++ b/target.ts\n@@ -7 +9 @@\n-before\n+after");
    }
    let started = 0;
    const turn = vi.spyOn(Orchestrator.prototype, "turn").mockImplementation(async (_prompt, target, _config, progress) => {
      if (mode !== "idle" && started++ === 0) {
        if (mode !== "unavailable") progress({ kind: "steering", role: "main", steer });
        await new Promise<void>(resolve => { complete = resolve; });
      }
      return { session: target, result: "Comment task finished", route: target.route, note: "Mock", durationMs: 1, stages: [], routing: [], artifacts: [] };
    });
    if (mode !== "idle") {
      await ui.submit("Original active task");
      await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    }
    ui.stdin.write("preserved chat draft"); await ui.instance.waitUntilRenderFlush();
    ui.stdin.write("\x1b[H"); await ui.instance.waitUntilRenderFlush();
    ui.stdin.write("\x1b[D");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("File review"));
    if (lineComment) await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("+after"));
    ui.stdin.write("c");
    if (lineComment) {
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Select a line"));
      ui.stdin.write("\x1b[B"); await ui.instance.waitUntilRenderFlush();
      ui.stdin.write("c");
    }
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Comment to agent"));
    ui.stdin.write("Please cover this edge case"); await ui.instance.waitUntilRenderFlush();
    ui.stdin.write("\r");
    const text = lineComment ? "Review comment for conversation, file target.ts, new line 9:\nCode: +after\n\nPlease cover this edge case" : "Review comment:\nPlease cover this edge case";
    if (mode === "idle") {
      await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
      expect(turn.mock.calls[0]![0]).toBe(text);
      expect(turn.mock.calls[0]![1].id).toBe(session.id);
      expect(steer).not.toHaveBeenCalled();
      expect((await isolated.load(session.projectPath, session.id))?.queuedPrompts ?? []).toEqual([]);
    } else if (mode === "steering") {
      await vi.waitFor(() => expect(steer).toHaveBeenCalledExactlyOnceWith(text));
      await vi.waitFor(async () => {
        const saved = await isolated.load(session!.projectPath, session!.id);
        expect(saved?.steeringRecords?.[0]).toMatchObject({ text, state: "delivered" });
        expect(saved?.queuedPrompts).toEqual([]);
      });
      expect(turn).toHaveBeenCalledOnce();
    } else {
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain(mode === "failed" ? "Steering delivery is unknown" : "Wait for an active agent turn"));
      const saved = await isolated.load(session.projectPath, session.id);
      expect(saved?.queuedPrompts).toEqual([expect.objectContaining({ text })]);
      expect(turn).toHaveBeenCalledOnce();
      if (mode === "unavailable") expect(steer).not.toHaveBeenCalled();
      else expect(saved?.steeringRecords?.[0]?.state).toBe("unknown");
      // Leave the comment editor, then leave review.
      ui.stdout.writes.length = 0; ui.stdin.write("\x1b");
      await vi.waitFor(() => {
        expect(ui.stdout.writes.join("")).toContain("File review");
        expect(ui.stdout.writes.join("")).not.toContain("Comment to agent");
      });
    }
    if (mode === "idle" || mode === "steering") await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Comment sent to the agent"));
    ui.stdout.writes.length = 0; ui.stdin.write("\x1b");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("preserved chat draft"));
    if (mode !== "idle") {
      complete();
      await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Comment task finished"));
    }
  } finally { ui.instance.unmount(); await rm(directory, { recursive: true, force: true }); }
});

it('changes themes through the mounted command route and keeps the previous scheme on save failure', async () => {
  const ui = await mount();
  const saveConfig = vi.spyOn(PaceStore.prototype, 'saveConfig').mockResolvedValue();
  await ui.submit('/theme ocean');
  await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: 'ocean' })));
  expect(ui.onClear).toHaveBeenCalledOnce();
  await ui.submit('/theme');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('❯ ocean ✓'));
  ui.stdin.write('\x1b'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledTimes(3));
  await ui.submit('/theme invalid');
  expect(saveConfig).toHaveBeenCalledOnce();
  saveConfig.mockRejectedValueOnce(new Error('disk full'));
  await ui.submit('/theme warm');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Could not save color scheme: Error: disk full'));
  ui.stdout.writes.length = 0;
  await ui.submit('/theme');
  expect(ui.stdout.writes.join('')).toContain('❯ ocean ✓');
  expect(ui.onClear).toHaveBeenCalledTimes(4);
});

it.each(['forest', 'rose', 'violet', 'amber', 'slate'])('saves %s through the command and opens its preview', async scheme => {
  const ui = await mount();
  const saveConfig = vi.spyOn(PaceStore.prototype, 'saveConfig').mockResolvedValue();
  await ui.submit(`/theme ${scheme}`);
  await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ colorScheme: scheme })));
  await ui.submit('/theme');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain(`❯ ${scheme} ✓`));
});

it('scrolls through every theme in a short terminal and saves a new palette from the picker', async () => {
  const ui = await mount({ columns: 40, rows: 13 });
  const saveConfig = vi.spyOn(PaceStore.prototype, 'saveConfig').mockResolvedValue();
  await ui.submit('/theme');
  for (const [index, scheme] of COLOR_SCHEMES.entries()) {
    if (index) {
      ui.stdout.writes.length = 0;
      ui.stdin.write('\x1b[B'); await ui.instance.waitUntilRenderFlush();
    }
    expect(ui.stdout.writes.join('')).toContain(`❯ ${scheme}`);
    expect(ui.stdout.writes.join('')).toContain('Enter save');
    expect(ui.stdout.writes.join('')).toContain('Esc cancel');
  }
  expect(saveConfig).not.toHaveBeenCalled();
  ui.stdin.write('\x1b[A'); await ui.instance.waitUntilRenderFlush();
  ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ colorScheme: 'slate' })));
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Color scheme: slate.'));
});

it('previews themes without saving and applies the selected palette from the dedicated screen', async () => {
  const ui = await mount();
  const saveConfig = vi.spyOn(PaceStore.prototype, 'saveConfig').mockResolvedValue();
  await ui.submit('/theme');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Git diff · sample'));
  expect(ui.stdout.writes.join('')).toContain('Conversation · sample');
  ui.stdout.writes.length = 0;
  ui.stdin.write('\x1b[B'); await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).toContain('Live preview · ocean');
  expect(saveConfig).not.toHaveBeenCalled();
  ui.stdout.columns = 40; ui.stdout.rows = 19; ui.stdout.emit('resize');
  await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).toContain('Conversation · sample');
  expect(ui.stdout.writes.join('')).toContain('Live preview · ocean');
  // Chat shortcuts must not change the conversation behind this screen.
  ui.stdin.write('\x1bp'); await ui.instance.waitUntilRenderFlush();
  expect(ui.save).not.toHaveBeenCalled();
  ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ colorScheme: 'ocean' })));
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Color scheme: ocean.'));
  await ui.submit('/theme');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('❯ ocean ✓'));
});

it('cancels theme previews and retains the saved palette when saving fails, with retry available', async () => {
  const ui = await mount();
  const saveConfig = vi.spyOn(PaceStore.prototype, 'saveConfig').mockResolvedValue();
  await ui.submit('/theme');
  ui.stdin.write('\x1b[A'); await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).toContain('Live preview · mono');
  ui.stdin.write('\x1b'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledTimes(2));
  expect(saveConfig).not.toHaveBeenCalled();
  ui.stdout.writes.length = 0;
  await ui.submit('/theme');
  expect(ui.stdout.writes.join('')).toContain('❯ default ✓');
  ui.stdin.write('\t'); await ui.instance.waitUntilRenderFlush();
  saveConfig.mockRejectedValueOnce(new Error('disk full'));
  ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Could not save color scheme: Error: disk full'));
  ui.stdout.writes.length = 0;
  ui.stdin.write('\x1b[Z'); await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).toContain('❯ default ✓');
  ui.stdin.write('\t'); await ui.instance.waitUntilRenderFlush();
  ui.stdin.write('\r'); await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(saveConfig).toHaveBeenLastCalledWith(expect.objectContaining({ colorScheme: 'ocean' })));
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Color scheme: ocean.'));
});

it('lets a running turn continue when a theme preview is cancelled', async () => {
  const ui = await mount();
  let finish!: () => void;
  let aborted = false;
  const turn = vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session, _config, _progress, signal) => {
    signal?.addEventListener('abort', () => { aborted = true; });
    await new Promise<void>(resolve => { finish = resolve; });
    return { session, result: 'Theme preview left the turn running', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  try {
    await ui.submit('Keep working during theme preview');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    await ui.submit('/theme');
    await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Git diff · sample'));
    ui.stdin.write('\x1b');
    await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledTimes(2));
    expect(aborted).toBe(false);
    finish();
    await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Theme preview left the turn running'));
  } finally { finish?.(); }
});

it.each(['completed', 'failed', 'cancelled'])('cleans up the work animation clock when a turn is %s', async outcome => {
  vi.stubEnv('NO_COLOR', undefined);
  vi.stubEnv('FORCE_COLOR', '3');
  vi.stubEnv('TERM', 'xterm-256color');
  const ui = await mount();
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  let finish!: () => void;
  const turn = vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session, _config, _progress, signal) => {
    await new Promise<void>((resolve, reject) => {
      finish = () => outcome === 'failed' ? reject(new Error('Fixture turn failed')) : resolve();
      signal?.addEventListener('abort', () => reject(new Error('Fixture cancelled')), { once: true });
    });
    return { session, result: 'Fixture completed', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  await ui.submit('Test work animation cleanup');
  await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(intervals.mock.calls.some(call => call[1] === 40)).toBe(true));
  const clockIndex = intervals.mock.calls.findIndex(call => call[1] === 40);
  const clock = intervals.mock.results[clockIndex]!.value;
  if (outcome === 'cancelled') ui.stdin.write('\x03'); else finish();
  await vi.waitFor(() => expect(clear).toHaveBeenCalledWith(clock));
});

it('refreshes active thinking every 100 ms and stops its clock when thinking completes', async () => {
  vi.stubEnv('NO_COLOR', '1');
  const ui = await mount();
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const clear = vi.spyOn(globalThis, 'clearInterval');
  let finish!: () => void;
  vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session, _config, progress) => {
    progress({ kind: 'activity', id: 'thought', category: 'thinking', title: 'Thinking', completed: false });
    await new Promise<void>(resolve => { finish = resolve; });
    progress({ kind: 'activity', id: 'thought', category: 'thinking', title: 'Thinking', completed: true });
    return { session, result: 'Done', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  try {
    await ui.submit('Test thinking clock');
    await vi.waitFor(() => expect(intervals.mock.calls.some(call => call[1] === 100)).toBe(true));
    const clockIndex = intervals.mock.calls.findIndex(call => call[1] === 100);
    const clock = intervals.mock.results[clockIndex]!.value;
    expect(ui.stdout.writes.join('')).toContain('Thinking for');
    finish();
    await vi.waitFor(() => expect(clear.mock.calls.some(call => call[0] === clock)).toBe(true));
  } finally { finish?.(); }
});

it('lists an artifact and executes its ID from a normal conversation through the mounted UI', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { artifactId } = await import('../src/core/system/artifacts.js');
  const root = await mkdtemp(join(tmpdir(), 'pace-artifact-ui-'));
  const ui = await mount();
  vi.spyOn(PaceStore.prototype, 'conversationDir').mockImplementation((_project, id) => join(root, id));
  const turn = vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session) => {
    if (!session.executionSource) {
      const directory = join(root, session.id, 'artifacts');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'selected.md'), '# Execute this exact artifact\n');
    }
    return { session, result: session.executionSource ? 'Selected artifact executed' : 'Saved artifact', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: session.executionSource ? [] : ['artifacts/selected.md'] };
  });
  try {
    await ui.submit('Save an artifact for execution');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
    const source = turn.mock.calls[0]![1];
    expect(source.kind ?? 'normal').toBe('normal');
    const id = artifactId(source.id, 'selected.md');
    await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain(`[${id}]`));
    await ui.submit('/artifacts');
    await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Use /execute <id> to run'));
    await ui.submit(`/execute ${id} Preserve tests`);
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    expect(turn.mock.calls[1]![0]).toContain('# Execute this exact artifact');
    expect(turn.mock.calls[1]![0]).toContain('Additional user instructions:\nPreserve tests');
    expect(turn.mock.calls[1]![1].id).not.toBe(source.id);
    await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Selected artifact executed'));
  } finally { ui.instance.unmount(); await rm(root, { recursive: true, force: true }); }
});

it.each([40, 80, 140])('keeps the composer and queue usable in a mounted %i-column terminal', async columns => {
  const ui = await mount({ columns, rows: 24 });
  let finish!: () => void;
  const turn = vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session) => {
    await new Promise<void>(resolve => { finish = resolve; });
    return { session, result: 'Width fixture finished', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  await ui.submit('Keep this fixture active');
  await vi.waitFor(() => expect(turn).toHaveBeenCalledOnce());
  await ui.submit('Queued width fixture');
  await vi.waitFor(() => expect(ui.stdout.writes.join('')).toContain('Queued messages (1)'));
  ui.stdout.writes.length = 0;
  ui.stdin.write('Editable draft');
  await ui.instance.waitUntilRenderFlush();
  expect(ui.stdout.writes.join('')).toContain('Editable draft');
  expect(ui.stdout.writes.join('')).toContain('Request Approval');
  ui.instance.unmount(); finish();
});

it('shows one command activity and advances its spinner and text color on the same tick', async () => {
  const { createRequire } = await import('node:module');
  const { stripVTControlCharacters } = await import('node:util');
  const chalk = (await import(createRequire(import.meta.resolve('ink')).resolve('chalk'))).default;
  const oldLevel = chalk.level;
  vi.stubEnv('NO_COLOR', undefined);
  vi.stubEnv('FORCE_COLOR', '3');
  vi.stubEnv('TERM', 'xterm-256color');
  const ui = await mount();
  chalk.level = 3;
  const realInterval = globalThis.setInterval;
  const intervals = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
    realInterval(callback, delay === 40 ? 60_000 : delay, ...args));
  let finish!: () => void;
  vi.spyOn(Orchestrator.prototype, 'turn').mockImplementation(async (_prompt, session, _config, progress) => {
    progress({ kind: 'activity', id: 'command', category: 'command', title: 'Running: npm test', completed: false });
    await new Promise<void>(resolve => { finish = resolve; });
    progress({ kind: 'activity', id: 'command', category: 'command', title: 'Ran: npm test', completed: true });
    return { session, result: 'Command fixture finished', route: session.route, note: 'Mock', durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  const frame = () => {
    const raw = ui.stdout.writes.join('');
    return raw.slice(raw.lastIndexOf('\x1b[?2026h'));
  };
  try {
    await ui.submit('Run the command fixture');
    await vi.waitFor(() => expect(stripVTControlCharacters(frame())).toContain('Bash(npm test)'));
    const first = frame();
    expect(stripVTControlCharacters(first).match(/Bash\(npm test\)/g)).toHaveLength(1);
    expect(stripVTControlCharacters(first)).not.toContain('Working');
    expect(first).toContain('⠋');
    expect(first).toMatch(/\x1b\[38;2;56;189;248mB/);
    const tick = intervals.mock.calls.find(call => call[1] === 40)![0] as () => void;
    tick();
    await new Promise(resolve => setImmediate(resolve));
    await ui.instance.waitUntilRenderFlush();
    const next = frame();
    expect(next).toContain('⠙');
    expect(next).toMatch(/\x1b\[38;2;56;189;248ma/);
    expect(stripVTControlCharacters(next)).not.toContain('Working');
    finish();
    await vi.waitFor(() => expect(stripVTControlCharacters(frame())).toContain('Command fixture finished'));
  } finally { ui.instance.unmount(); finish?.(); chalk.level = oldLevel; }
});
