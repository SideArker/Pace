import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnRouting } from "../src/core/orchestrator-routing.js";
import { Orchestrator, type RoutingRecord } from "../src/core/orchestrator.js";
import { newSession, PaceStore } from "../src/core/sessions.js";
import { requiredSave, TransitionSaveError } from "../src/core/task-execution.js";
import { DEFAULT_ROUTING_PROMPTS as prompts } from "../src/core/routing/routing-prompts.js";
import { stageRequest, type VexRequest } from "../src/core/vex/requests.js";
import { decision } from "./routing-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const models = [{ model: "gpt-6.1-sol", efforts: ["medium" as const] }];
async function fixture(aside: boolean, verifierTurn = false, scout = false) {
  const root = await mkdtemp(join(tmpdir(), "pace-decisions-")); roots.push(root);
  const store = new PaceStore(root);
  const session = newSession(root, "auto");
  session.activeTask = { id: "task", originalRequest: "Work", instructions: [], workflow: { version: 1, generation: 1, shape: "single", stage: "final", source: "vex" } };
  await store.saveChanges(session, false);
  const vex = { choose: vi.fn(async (request: VexRequest): Promise<unknown> => decision(request, "0:medium")) };
  const runner = { run: vi.fn(async () => ({ result: "Side answer", completed: true })) };
  const routing: RoutingRecord[] = [];
  const controller = new AbortController();
  const objective = scout ? prompts.objectives.scout : "Complete request";
  const choose = createTurnRouting({ vex, session, prompts, verifierTurn, routing, save: () => requiredSave(store, session, false), onProgress: () => {}, signal: controller.signal }).choose;
  const request = stageRequest("Work", [], models, objective);
  const call = () => aside
    ? new Orchestrator(store, runner, vex).aside("Question", session, { routingMode: "auto", defaultRoute: {}, models }, () => {}, controller.signal, false)
    : choose(request, objective);
  return { store, session, vex, runner, routing, controller, call };
}

for (const aside of [false, true]) {
  const label = aside ? "aside" : "main";
  it(`${label}: retries invalid decisions once and saves successful audit before execution`, async () => {
    const env = await fixture(aside);
    env.vex.choose.mockResolvedValueOnce({ choice: "invalid" });
    env.runner.run.mockImplementation(async () => {
      const saved = await env.store.load(env.session.projectPath, env.session.id);
      expect(saved?.controlDecisions?.at(-1)).toMatchObject({ choice: "0:medium", requests: 2 });
      return { result: "Side answer", completed: true };
    });
    const result = await env.call();
    expect(env.vex.choose).toHaveBeenCalledTimes(2);
    const audit = (await env.store.load(env.session.projectPath, env.session.id))!.controlDecisions!;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ taskId: "task", role: label, stage: aside ? "aside" : "final", source: "vex", contextAction: "continue", requests: 2, choice: "0:medium" });
    expect(audit[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(audit[0]!.at))).toBe(true);
    if ("routing" in result) {
      expect(result.routing[0]).not.toHaveProperty("choiceLabel");
      expect(env.session.sideAnswers?.[0]?.snapshotAt).toBe(audit[0]!.at);
    } else expect(env.routing[0]?.choiceLabel).toBe("gpt-6.1-sol at medium reasoning");
  });

  it(`${label}: records unavailable after two provider failures without starting Codex`, async () => {
    const env = await fixture(aside);
    env.vex.choose.mockRejectedValue(new Error("provider offline"));
    await expect(env.call()).rejects.toThrow(aside ? "after two attempts" : "Vex routing failed");
    expect(env.vex.choose).toHaveBeenCalledTimes(2);
    expect(env.runner.run).not.toHaveBeenCalled();
    expect((await env.store.load(env.session.projectPath, env.session.id))?.controlDecisions).toEqual([
      expect.objectContaining({ choice: "unavailable", failed: true, error: "Error: provider offline", requests: 2, role: label }),
    ]);
    if (aside) expect(env.session.controlDecisions?.at(-1)?.failed).toBe(true);
  });

  it(`${label}: a required audit save failure does not retry Vex or start Codex`, async () => {
    const env = await fixture(aside);
    const save = env.store.saveChanges.bind(env.store);
    vi.spyOn(env.store, "saveChanges").mockImplementation(async (target, activate) => {
      if (target.controlDecisions?.length) throw new Error("disk full");
      return save(target, activate);
    });
    await expect(env.call()).rejects.toBeInstanceOf(TransitionSaveError);
    expect(env.vex.choose).toHaveBeenCalledOnce();
    expect(env.runner.run).not.toHaveBeenCalled();
  });

  it(`${label}: cancellation while awaiting Vex does not retry or record a guessed decision`, async () => {
    const env = await fixture(aside);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    env.vex.choose.mockImplementation(() => { started(); return new Promise(() => {}); });
    const pending = expect(env.call()).rejects.toMatchObject({ name: "AbortError" });
    await ready; env.controller.abort(); await pending;
    expect(env.vex.choose).toHaveBeenCalledOnce();
    expect(env.runner.run).not.toHaveBeenCalled();
    expect((await env.store.load(env.session.projectPath, env.session.id))?.controlDecisions).toBeUndefined();
  });

  it(`${label}: preserves the existing pre-abort boundary`, async () => {
    const env = await fixture(aside); env.controller.abort();
    await expect(env.call()).rejects.toMatchObject({ name: "AbortError" });
    expect(env.vex.choose).toHaveBeenCalledTimes(aside ? 1 : 0);
    expect(env.runner.run).not.toHaveBeenCalled();
  });
}

for (const verifier of [false, true]) it(`records ${verifier ? "verifier" : "scout"} on successful scout routing and the existing failure role`, async () => {
  const env = await fixture(false, verifier, true);
  await env.call();
  expect(env.session.controlDecisions?.at(-1)?.role).toBe(verifier ? "verifier" : "scout");
  env.vex.choose.mockRejectedValue(new Error("offline"));
  await expect(env.call()).rejects.toThrow();
  expect(env.session.controlDecisions?.at(-1)?.role).toBe(verifier ? "verifier" : "main");
});
