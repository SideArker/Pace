import React from "react";
import { render } from "ink";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { PaceStore } from "../core/sessions.js";
import { hasConfiguredKey } from "../core/system/keys.js";
import { StartupSetup } from "../components/StartupSetup.js";
import { useTerminalDimensions } from "../components/app/useTerminalDimensions.js";
import { interactiveInkOptions } from "./terminal-options.js";

export async function needsStartupSetup(baseDir: string): Promise<boolean> {
  for (const path of ["config.json", "sessions"]) {
    try {
      await access(join(baseDir, path));
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}

export async function runStartupSetup(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Pace startup setup requires an interactive terminal.");
  const store = new PaceStore();
  const config = await store.loadConfig();
  const hasRoutingKey = hasConfiguredKey();
  let completed = false;
  let instance: ReturnType<typeof render>;
  function Setup() {
    const { columns, rows } = useTerminalDimensions(() => {});
    return <StartupSetup config={config} hasRoutingKey={hasRoutingKey} width={columns} height={Math.max(1, rows - 1)}
      onSave={updated => store.saveConfig(updated)}
      onFinish={() => { completed = true; instance.unmount(); }} onCancel={() => instance.unmount()} />;
  }
  instance = render(<Setup />, interactiveInkOptions);
  await instance.waitUntilExit();
  instance.clear();
  return completed;
}
