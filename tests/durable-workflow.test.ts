import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/core/orchestrator.js";
import { PaceStore, newSession, undoConversationTurn } from "../src/core/sessions.js";
import { taskAccounting, TransitionSaveError } from "../src/core/task-execution.js";
import { adoptedSidePrompt, operation, preparePlanExecution, saveRoutingSelection } from "../src/core/operations.js";
import { DEFAULT_ROUTING_PROMPTS } from "../src/core/routing/routing-prompts.js";
import type { Config, Session } from "../src/shared/types.js";
import type { CodexRunner } from "../src/integrations/codex-types.js";
import { CodexRunError } from "../src/integrations/codex-types.js";
import type { VexRequest } from "../src/core/vex/requests.js";
import { decision } from "./routing-fixture.js";

vi.mock("../src/core/routing/pricing.js", async original => {
  const module = await original<typeof import("../src/core/routing/pricing.js")>();
  return { ...module, refreshVersionManifest: async () => module.currentVersionManifest() };
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const config: Config = { routingMode: "auto", defaultRoute: { model: "gpt-6.1-sol", effort: "medium" }, models: [{ model: "gpt-6.1-sol", efforts: ["medium", "high"] }] };
const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 };
const report = JSON.stringify({ summary: "Located code; implementation remains", findings: [], checks: [], risks: [], nextSteps: ["Implement"] });
async function setup(shape = "single") {
  const root = await mkdtemp(join(tmpdir(), "pace-workflow-")); roots.push(root);
  const store = new PaceStore(join(root, "storage")); const session = newSession(root, "auto");
  const calls: Parameters<CodexRunner["run"]>[] = []; const requests: VexRequest[] = [];
  let action = "continue", selectedShape = shape, assessment = "partial";
  const vex = { choose: async (request: VexRequest) => {
    requests.push(structuredClone(request));
    return decision(request, request.options.some(item => item.id === "closed") ? assessment : request.options.some(item => item.id === "reroute") ? action : request.options[0]?.id === "single" ? selectedShape : "0:medium");
  } };
  const runner: CodexRunner = { run: async (...args) => {
    calls.push(args); const [prompt, , , thread, progress, , mode] = args;
    const id = thread ?? `thread-${calls.length}`; await progress({ kind: "thread", text: id });
    await progress({ kind: "tasks", items: [{ text: `${mode} task`, completed: false }] });
    await progress({ kind: "activity", id: "check", category: "command", title: "npm test", completed: true, outcome: "success", detail: "Assertions passed" });
    if (mode === "planning") { const path = prompt.match(/The saved plan path is ([^\n]+?\.pace-plan\.md)/)?.[1]; if (path) await writeFile(path, "# Full saved plan\nImplement and verify all requirements."); }
    return { result: mode === "side" && prompt.includes("JSON object") ? report : "Result with remaining scope", completed: true, threadId: id, turnId: `turn-${calls.length}`, usage };
  } };
  const orchestrator = new Orchestrator(store, runner, vex);
  return { root, store, session, calls, requests, runner, orchestrator, vex, setAction: (value: string) => { action = value; }, setShape: (value: string) => { selectedShape = value; }, setAssessment: (value: string) => { assessment = value; } };
}

it("keeps workflow, lead and stage across restart; a plan correction never repeats the completed scout", async () => {
  const env = await setup("scout_plan");
  await env.orchestrator.turn("Plan the complete feature", env.session, config, () => {});
  expect(env.calls.map(call => call[6])).toEqual(["side", "planning"]);
  const loaded = (await new PaceStore(env.store.baseDir).load(env.root, env.session.id))!;
  const lead = loaded.threadId; const route = structuredClone(loaded.route); const taskId = loaded.activeTask?.id;
  const before = env.requests.length;
  await env.orchestrator.turn("Correct the plan", loaded, config, () => {});
  expect(env.calls.map(call => call[6])).toEqual(["side", "planning", "planning"]);
  expect(env.calls[2]?.[3]).toBe(lead); expect(loaded.route).toEqual(route);
  expect(loaded.activeTask?.id).toBe(taskId); expect(JSON.parse(loaded.activeTask!.workflow!.scoutHandoff!)).toEqual(JSON.parse(report));
  expect(env.requests.slice(before).map(item => item.options[0]?.id)).toEqual(["continue", "closed"]);
  expect(loaded.attempts).toHaveLength(3); expect(loaded.attempts?.every(item => item.assessment)).toBe(true);
});

it("deliberate replan creates a new workflow generation and reruns only explicitly selected scout", async () => {
  const env = await setup("scout"); await env.orchestrator.turn("Implement", env.session, config, () => {});
  env.setAction("replan"); await env.orchestrator.turn("Same words", env.session, config, () => {});
  expect(env.session.activeTask?.workflow?.generation).toBe(2);
  expect(env.calls.map(item => item[6])).toEqual(["side", "main", "side", "main"]);
  expect(new Set(env.session.attempts?.map(item => item.id)).size).toBe(4);
});

for (const action of ["continue", "reroute", "replace", "aside", "clarify"]) it(`executes semantic ${action} for identical short follow-up`, async () => {
  const env = await setup(); await env.orchestrator.turn("Implement the feature", env.session, config, () => {});
  const id = env.session.activeTask?.id; const thread = env.session.threadId; const route = structuredClone(env.session.route);
  const before = env.calls.length; env.setAction(action);
  const outcome = await env.orchestrator.turn("OK", env.session, config, () => {});
  if (action === "clarify") expect(env.calls).toHaveLength(before);
  else if (action === "aside") { expect(outcome.role).toBe("aside"); expect(outcome.session.sideAnswers).toHaveLength(1); expect(env.session.threadId).toBe(thread); expect(env.session.route).toEqual(route); }
  else { expect(env.calls).toHaveLength(before + 1); expect(env.calls.at(-1)?.[3]).toBe(thread); expect(env.session.activeTask?.id === id).toBe(action !== "replace"); }
});

it("does not start a stage if its mandatory start save fails", async () => {
  const env = await setup(); const save = env.store.saveChanges.bind(env.store);
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (args[0].attempts?.some(item => item.status === "running")) throw new Error("disk full before runner");
    return save(...args);
  });
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toBeInstanceOf(TransitionSaveError);
  expect(env.calls).toHaveLength(0);
});

