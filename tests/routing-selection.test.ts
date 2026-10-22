import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, PaceStore, registerActiveAttempt } from "../src/core/sessions.js";
import { saveRoutingSelection } from "../src/core/operations.js";
import type { AgentRole, ManualWorkflow } from "../src/shared/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scout: ManualWorkflow = { shape: "scout", routes: { scout: "vex", final: "vex" } };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pace-routing-selection-")); roots.push(root);
  const store = new PaceStore(root);
  const session = newSession("/example/project", "auto");
  session.activeTask = { id: "task", originalRequest: "Implement", instructions: [], workflow: {
    version: 1, generation: 1, shape: "single", stage: "final", status: "pending", source: "vex",
  } };
  await store.save(session);
  return { root, store, session };
}

it("serializes repeated workflow choices from the same stale snapshot without losing generations or decisions", async () => {
  const { root, store, session } = await setup();
  const choices = await Promise.all(Array.from({ length: 8 }, () => saveRoutingSelection(new PaceStore(root), session, scout, false)));
  expect(choices.map(saved => saved.activeTask?.workflow?.generation)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  const saved = (await store.load(session.projectPath, session.id))!;
  expect(saved.controlDecisions).toHaveLength(8);
  expect(new Set(saved.controlDecisions!.map(item => item.id)).size).toBe(8);
  expect(saved.activeTask?.workflow).toMatchObject({ generation: 9, shape: "scout", source: "user" });
});

it("selects a workflow before the first task and can delegate it back to auto from an older snapshot", async () => {
  const { store, session } = await setup();
  const empty = await store.update(session, latest => { delete latest.activeTask; });
  const selected = await saveRoutingSelection(store, empty, scout, false);
  expect(selected.activeTask).toBeUndefined();
  expect(selected.manualWorkflow).toEqual(scout);
  expect(selected.controlDecisions).toHaveLength(1);
  const automatic = await saveRoutingSelection(store, empty, "auto", false);
  expect(automatic.routingMode).toBe("auto");
  expect(automatic.manualWorkflow).toBeUndefined();
  expect(automatic.controlDecisions).toEqual(selected.controlDecisions);
  expect(await store.load(session.projectPath, session.id)).toEqual(automatic);
});

it("changes only the route on the latest workflow and auto mode preserves its progress and ledger", async () => {
  const { store, session } = await setup();
  const latest = await store.update(session, current => {
    current.activeTask!.workflow = { ...current.activeTask!.workflow!, generation: 3, shape: "scout", status: "completed", scoutHandoff: "Verified findings", mainThreadId: "lead" };
    current.manualWorkflow = scout;
    current.attempts = [{ id: "attempt", taskId: "task", generation: 3, role: "main", stage: "final", status: "completed", route: {}, startedAt: "now", observations: [] }];
    current.sideAnswers = [{ id: "side", attemptId: "side-attempt", question: "Fact?", snapshotAt: "now", result: "Answer", route: {} }];
    current.turns = [{ prompt: "Implement", result: "Done", at: "now" }];
    current.queuedPrompts = ["Continue"];
  });
  const selected = await saveRoutingSelection(store, session, { model: "lead-model", effort: "high" }, false);
  expect(selected.activeTask?.workflow).toEqual({ ...latest.activeTask!.workflow, mainRoute: { model: "lead-model", effort: "high" }, source: "user" });
  expect(selected.manualWorkflow).toBeUndefined();
  expect(selected.controlDecisions).toHaveLength(1);
  const automatic = await saveRoutingSelection(store, session, "auto", false);
  expect(automatic.routingMode).toBe("auto");
  expect(automatic.activeTask).toEqual(selected.activeTask);
  expect(automatic.controlDecisions).toEqual(selected.controlDecisions);
  for (const key of ["attempts", "sideAnswers", "turns", "queuedPrompts"] as const) expect(automatic[key]).toEqual(latest[key]);
});

for (const [role, stage] of [["main", "final"], ["scout", "scout"], ["verifier", "verify"], ["status", "checkpoint"], ["status", "native_compaction"]] as [AgentRole, string][]) {
  it(`rejects a workflow change during a running ${role}/${stage} stage without changing saved or caller state`, async () => {
    const { store, session } = await setup();
    // A live runner owns its record; otherwise load() correctly recovers it as
    // an interrupted invocation, changing the state this test is inspecting.
    const release = registerActiveAttempt(session, "running");
    try {
      const running = await store.update(session, latest => {
        latest.attempts = [{ id: "running", taskId: "task", generation: 1, role, stage, status: "running", route: {}, startedAt: "now", observations: [] }];
      });
      const caller = structuredClone(session);
      await expect(saveRoutingSelection(store, session, scout)).rejects.toThrow("Wait for the current turn");
      // The store's enumerable symbol follows spread copies but is not session data.
      expect(structuredClone(session)).toEqual(caller);
      expect(await store.load(session.projectPath, session.id)).toEqual(running);
      await store.update(session, latest => { latest.attempts![0]!.status = "completed"; });
      await expect(saveRoutingSelection(store, session, scout)).resolves.toMatchObject({ manualWorkflow: scout });
    } finally { release(); }
  });
}

it("permits workflow choices while an independent title attempt is running", async () => {
  const { store, session } = await setup();
  await store.update(session, latest => {
    latest.attempts = [{ id: "title", taskId: "task", generation: 1, role: "status", stage: "title", status: "running", route: {}, startedAt: "now", observations: [] }];
  });
  const selected = await saveRoutingSelection(store, session, scout);
  expect(selected.attempts?.[0]?.status).toBe("running");
  expect(selected.manualWorkflow).toEqual(scout);
});
