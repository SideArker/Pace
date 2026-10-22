import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, PaceStore, SessionConflictError } from "../src/core/sessions.js";
import type { SideAnswer, StageAttempt } from "../src/shared/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pace-revisions-")); roots.push(root);
  const store = new PaceStore(root);
  const session = newSession("/example/project", "auto");
  await store.save(session);
  return { root, store, session };
}
const attempt = (id: string): StageAttempt => ({ id, taskId: "task", generation: 1, stage: "final", role: "main", status: "completed", route: {}, startedAt: "now", observations: [] });
const side = (id: string): SideAnswer => ({ id, attemptId: id, question: "Question", snapshotAt: "now", route: {}, result: "Answer" });

it("rejects stale whole-session snapshots without changing persisted state", async () => {
  const { store, session } = await setup();
  const stale = (await store.load(session.projectPath, session.id))!;
  session.title = "Current"; await store.save(session);
  stale.title = "Stale";
  await expect(store.save(stale)).rejects.toBeInstanceOf(SessionConflictError);
  expect((await store.load(session.projectPath, session.id))?.title).toBe("Current");
});

for (const sideFirst of [false, true]) it(`preserves independent main and side records (${sideFirst ? "side" : "main"} writes first)`, async () => {
  const { root, store, session } = await setup();
  const secondStore = new PaceStore(root);
  const main = (await store.load(session.projectPath, session.id))!;
  const aside = (await secondStore.load(session.projectPath, session.id))!;
  main.route = { model: "main-model", effort: "high" }; main.threadId = "main-thread";
  main.attempts = [attempt("main")];
  aside.sideAnswers = [side("side")]; aside.attempts = [{ ...attempt("side"), role: "aside" }];
  const first = sideFirst ? () => secondStore.saveChanges(aside) : () => store.saveChanges(main);
  const second = sideFirst ? () => store.saveChanges(main) : () => secondStore.saveChanges(aside);
  await first(); await second();
  const saved = (await store.load(session.projectPath, session.id))!;
  expect(saved).toMatchObject({ route: main.route, threadId: "main-thread", sideAnswers: [side("side")] });
  expect(saved.attempts?.map(record => record.id).sort()).toEqual(["main", "side"]);
  expect(saved.revision).toBe(3);
});

it("rejects conflicting changes to the same field or attempt", async () => {
  const { store, session } = await setup();
  session.attempts = [attempt("one")]; await store.saveChanges(session);
  const first = (await store.load(session.projectPath, session.id))!;
  const second = (await store.load(session.projectPath, session.id))!;
  first.attempts![0]!.result = "First"; second.attempts![0]!.result = "Second";
  await store.saveChanges(first);
  await expect(store.saveChanges(second)).rejects.toThrow("attempts.one");
  const before = (await store.load(session.projectPath, session.id))!;
  const other = structuredClone(before);
  before.title = "First"; other.title = "Second";
  await store.saveChanges(before);
  await expect(store.saveChanges(other)).rejects.toThrow("title");
});

it("tracks spread snapshots by their revision and preserves unseen latest fields", async () => {
  const { store, session } = await setup();
  const spread = { ...session, title: "Main title" };
  await store.update(session, latest => { latest.sideAnswers = [side("side")]; });
  await store.saveChanges(spread);
  expect(spread.sideAnswers).toEqual([side("side")]);
  expect((await store.load(session.projectPath, session.id))?.title).toBe("Main title");
});

it("merges independent appended turns from separate session snapshots", async () => {
  const { root, store, session } = await setup();
  const secondStore = new PaceStore(root);
  const first = (await store.load(session.projectPath, session.id))!;
  const second = (await secondStore.load(session.projectPath, session.id))!;
  first.turns.push({ prompt: "First", result: "One", at: "2026-10-22T10:00:00.000Z" });
  second.turns.push({ prompt: "Second", result: "Two", at: "2026-10-22T10:00:01.000Z" });
  await store.saveChanges(first);
  await secondStore.saveChanges(second);
  expect((await store.load(session.projectPath, session.id))?.turns.map(turn => turn.prompt)).toEqual(["First", "Second"]);
});

it("serializes overlapping saves that enrich the same appended turn", async () => {
  const { store, session } = await setup();
  const turn = { prompt: "Task", result: "Done", at: "2026-10-22T10:00:00.000Z" };
  session.turns.push(turn);
  const initialSave = store.saveChanges(session);
  session.turns[0]!.activities = [{ id: "activity", category: "command", title: "Check", text: "npm test" }];
  const enrichmentSave = store.saveChanges(session);
  await Promise.all([initialSave, enrichmentSave]);
  expect((await store.load(session.projectPath, session.id))?.turns).toEqual([session.turns[0]]);
});

