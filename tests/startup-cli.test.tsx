import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { setup, firstLaunch, renderApp, keyPrompt, execTurn } = vi.hoisted(() => ({
  setup: vi.fn(async () => true),
  firstLaunch: vi.fn(async (_baseDir: string) => false),
  renderApp: vi.fn(() => ({ waitUntilExit: async () => {} })),
  keyPrompt: vi.fn(async () => true),
  execTurn: vi.fn(async (_prompt: string) => 0),
}));
vi.mock("../src/entrypoints/startup-setup.js", () => ({ runStartupSetup: setup, needsStartupSetup: firstLaunch }));
vi.mock("ink", async original => ({ ...await original<typeof import("ink")>(), render: renderApp }));
vi.mock("../src/core/system/keys.js", async original => ({ ...await original<typeof import("../src/core/system/keys.js")>(), promptForKey: keyPrompt }));
vi.mock("../src/core/exec.js", () => ({ execTurn }));

const originalArgs = process.argv;
const originalExitCode = process.exitCode;
const originalInputTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalOutputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  firstLaunch.mockReset().mockResolvedValue(false);
  setup.mockReset().mockResolvedValue(true);
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  process.exitCode = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgs; process.exitCode = originalExitCode; vi.restoreAllMocks();
  if (originalInputTTY) Object.defineProperty(process.stdin, "isTTY", originalInputTTY);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (originalOutputTTY) Object.defineProperty(process.stdout, "isTTY", originalOutputTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

async function run(...args: string[]) {
  process.argv = ["node", "pace", ...args];
  await import("../src/entrypoints/cli-app.js");
}

it("opens Pace normally for a returning user", async () => {
  await run();
  expect(firstLaunch).toHaveBeenCalledOnce();
  expect(setup).not.toHaveBeenCalled();
  expect(keyPrompt).not.toHaveBeenCalled();
  expect(renderApp).toHaveBeenCalledOnce();
});

it("automatically runs setup before opening Pace for a first-time user", async () => {
  firstLaunch.mockResolvedValueOnce(true);
  let finish!: (completed: boolean) => void;
  setup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = run();
  await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
  expect(renderApp).not.toHaveBeenCalled();
  finish(true);
  await running;
  expect(renderApp).toHaveBeenCalledOnce();
  expect(keyPrompt).not.toHaveBeenCalled();
});

it.each(["stdin", "stdout"] as const)("skips automatic setup when %s is not a terminal", async stream => {
  Object.defineProperty(process[stream], "isTTY", { configurable: true, value: false });
  await run();
  expect(firstLaunch).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
  expect(renderApp).toHaveBeenCalledOnce();
});

it("waits for the hidden startup wizard before opening Pace", async () => {
  let finish!: (completed: boolean) => void;
  setup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = run("--setup");
  await vi.waitFor(() => expect(setup).toHaveBeenCalledOnce());
  expect(renderApp).not.toHaveBeenCalled();
  finish(true);
  await running;
  expect(renderApp).toHaveBeenCalledOnce();
  expect(keyPrompt).not.toHaveBeenCalled();
  expect(firstLaunch).not.toHaveBeenCalled();
});

it.each([[], ["--setup"]])("does not open Pace after cancelling setup with args %j", async (...args) => {
  firstLaunch.mockResolvedValueOnce(true);
  setup.mockResolvedValueOnce(false);
  await run(...args);
  expect(renderApp).not.toHaveBeenCalled();
});

it("reports first-launch detection errors without launching setup or Pace", async () => {
  firstLaunch.mockRejectedValueOnce(new Error("storage inaccessible"));
  await run();
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("storage inaccessible"));
  expect(setup).not.toHaveBeenCalled();
  expect(renderApp).not.toHaveBeenCalled();
});

it("reports setup failure and does not open Pace", async () => {
  setup.mockRejectedValueOnce(new Error("Pace startup setup requires an interactive terminal."));
  await run("--setup");
  expect(process.exitCode).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("requires an interactive terminal"));
  expect(renderApp).not.toHaveBeenCalled();
});

it.each(["--help", "--version"])("keeps %s free of setup prompts and hides the flag from help", async arg => {
  await run(arg);
  expect(setup).not.toHaveBeenCalled();
  expect(firstLaunch).not.toHaveBeenCalled();
  expect(renderApp).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalled();
  expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("--setup");
});

it("keeps the existing routing-key setup command", async () => {
  await run("setup");
  expect(keyPrompt).toHaveBeenCalledOnce();
  expect(setup).not.toHaveBeenCalled();
  expect(renderApp).not.toHaveBeenCalled();
});

it("does not run onboarding for exec", async () => {
  await run("exec", "check this");
  expect(execTurn).toHaveBeenCalledWith("check this");
  expect(firstLaunch).not.toHaveBeenCalled();
  expect(setup).not.toHaveBeenCalled();
  expect(renderApp).not.toHaveBeenCalled();
});

it("rejects extra startup arguments", async () => {
  await run("--setup", "unexpected");
  expect(process.exitCode).toBe(2);
  expect(setup).not.toHaveBeenCalled();
  expect(renderApp).not.toHaveBeenCalled();
});