for (const shape of ["single", "scout"]) it(`post-${shape} save failure is recovered after restart and continues from saved state`, async () => {
  const env = await setup(shape); const save = env.store.saveChanges.bind(env.store);
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (args[0].attempts?.some(item => item.status === "completed")) throw new Error("disk full after runner");
    return save(...args);
  });
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toBeInstanceOf(TransitionSaveError);
  expect(env.calls).toHaveLength(1);
  vi.restoreAllMocks(); const loaded = (await env.store.load(env.root, env.session.id))!;
  expect(loaded.attempts?.[0]).toMatchObject({ status: "failed", threadId: "thread-1" });
  expect(loaded.attempts?.[0]?.error).toContain("Pace stopped");
  await env.orchestrator.turn("Continue only unfinished work", loaded, config, () => {});
  expect(env.calls).toHaveLength(shape === "scout" ? 3 : 2);
  if (shape === "scout") expect(env.calls.at(-1)?.[6]).toBe("main");
});

it("Vex completion has recorded core evidence and does not derive completion from turn/completed", async () => {
  const env = await setup(); env.setAssessment("unknown");
  await env.orchestrator.turn("Implement and check all modules", env.session, config, () => {});
  expect(env.session.activeTask?.assessment).toBe("unknown");
  const request = env.requests.find(item => item.options[0]?.id === "closed")!;
  expect(request.context.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "tasks" }), expect.objectContaining({ kind: "activity", text: expect.stringContaining("Assertions passed") }), expect.objectContaining({ kind: "answer" }), expect.objectContaining({ kind: "artifacts" })]));
  expect(env.session.attempts?.[0]?.assessment).toMatchObject({ value: "unknown", evidence: 4 });
});

