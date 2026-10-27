import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { Orchestrator } from "../src/core/orchestrator.js";
import { operation } from "../src/core/operations.js";
import { PromptQueue } from "../src/core/prompt-queue.js";
import { steerQueuedPrompt } from "../src/components/queue-steering.js";
import type { TurnJob } from "../src/components/turn-runner.js";
import type { CodexRunner } from "../src/integrations/codex-types.js";
import type { Config } from "../src/shared/types.js";
import type { VexRequest } from "../src/core/vex/requests.js";
import { vexPayloadBytes, VEX_PAYLOAD_BUDGET } from "../src/core/vex/context.js";
import { decision } from "./routing-fixture.js";

vi.mock("../src/core/routing/pricing.js", async original => {
  const module = await original<typeof import("../src/core/routing/pricing.js")>();
  return { ...module, refreshVersionManifest: async () => module.currentVersionManifest() };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const suite = JSON.parse(await readFile(new URL("./fixtures/steering-recovery.json", import.meta.url), "utf8")) as {
  cases: { id: string; goal: string; criterion: string; steering: string; followups: string[]; historyTurns: number; historyRepeat: number }[];
};
for (const item of suite.cases) it(`${item.id}: delivered steering survives restart, stays out of Vex and reaches only fresh Codex replay`, async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-offline-steering-")); roots.push(root);
  const store = new PaceStore(root), session = newSession(root, "auto");
  const config: Config = { routingMode: "auto", defaultRoute: { model: "gpt-6.1-sol", effort: "medium" }, models: [{ model: "gpt-6.1-sol", efforts: ["medium"] }], skillFolder: null };
  session.route = config.defaultRoute;
  session.activeTask = { id: "task", originalRequest: item.goal, criteria: [{ id: "order", text: item.criterion, required: true }], constraints: ["Preserve public API"], instructions: [], workflow: { version: 1, generation: 1, shape: "single", stage: "final", mainRoute: session.route, source: "vex" } };
  session.turns = Array.from({ length: item.historyTurns }, (_, i) => ({ prompt: `${i}: ${item.goal} `.repeat(100), result: "Existing evidence and unfinished work. ".repeat(item.historyRepeat), at: new Date(1_000_000 + i).toISOString() }));
  const queued = operation(item.steering, session.id, "task");
  session.queuedPrompts = [queued]; await store.saveChanges(session, false);
  const queue = new PromptQueue(); queue.restore(session.id, [queued]);
  const job: TurnJob = { session, turnKey: "interrupted-turn", controller: new AbortController(), prompt: item.goal,
    steer: vi.fn(async text => { expect(text).toBe(item.steering); }), persistSteering: () => store.saveChanges(session, false) };
  await steerQueuedPrompt(session.id, 0, new Map([[session.id, job]]), queue);
  expect(job.steer).toHaveBeenCalledOnce();
  const restarted = new PaceStore(root), loaded = (await restarted.load(root, session.id))!;
  expect(loaded.steeringRecords![0]).toMatchObject({ state: "delivered", text: item.steering, taskId: "task" });
  expect(loaded.queuedPrompts).toEqual([]);
  const codexPrompts: string[] = [], requests: VexRequest[] = [];
  const runner: CodexRunner = { run: async prompt => {
    codexPrompts.push(prompt); return { result: "Work remains", completed: true, threadId: "resumed-thread" };
  } };
  const vex = { choose: async (request: VexRequest) => {
    requests.push(request);
    expect(JSON.stringify(request)).not.toContain(item.steering);
    expect(vexPayloadBytes(request)).toBeLessThanOrEqual(VEX_PAYLOAD_BUDGET);
    return decision(request, request.options[0]!.id === "continue" ? "continue" : "closed");
  } };
  const orchestrator = new Orchestrator(restarted, runner, vex);
  for (const followup of item.followups) await orchestrator.turn(followup, loaded, config, () => {});
  expect(codexPrompts).toHaveLength(2);
  expect(codexPrompts[0]!.split(item.steering)).toHaveLength(2);
  expect(codexPrompts[1]).not.toContain(item.steering);
  expect(requests.every(request => ["continue", "closed"].includes(request.options[0]!.id))).toBe(true);
  expect(requests.some(request => request.context.projection)).toBe(true);
  expect(loaded.activeTask!.assessment).toBe("unknown");
  expect(loaded.controlDecisions!.every(record => record.promptProfile && record.requestAttempts?.length === 1 && record.usage === "unknown" && record.costUsd === "unknown")).toBe(true);
});
