import React from "react";
import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, renderToString } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
import { StartupSetup } from "../src/components/StartupSetup.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { needsStartupSetup } from "../src/entrypoints/startup-setup.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import type { Config } from "../src/shared/types.js";

class Output extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.writes.push(chunk.toString()); done(); }
}
const instances: ReturnType<typeof render>[] = [];
let root: string | undefined;
afterEach(async () => {
  for (const instance of instances.splice(0)) instance.unmount();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(config = structuredClone(DEFAULT_CONFIG), save = vi.fn(async (_config: Config) => {}), hasRoutingKey = false) {
  const stdout = new Output();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const finish = vi.fn(), cancel = vi.fn();
  const instance = render(<StartupSetup config={config} width={80} height={23} hasRoutingKey={hasRoutingKey}
    onSave={save} onFinish={finish} onCancel={cancel} />, {
    stdin, stdout, stderr: new PassThrough(), patchConsole: false, alternateScreen: false, exitOnCtrlC: false, maxFps: 1000,
  });
  instances.push(instance);
  await instance.waitUntilRenderFlush();
  return { save, finish, cancel,
    output: () => stripVTControlCharacters(stdout.writes.join("")),
    async key(value: string) { stdout.writes.length = 0; stdin.write(value); await instance.waitUntilRenderFlush(); },
  };
}

it("detects first use even when unrelated Pace cache files already exist", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-first-launch-"));
  const baseDir = join(root, ".pace");
  expect(await needsStartupSetup(baseDir)).toBe(true);
  await mkdir(baseDir);
  await writeFile(join(baseDir, "versions-cache.json"), "{}");
  expect(await needsStartupSetup(baseDir)).toBe(true);
});

it("does not repeat automatic setup after preferences are saved", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-setup-complete-"));
  const store = new PaceStore(root);
  const ui = await mount(await store.loadConfig(), vi.fn(config => store.saveConfig(config)));
  await ui.key("\r"); await ui.key("\r"); await ui.key("\r"); await ui.key("\r");
  await vi.waitFor(() => expect(ui.finish).toHaveBeenCalledOnce());
  expect(await needsStartupSetup(root)).toBe(false);
});

it("offers automatic setup again after first-use cancellation", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-first-cancel-"));
  const ui = await mount();
  await ui.key("\x03");
  expect(ui.cancel).toHaveBeenCalledOnce();
  expect(ui.save).not.toHaveBeenCalled();
  expect(await needsStartupSetup(root)).toBe(true);
});

it("recognizes existing conversation storage without a saved config", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-returning-user-"));
  const store = new PaceStore(root);
  await store.saveChanges(newSession(root, "manual"), false);
  expect(await needsStartupSetup(root)).toBe(false);
});

it("preserves an existing invalid config for normal startup to report", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-invalid-existing-config-"));
  await writeFile(join(root, "config.json"), "invalid config");
  expect(await needsStartupSetup(root)).toBe(false);
  expect(await readFile(join(root, "config.json"), "utf8")).toBe("invalid config");
});

it("does not treat unexpected storage errors as first use", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-first-launch-error-"));
  const file = join(root, "blocked");
  await writeFile(file, "");
  await expect(needsStartupSetup(file)).rejects.toMatchObject({ code: "ENOTDIR" });
});

it("saves the reviewed preferences once, preserves other settings, and finishes only after saving", async () => {
  root = await mkdtemp(join(tmpdir(), "pace-startup-"));
  const store = new PaceStore(root);
  const initial = { ...structuredClone(DEFAULT_CONFIG), trustedFolders: ["/existing/project"], disabledSkills: ["prototype"] };
  await store.saveConfig(initial);
  let release!: () => void;
  const save = vi.fn(async (config: Config) => { await new Promise<void>(resolve => { release = resolve; }); await store.saveConfig(config); });
  const ui = await mount(await store.loadConfig(), save);
  await ui.key("\x1b[B"); // ocean
  await ui.key("\r");
  await ui.key("\x1b[B"); // limited
  await ui.key("\r");
  expect(ui.output()).toContain("Routing");
  expect(ui.output()).toContain("Optional Vex routing needs a key");
  await ui.key("\x1b[A"); // manual
  await ui.key("\r");
  expect(ui.output()).toContain("Theme: ocean");
  expect(ui.output()).toContain("Approval: limited");
  expect(ui.output()).toContain("Routing: manual");
  expect(save).not.toHaveBeenCalled();
  await ui.key("\r");
  await ui.key("\r");
  expect(save).toHaveBeenCalledOnce();
  expect(ui.finish).not.toHaveBeenCalled();
  expect(await store.loadConfig()).toEqual(initial);
  release();
  await vi.waitFor(() => expect(ui.finish).toHaveBeenCalledOnce());
  expect(await store.loadConfig()).toEqual({ ...initial, colorScheme: "ocean", approvalMode: "limited", routingMode: "manual" });
});

it.each(["\x1b", "\x03"])("cancels with %j without changing an existing config", async key => {
  root = await mkdtemp(join(tmpdir(), "pace-startup-cancel-"));
  const store = new PaceStore(root);
  await store.saveConfig(structuredClone(DEFAULT_CONFIG));
  const before = await readFile(join(root, "config.json"), "utf8");
  const save = vi.fn((config: Config) => store.saveConfig(config));
  const ui = await mount(await store.loadConfig(), save);
  await ui.key("\t"); await ui.key("\r"); await ui.key(key);
  await vi.waitFor(() => expect(ui.cancel).toHaveBeenCalledOnce());
  expect(save).not.toHaveBeenCalled();
  expect(ui.finish).not.toHaveBeenCalled();
  expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
});

it("starts with saved choices, supports back navigation, and retries a failed save", async () => {
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), colorScheme: "mono", approvalMode: "full-access", routingMode: "manual" };
  const save = vi.fn(async (_config: Config) => {}).mockRejectedValueOnce(new Error("disk full"));
  const ui = await mount(config, save, true);
  expect(ui.output()).toContain("❯ mono");
  await ui.key("\r");
  expect(ui.output()).toContain("❯ full-access");
  await ui.key("\x1b[D");
  expect(ui.output()).toContain("❯ mono");
  await ui.key("\r"); await ui.key("\r");
  expect(ui.output()).toContain("❯ manual");
  expect(ui.output()).toContain("A routing key is configured");
  await ui.key("\r"); await ui.key("\r");
  await vi.waitFor(() => expect(ui.output()).toContain("Could not save setup: Error: disk full"));
  expect(ui.finish).not.toHaveBeenCalled();
  await ui.key("\r");
  await vi.waitFor(() => expect(ui.finish).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(config);
});

it.each([[40, 18], [80, 24], [120, 40]])("keeps choices and navigation visible at %ix%i", (width, height) => {
  const output = stripVTControlCharacters(renderToString(<StartupSetup config={structuredClone(DEFAULT_CONFIG)}
    width={width!} height={height! - 1} hasRoutingKey={false} onSave={async () => {}} onFinish={() => {}} onCancel={() => {}} />,
  { columns: width! }));
  expect(output).toContain("Pace setup");
  expect(output).toContain("❯ default");
  expect(output).toContain("Esc cancel");
  expect(output.split("\n")).toHaveLength(height! - 1);
  for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width!);
});