it("persists a new thread immediately and checkpoints progress while execution is still active", async () => {
  const env = await setup();
  env.runner.run = async (...args) => {
    await args[4]({ kind: "thread", text: "checkpoint-thread" });
    let saved = (await env.store.load(env.root, env.session.id))!;
    expect(saved.attempts?.[0]?.threadId).toBe("checkpoint-thread");
    expect(saved.threadId).toBe("checkpoint-thread");
    expect(saved.attempts?.[0]?.status).toBe("running");
    await args[4]({ kind: "activity", id: "live-check", category: "command", title: "npm test", completed: false });
    await args[4]({ kind: "tasks", items: [{ text: "Checkpointed task", completed: false }] });
    await new Promise(resolve => setTimeout(resolve, 2_100));
    saved = (await env.store.load(env.root, env.session.id))!;
    expect(saved.attempts?.[0]?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "activity", text: expect.stringContaining("npm test") }),
      expect.objectContaining({ kind: "tasks", items: [{ text: "Checkpointed task", completed: false }] }),
    ]));
    expect(saved.tasks?.some(task => task.text === "Checkpointed task")).toBe(true);
    expect(saved.attempts?.[0]?.status).toBe("running");
    return { result: "Done", completed: true, threadId: "checkpoint-thread", usage };
  };
  await env.orchestrator.turn("Implement", env.session, config, () => {});
});

for (const cancel of [false, true]) it(`retains ${cancel ? "cancelled" : "failed"} usage attempts after retry, deduplication, truncation and undo`, async () => {
  const env = await setup(); const controller = new AbortController();
  env.runner.run = async () => { if (cancel) controller.abort(); throw new CodexRunError("failed after inference", usage); };
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {}, controller.signal)).rejects.toThrow("failed after inference");
  expect(env.session.attempts?.[0]).toMatchObject({ status: cancel ? "cancelled" : "failed", usage });
  const known = taskAccounting(env.session).knownSubtotalUsd;
  env.session.turns = Array.from({ length: 20 }, () => ({ at: "now", prompt: "Visible", result: "Text" })); undoConversationTurn(env.session);
  expect(env.session.activeTask?.assessment).toBe("unknown");
  expect(taskAccounting(env.session).knownSubtotalUsd).toBe(known); expect(known).toBeGreaterThan(0);
});

it("isolates verifier tasks, thread, route, count, context, checkpoint and task even when checkpoint is due", async () => {
  const env = await setup("plan"); await env.orchestrator.turn("Plan", env.session, config, () => {});
  env.session.threadTurnCount = 16;
  env.session.autoLaunchSkills = ["sample-skill"]; env.session.autoLaunchThreadId = "main-skills-thread";
  env.session.undoneTurns = [{ prompt: "Undone", result: "Retained redo", at: "before" }];
  const ownership = structuredClone({ autoLaunchThreadId: env.session.autoLaunchThreadId, undoneTurns: env.session.undoneTurns });
  const main = { threadId: env.session.threadId, route: structuredClone(env.session.route), tasks: structuredClone(env.session.tasks), count: env.session.threadTurnCount, context: structuredClone(env.session.contextByThread), task: structuredClone(env.session.activeTask), checkpoint: env.session.checkpoint };
  await env.orchestrator.turn("Verify full plan", env.session, config, () => {}, undefined, true, "verify_plan");
  await env.orchestrator.turn("Check again", env.session, config, () => {}, undefined, true, "continue_verify");
  expect({ threadId: env.session.threadId, route: env.session.route, tasks: env.session.tasks, count: env.session.threadTurnCount, context: env.session.contextByThread, task: env.session.activeTask, checkpoint: env.session.checkpoint }).toEqual(main);
  expect({ autoLaunchThreadId: env.session.autoLaunchThreadId, undoneTurns: env.session.undoneTurns }).toEqual(ownership);
  expect(env.session.verifier?.threadTurnCount).toBe(2); expect(env.session.verifier?.tasks?.[0]?.text).toBe("side task");
});

