import React from "react";
import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import * as memoryConfig from '../src/core/memory/config.js';
import * as globalMemory from '../src/core/memory/global.js';

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
    alternateScreen: false, maxFps: 1000, exitOnCtrlC: false,
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

it.skipIf(process.platform === "win32")("remembers cd for ls, shows the cwd, and restores it after toggling and switching conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-bash-directory-"));
  const child = join(root, "child directory"); await mkdir(child);
  await writeFile(join(child, "directory-content-marker"), "");
  const ui = await mount();
  try {
    await ui.submit(`! cd '${child}'`);
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Ran: $ cd"));
    await ui.submit("!");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain(`cwd: ${child}`));
    await ui.submit("ls");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("directory-content-marker"));
    await ui.submit("!");
    vi.spyOn(PaceStore.prototype, "saveConfig").mockResolvedValue();
    await ui.submit("/approval limited");
    await ui.submit("! ls");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Approval required"));
    expect(ui.stdout.writes.join("")).toContain(`in ${child}`);
    ui.stdin.write("n");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Declined."));
    await ui.submit("/approval request-approval");
    await ui.submit("/new");
    await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledOnce());
    ui.stdout.writes.length = 0;
    await ui.submit("!");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain(`cwd: ${process.cwd()}`));
    expect(ui.stdout.writes.join("")).not.toContain(`cwd: ${child}`);
    await ui.submit("!");
    ui.stdin.write("\x1b[B"); await ui.instance.waitUntilRenderFlush();
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledTimes(2));
    ui.stdout.writes.length = 0;
    await ui.submit("!");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain(`cwd: ${child}`));
    await ui.submit("ls");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("directory-content-marker"));
  } finally { ui.instance.unmount(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32").each([40, 80, 120])("shows Bash output before exit and after completion at width %s", async columns => {
  const root = await mkdtemp(join(tmpdir(), "pace-bash-output-"));
  const release = join(root, "release");
  const ui = await mount({ columns, rows: 40 });
  try {
    await ui.submit(`! printf 'bash-%s-marker\\n' live; while [ ! -e '${release}' ]; do sleep 0.02; done; for n in {1..15}; do printf 'output-row-%s\\n' "$n"; done; printf 'bash-%s-marker\\n' stderr >&2; exit 7`);
    await vi.waitFor(() => expect(stripVTControlCharacters(ui.stdout.writes.join(""))).toContain("bash-live-marker"));
    expect(stripVTControlCharacters(ui.stdout.writes.join(""))).not.toContain("bash-stderr-marker");
    await writeFile(release, "");
    await vi.waitFor(() => expect(stripVTControlCharacters(ui.stdout.writes.join(""))).toContain("bash-stderr-marker"));
    const output = stripVTControlCharacters(ui.stdout.writes.join(""));
    expect(output).toContain("output-row-15");
    expect(output).toContain("exit 7");
  } finally {
    await writeFile(release, "");
    ui.instance.unmount();
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("routes slash-prefixed commands to Bash until Bash mode is toggled off", async () => {
  const ui = await mount();
  await ui.submit("!");
  await ui.submit("/memory");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Failed: $ /memory (exit 127)"));
  await ui.submit("!");
  await ui.submit("/memory");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Memory"));
});

it.skipIf(process.platform === "win32")("preserves Bash negation inside Bash mode", async () => {
  const ui = await mount();
  await ui.submit("!");
  await ui.submit("! false");
  await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Ran: $ ! false (exit 0)"));
});

it.skipIf(process.platform === "win32")("Ctrl+C stops Bash while keeping Pace and a concurrent agent turn running", async () => {
  const ui = await mount();
  let finish!: () => void;
  let aborted = false;
  vi.spyOn(Orchestrator.prototype, "turn").mockImplementation(async (_prompt, session, _config, _progress, signal) => {
    signal?.addEventListener("abort", () => { aborted = true; });
    await new Promise<void>(resolve => { finish = resolve; });
    return { session, result: "Agent still finished", route: session.route, note: "Mock", durationMs: 1, stages: [], routing: [], artifacts: [] };
  });
  try {
    await ui.submit("Keep the agent working");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await ui.submit("!");
    await ui.submit("printf 'cancel-%s-marker\\n' ready; sleep 30");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("cancel-ready-marker"));
    ui.stdin.write("\x03");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Cancelled: $"));
    expect(aborted).toBe(false);
    finish();
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Agent still finished"));
    await ui.submit("!");
    await ui.submit("/stats");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("Bash mode off"));
  } finally { ui.instance.unmount(); finish?.(); }
});

it.skipIf(process.platform === "win32")("keeps running Bash output in its original conversation after switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-bash-switch-"));
  const release = join(root, "release");
  const ui = await mount();
  try {
    await ui.submit(`! printf 'session-%s-marker\\n' ready; while [ ! -e '${release}' ]; do sleep 0.02; done; printf 'session-%s-marker\\n' finished`);
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("session-ready-marker"));
    await ui.submit("/new");
    await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledOnce());
    ui.stdout.writes.length = 0;
    ui.stdin.write("\x03");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("1 Bash command(s) running"));
    await writeFile(release, "");
    expect(ui.stdout.writes.join("")).not.toContain("session-finished-marker");
    await ui.submit("! printf 'new-%s-marker\\n' conversation");
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("new-conversation-marker"));
    ui.stdin.write("\x1b[B");
    await ui.instance.waitUntilRenderFlush();
    ui.stdin.write("\r");
    await vi.waitFor(() => expect(ui.onClear).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ui.stdout.writes.join("")).toContain("session-finished-marker"));
  } finally {
    await writeFile(release, "");
    ui.instance.unmount();
    await rm(root, { recursive: true, force: true });
  }
});