it("rejects conflicting contents for the same concurrently appended turn", async () => {
  const { root, store, session } = await setup();
  const secondStore = new PaceStore(root);
  const first = (await store.load(session.projectPath, session.id))!;
  const second = (await secondStore.load(session.projectPath, session.id))!;
  first.turns.push({ prompt: "First", result: "One", at: "2026-10-22T10:00:00.000Z" });
  second.turns.push({ prompt: "Second", result: "Two", at: "2026-10-22T10:00:00.000Z" });
  await store.saveChanges(first);
  await expect(secondStore.saveChanges(second)).rejects.toThrow("turns.");
});

it("keeps the 20 turn window when concurrent append saves merge", async () => {
  const { root, store, session } = await setup();
  const secondStore = new PaceStore(root);
  session.turns = Array.from({ length: 20 }, (_, index) => ({ prompt: `Turn ${index}`, result: "Done", at: `2026-10-22T09:${String(index).padStart(2, "0")}:00.000Z` }));
  await store.saveChanges(session);
  const first = (await store.load(session.projectPath, session.id))!;
  const second = (await secondStore.load(session.projectPath, session.id))!;
  first.turns = [...first.turns.slice(1), { prompt: "Turn 20", result: "Done", at: "2026-10-22T10:00:00.000Z" }];
  second.turns = [...second.turns.slice(1), { prompt: "Turn 21", result: "Done", at: "2026-10-22T10:00:01.000Z" }];
  await store.saveChanges(first);
  await secondStore.saveChanges(second);
  const turns = (await store.load(session.projectPath, session.id))!.turns;
  expect(turns).toHaveLength(20);
  expect(turns.at(-2)?.prompt).toBe("Turn 20");
  expect(turns.at(-1)?.prompt).toBe("Turn 21");
});

it("rejects concurrent edits to the same saved turn", async () => {
  const { root, store, session } = await setup();
  session.turns = [{ prompt: "Original", result: "Done", at: "2026-10-22T10:00:00.000Z" }];
  await store.saveChanges(session);
  const first = (await store.load(session.projectPath, session.id))!;
  const second = (await new PaceStore(root).load(session.projectPath, session.id))!;
  first.turns[0]!.result = "First edit";
  second.turns[0]!.result = "Second edit";
  await store.saveChanges(first);
  await expect(new PaceStore(root).saveChanges(second)).rejects.toThrow("turns");
});

it("serializes latest-state updates across independent store instances", async () => {
  const { root, store, session } = await setup();
  const second = new PaceStore(root);
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? store : second).update(session, async latest => {
    await new Promise(resolve => setTimeout(resolve, 1));
    latest.threadTurnCount = (latest.threadTurnCount ?? 0) + 1;
  }, false)));
  expect(await store.load(session.projectPath, session.id)).toMatchObject({ threadTurnCount: 8, revision: 9 });
});

it("leaves failed mutations unwritten and releases the update queue", async () => {
  const { store, session } = await setup();
  await expect(store.update(session, latest => { latest.title = "Bad"; throw new Error("failed mutation"); })).rejects.toThrow("failed mutation");
  expect((await store.load(session.projectPath, session.id))?.title).toBeUndefined();
  await store.update(session, latest => { latest.title = "Good"; });
  expect((await store.load(session.projectPath, session.id))?.title).toBe("Good");
});

it("migrates legacy sessions without a revision and rejects untracked stale baselines", async () => {
  const { root, store, session } = await setup();
  const legacy = { ...session }; delete legacy.revision;
  await writeFile(join(store.sessionDir(session.projectPath), `${session.id}.json`), JSON.stringify(legacy));
  const loaded = (await store.load(session.projectPath, session.id))!;
  loaded.title = "Legacy updated"; await store.saveChanges(loaded);
  expect(loaded.revision).toBe(1);
  const unknown = newSession("/other/project", "auto");
  const otherStore = new PaceStore(root);
  // A non-existent revision cannot stand in for the baseline of a copied object.
  const untracked = { ...unknown, id: session.id, projectPath: session.projectPath, revision: 999, title: "Unknown" };
  await expect(otherStore.saveChanges(untracked)).rejects.toThrow("unknown snapshot baseline");
});