it("persists side result without taking over lead; explicit adoption carries source and does not forward every result", async () => {
  const env = await setup(); await env.orchestrator.turn("Implement", env.session, config, () => {});
  const main = structuredClone(env.session.activeTask); const lead = env.session.threadId;
  const side = await env.orchestrator.aside("Explain known fact", env.session, config, () => {});
  expect(side.session.activeTask).toEqual(main); expect(side.session.threadId).toBe(lead); expect(env.calls.at(-1)?.[3]).toBeUndefined();
  const loaded = (await env.store.load(env.root, env.session.id))!;
  const id = loaded.sideAnswers![0]!.id;
  const transfer = { ...operation("Use finding", loaded.id, loaded.activeTask?.id), intent: "adopt_side" as const, sourceSideId: id };
  await env.orchestrator.turn("Use finding", loaded, config, () => {}, undefined, true, "adopt_side", undefined, transfer);
  expect(env.calls.at(-1)?.[0]).toContain(`Source side answer: ${id}`); expect(loaded.sideAnswers?.[0]?.adopted).toBe(true);
});

it("loads custom profiles in manually delegated scout workflow without Luna", async () => {
  const env = await setup(); const prompts = structuredClone(DEFAULT_ROUTING_PROMPTS); prompts.stage.question = "User custom route chooser";
  await writeFile(join(env.store.baseDir, "routing-prompts.json"), JSON.stringify(prompts)).catch(async () => { await env.store.save(env.session); await writeFile(join(env.store.baseDir, "routing-prompts.json"), JSON.stringify(prompts)); });
  env.session.routingMode = "manual"; env.session.manualWorkflow = { shape: "scout", routes: { scout: "vex", final: "vex" } };
  await env.orchestrator.turn("Implement", env.session, config, () => {});
  expect(env.calls.map(item => item[6])).toEqual(["side", "main"]); expect(env.requests.filter(item => item.context.stageObjective).every(item => item.question === "User custom route chooser")).toBe(true);
});

it("shared execution reads latest artifact, creates normal fresh task and records full source plan", async () => {
  const env = await setup("plan"); await env.orchestrator.turn("Plan", env.session, config, () => {});
  const path = join(env.store.conversationDir(env.root, env.session.id), env.session.planArtifact!);
  await writeFile(path, "# Current complete plan\nChanged after previous turn.");
  env.session.routingMode = "manual";
  const execution = await preparePlanExecution(env.store, env.session, config);
  expect(execution.session).toMatchObject({ kind: "normal", routingMode: "auto", executionSource: { sessionId: env.session.id, taskId: env.session.activeTask?.id, plan: "# Current complete plan\nChanged after previous turn." } });
  expect(execution.session.id).not.toBe(env.session.id); expect(execution.prompt).toContain("Changed after previous turn.");
});

it("accepted verification changes keep the planner task and completed scout", async () => {
  const env = await setup("scout_plan");
  await env.orchestrator.turn("Plan entire feature", env.session, config, () => {});
  const taskId = env.session.activeTask!.id;
  const handoff = env.session.activeTask!.workflow!.scoutHandoff;
  const lead = env.session.threadId;
  await env.orchestrator.turn("Apply accepted findings", env.session, config, () => {}, undefined, true, "revise_plan");
  expect(env.session.activeTask).toMatchObject({ id: taskId, originalRequest: "Plan entire feature" });
  expect(env.session.activeTask!.workflow!.scoutHandoff).toBe(handoff);
  expect(env.calls.map(item => item[6])).toEqual(["side", "planning", "planning"]);
  expect(env.calls.at(-1)?.[3]).toBe(lead);
});

it("failed terminal persistence is recovered automatically on the current in-memory session", async () => {
  const env = await setup(); const save = env.store.saveChanges.bind(env.store);
  vi.spyOn(env.store, "saveChanges").mockImplementation(async (...args) => {
    if (args[0].attempts?.some(item => item.status === "completed")) throw new Error("disk full");
    return save(...args);
  });
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toBeInstanceOf(TransitionSaveError);
  vi.restoreAllMocks();
  await env.orchestrator.turn("Continue only unfinished work", env.session, config, () => {});
  expect(env.session.attempts?.[0]?.status).toBe("failed");
  expect(env.calls).toHaveLength(2);
});

