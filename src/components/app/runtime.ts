import { readFileSync } from "node:fs";
import { PaceStore } from "../../core/sessions.js";
import { Orchestrator } from "../../core/orchestrator.js";
import { AppServerRunner } from "../../integrations/codex.js";
import { VexRouter } from "../../core/vex/client.js";

export const project = process.cwd();
export const installedVersion = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version as string;
export const store = new PaceStore();
export const vex = new VexRouter();
export const runner = new AppServerRunner();
export const orchestrator = new Orchestrator(store, runner, vex);
