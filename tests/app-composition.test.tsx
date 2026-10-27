import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/components/App.js";
import { PaceStore } from "../src/core/sessions.js";
import { VexRouter } from "../src/core/vex/client.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import * as pricing from "../src/core/routing/pricing.js";
import * as models from "../src/integrations/models.js";
import * as usage from "../src/integrations/usage.js";
import * as npmVersion from "../src/core/npm-version.js";
import * as skills from "../src/core/system/skills.js";
import { Orchestrator } from "../src/core/orchestrator.js";

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
});

async function mount() {
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
  const stdout = new Terminal();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const onClear = vi.fn();
  const instance = render(<App onClear={onClear} />, {
    stdin, stdout, stderr: new PassThrough(), interactive: true, patchConsole: false,
    alternateScreen: false, maxFps: 1000,
  });
  instances.push(instance);
  await vi.waitFor(() => expect(stdout.writes.join("")).toContain("Ask Pace or type /"));
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

it("dispatches information commands and the planning shortcut through the mounted application", async () => {
  const ui = await mount();
  await ui.submit("/tasks");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Codex has not published a plan"));
  ui.stdin.write("\x1bp");
  await ui.instance.waitUntilRenderFlush();
  await vi.waitFor(() => expect(ui.save).toHaveBeenCalledWith(expect.objectContaining({ kind: "planning" })));
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Planning mode active"));
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
 for(const ready of ['❯ Routing · Vex only','❯ quick','❯ Start']){ui.stdin.write('\r');await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain(ready));await ui.instance.waitUntilRenderFlush();}
 ui.stdin.write('\r');await ui.instance.waitUntilRenderFlush();
 await vi.waitFor(()=>expect(ui.stdout.writes.join('')).toContain('Wait for main/side jobs'));
 expect(turn).toHaveBeenCalledOnce();expect(mainSignal?.aborted).toBe(false);complete(undefined);
});