it("technical noncompletion stops a scout before any final agent starts", async () => {
  const env = await setup("scout");
  env.runner.run = async () => ({ result: report, completed: false, usage });
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toThrow("did not complete");
  expect(env.session.attempts).toHaveLength(1);
  expect(env.session.attempts![0]).toMatchObject({ role: "scout", status: "failed", usage });
  expect(env.session.activeTask!.workflow!.scoutHandoff).toBeUndefined();
});

it("legacy command-looking queue strings remain plain prompts when drained", async () => {
  const env = await setup();
  await env.store.save(env.session);
  const legacy = operation("/verify", env.session.id);
  await env.orchestrator.turn(legacy.text, env.session, config, () => {}, undefined, true, legacy.intent, undefined, legacy);
  expect(env.calls).toHaveLength(1);
  expect(env.calls[0]?.[6]).toBe("main");
});

it("side result refreshes the calling snapshot for immediate explicit adoption", async () => {
  const env = await setup(); await env.orchestrator.turn("Implement", env.session, config, () => {});
  await env.orchestrator.aside("Explain", env.session, config, () => {});
  expect(adoptedSidePrompt(env.session, env.session.sideAnswers![0]!.id)).toContain("Source side answer:");
});

it("explicit manual workflow changes are recorded and take effect on the existing task", async () => {
  const env = await setup(); await env.orchestrator.turn("Implement", env.session, config, () => {});
  const { manualSelection } = await import("../src/core/operations.js");
  const changed = manualSelection(env.session, { shape: "scout", routes: { scout: "vex", final: "vex" } });
  await env.store.saveChanges(changed);
  await env.orchestrator.turn("Continue with selected workflow", changed, config, () => {});
  expect(env.calls.map(item => item[6])).toEqual(["main", "side", "main"]);
  expect(changed.activeTask?.id).toBe(env.session.activeTask?.id);
  expect(changed.controlDecisions?.some(item => item.source === "user" && item.choice === "scout")).toBe(true);
});

it("saves a manual workflow from the UI snapshot emitted before the turn's final saves", async () => {
  const env = await setup();
  let displayed: Session | undefined;
  const run = env.runner.run;
  env.runner.run = async (...args) => {
    await args[4]({ kind: "tasks", items: [{ text: "Implement", completed: false }] });
    return run(...args);
  };
  await env.orchestrator.turn("Implement", env.session, config, event => {
    if (event.kind === "tasks") displayed = { ...env.session };
  });
  expect(displayed).toBeDefined();
  expect(displayed!.revision).toBeLessThan(env.session.revision!);
  expect(displayed!.activeTask).toBe(env.session.activeTask);
  expect(displayed!.activeTask?.workflow?.status).toBe("completed");
  const previous = structuredClone(env.session);
  const changed = await saveRoutingSelection(env.store, displayed!, { shape: "scout", routes: { scout: "vex", final: "vex" } });
  const saved = (await env.store.load(env.root, env.session.id))!;
  expect(saved).toEqual(changed);
  expect(saved.activeTask?.workflow).toMatchObject({ shape: "scout", generation: 2 });
  expect(saved.attempts).toEqual(previous.attempts);
  expect(saved.turns).toEqual(previous.turns);
  expect(saved.controlDecisions).toHaveLength(previous.controlDecisions!.length + 1);
  await env.orchestrator.turn("Continue with selected workflow", changed, config, () => {});
  expect(env.calls.map(item => item[6])).toEqual(["main", "side", "main"]);
});

it("a concurrent side completion cannot receive the main answer's assessment or artifacts", async () => {
  const env = await setup(); await env.orchestrator.turn("Implement", env.session, config, () => {});
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const original = env.runner.run;
  env.runner.run = async (...args) => { if (args[6] === "main") await wait; return original(...args); };
  const main = env.orchestrator.turn("Continue", env.session, config, () => {});
  await vi.waitFor(() => expect(env.session.attempts?.at(-1)?.status).toBe("running"));
  await env.orchestrator.aside("Independent fact", env.session, config, () => {});
  release(); await main;
  const attempts = (await env.store.load(env.root, env.session.id))!.attempts!;
  const completion = attempts.filter(item => item.role === "main").at(-1)!;
  const side = attempts.find(item => item.role === "aside")!;
  expect(completion.assessment).toBeDefined();
  expect(completion.observations.at(-1)?.kind).toBe("artifacts");
  expect(side.observations.some(item => item.kind === "artifacts")).toBe(false);
});

it("all repeated failed attempts survive visible-error deduplication and retain unknown full cost", async () => {
  const env = await setup(); let invocation = 0;
  const original = env.runner.run;
  env.runner.run = async () => { invocation++; throw new CodexRunError("capacity after partial inference", invocation % 3 === 0 ? undefined : usage); };
  for (let index = 0; index < 24; index++) await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toThrow("capacity");
  expect(env.session.turns).toHaveLength(1);
  expect(env.session.attempts).toHaveLength(24);
  const subtotal = taskAccounting(env.session).knownSubtotalUsd;
  expect(subtotal).toBeGreaterThan(0); expect(taskAccounting(env.session).complete).toBe(false);
  env.runner.run = original; await env.orchestrator.turn("Implement", env.session, config, () => {});
  expect(env.session.attempts).toHaveLength(25);
  expect(taskAccounting(env.session).knownSubtotalUsd).toBeGreaterThan(subtotal);
  expect(taskAccounting(env.session).totalUsd).toBeUndefined();
});

it("a failed side answer records its usage and error without failing or altering the main task", async () => {
  const env = await setup(); await env.orchestrator.turn("Implement", env.session, config, () => {});
  const before = structuredClone({ task: env.session.activeTask, route: env.session.route, thread: env.session.threadId, count: env.session.threadTurnCount, context: env.session.contextByThread, checkpoint: env.session.checkpoint, tasks: env.session.tasks });
  env.runner.run = async () => { throw new CodexRunError("side inference failed", usage); };
  await expect(env.orchestrator.aside("Explain", env.session, config, () => {})).rejects.toThrow("side inference failed");
  expect({ task: env.session.activeTask, route: env.session.route, thread: env.session.threadId, count: env.session.threadTurnCount, context: env.session.contextByThread, checkpoint: env.session.checkpoint, tasks: env.session.tasks }).toEqual(before);
  expect(env.session.sideAnswers?.[0]?.error).toContain("side inference failed");
  expect(env.session.attempts?.find(item => item.role === "aside")).toMatchObject({ status: "failed", usage });
});

it("manual delegation chooses a lead once and retains it on the next ordinary stage continuation", async () => {
  const env = await setup(); env.session.routingMode = "manual";
  env.session.manualWorkflow = { shape: "scout", routes: { scout: "vex", final: "vex" } };
  await env.orchestrator.turn("Implement", env.session, config, () => {});
  const before = env.requests.length;
  await env.orchestrator.turn("Continue", env.session, config, () => {});
  expect(env.calls.map(item => item[6])).toEqual(["side", "main", "main"]);
  expect(env.requests.slice(before).map(item => item.options[0]?.id)).toEqual(["closed"]);
});

it("an execution session accepts later queued prompts addressed to its own task", async () => {
  const env = await setup("plan"); await env.orchestrator.turn("Plan", env.session, config, () => {});
  const execution = await preparePlanExecution(env.store, env.session, config);
  env.setShape("single");
  await env.orchestrator.turn(execution.prompt, execution.session, config, () => {}, undefined, true, "execute_plan");
  const followup = operation("Continue unfinished execution", execution.session.id, execution.session.activeTask?.id);
  const thread = execution.session.threadId;
  await env.orchestrator.turn(followup.text, execution.session, config, () => {}, undefined, true, undefined, undefined, followup);
  expect(env.calls.at(-1)?.[3]).toBe(thread);
  expect(execution.session.turns.at(-1)?.operation?.sessionId).toBe(execution.session.id);
});

it("resumes a prepared execution with its exact additional instructions after restart", async () => {
  const env = await setup();
  env.session.plan = "# Full plan\nImplement the feature.";
  const item = operation("Execute with constraints", env.session.id);
  const prepared = await preparePlanExecution(env.store, env.session, config, "Preserve public API. Run the integration checks.", item.id);
  const restarted = new PaceStore(env.store.baseDir);
  env.session.plan = "# A later unrelated edit";
  const resumed = await preparePlanExecution(restarted, env.session, config, undefined, item.id);
  expect(resumed.session.id).toBe(prepared.session.id);
  expect(resumed.prompt).toBe(prepared.prompt);
  expect(resumed.prompt).toContain("Preserve public API. Run the integration checks.");
  expect(resumed.prompt).not.toContain("A later unrelated edit");
});

it("executes an explicit plan file even when the source session artifact is missing", async () => {
  const env = await setup();
  env.session.planArtifact = "artifacts/missing.pace-plan.md";
  const path = join(env.root, "replacement.md");
  await writeFile(path, "# Replacement plan\nImplement and verify the API.");
  const prepared = await preparePlanExecution(env.store, env.session, config, `${path} Keep the existing schema.`);
  expect(prepared.session.executionSource).toMatchObject({ artifact: path, plan: "# Replacement plan\nImplement and verify the API." });
  expect(prepared.prompt).toContain("Keep the existing schema.");
});

it("interactive clarification offers and executes a scout without Luna and records the user's choice", async () => {
  const env = await setup("clarify");
  const progress = Object.assign((event: import("../src/integrations/codex-types.js").Progress) => {
    if (event.kind === "question") {
      expect(event.questions[0]?.options.some(item => item.label === "Scout codebase first")).toBe(true);
      event.respond({ workflow: { answers: ["Scout codebase first"] } });
    }
  }, { interactive: true });
  await env.orchestrator.turn("Help with the repository", env.session, config, progress);
  expect(env.calls.map(item => item[6])).toEqual(["side", "main"]);
  expect(env.session.activeTask?.workflow?.source).toBe("user");
  expect(env.session.controlDecisions?.some(item => item.source === "user" && item.choice === "scout")).toBe(true);
});

it("a first-message side answer persists and refreshes a previously unsaved session", async () => {
  const env = await setup();
  await env.orchestrator.aside("Explain this known fact", env.session, config, () => {});
  expect(env.session.sideAnswers).toHaveLength(1);
  expect(env.session.activeTask).toBeUndefined();
  expect(env.session.threadId).toBeUndefined();
  expect((await env.store.load(env.root, env.session.id))?.attempts?.[0]?.role).toBe("aside");
});

it("invalid Vex responses retain retry count and latency without a guessed action or model call", async () => {
  const env = await setup(); env.vex.choose = async () => ({ choice: "invalid" }) as never;
  await expect(env.orchestrator.turn("Implement", env.session, config, () => {})).rejects.toThrow("Invalid Vex routing decision");
  expect(env.calls).toHaveLength(0);
  expect(env.session.controlDecisions?.at(-1)).toMatchObject({ requests: 2, failed: true, choice: "unavailable", source: "vex" });
});

it("concurrent side snapshots attach each result to its own durable attempt", async () => {
  const env = await setup(); await env.store.save(env.session);
  env.runner.run = async prompt => ({ result: prompt.endsWith("Question A") ? "Answer A" : "Answer B", completed: true, usage });
  await Promise.all([
    env.orchestrator.aside("Question A", env.session, config, () => {}),
    env.orchestrator.aside("Question B", env.session, config, () => {}),
  ]);
  const saved = (await env.store.load(env.root, env.session.id))!;
  expect(saved.sideAnswers).toHaveLength(2);
  for (const answer of saved.sideAnswers!) expect(saved.attempts!.find(item => item.id === answer.attemptId)?.result).toBe(answer.result);
});
