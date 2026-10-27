import { projectVexRequest, vexPayloadBytes, VEX_PAYLOAD_BUDGET, VexPayloadBudgetError } from "../src/core/vex/context.js";
import { expect, it } from "vitest";
import { assessmentRequest, controlRequest, shapeRequest, stageRequest, type VexRequest } from "../src/core/vex/requests.js";
import { newSession } from "../src/core/sessions.js";

function largeSession() {
  const session = newSession("/project", "auto");
  session.activeTask = { id: "task", originalRequest: "Implement and test every acceptance criterion", instructions: [] };
  session.attempts = [{
    id: "attempt", taskId: "task", generation: 1, role: "main", stage: "final",
    status: "completed", route: {}, startedAt: "now", result: "Implementation done; manual check remains",
    observations: [
      { kind: "activity", text: `npm test\n${'"\\\ną'.repeat(90_000)}\nOutcome: failure` },
      { kind: "answer", text: "Implementation done; manual check remains" },
      { kind: "artifacts", paths: ["report.md"] },
    ],
  }];
  return session;
}

it("bounds serialized assessment context, includes observations once, and preserves the full session", () => {
  const session = largeSession();
  const before = JSON.stringify(session);
  const { request } = projectVexRequest(assessmentRequest(session, "attempt"));
  expect(Buffer.byteLength(JSON.stringify(request.context))).toBeLessThanOrEqual(24_000);
  expect(request.context.attempt).not.toHaveProperty("observations");
  expect(request.context.projection).toMatchObject({ truncated: true });
  expect(JSON.stringify(request.context.evidence)).toContain("Outcome: failure");
  expect(JSON.stringify(request.context.evidence)).toContain("manual check remains");
  expect(JSON.stringify(request.context.evidence)).toContain("report.md");
  expect(request.constraints).toContain("omitted");
  expect(JSON.stringify(session)).toBe(before);
});

it("bounds follow-up control requests containing many large attempts, goals and side answers", () => {
  const session = largeSession();
  session.activeTask!.instructions = ["Keep all public APIs"];
  session.attempts = Array.from({ length: 12 }, (_, i) => ({ ...session.attempts![0]!, id: `attempt-${i}` }));
  session.sideAnswers = Array.from({ length: 20 }, (_, i) => ({ id: `side-${i}`, taskId: "task", attemptId: "attempt", question: "q".repeat(50_000), result: "r".repeat(50_000), snapshotAt: "now", route: {} }));
  const before = JSON.stringify(session);
  const { request } = projectVexRequest(controlRequest("Continue", session));
  expect(Buffer.byteLength(JSON.stringify(request.context))).toBeLessThanOrEqual(24_000);
  expect(request.context.projection).toMatchObject({ truncated: true });
  expect(request.context.latestRequest).toBe("Continue");
  expect(JSON.stringify(session)).toBe(before);
});

it("retains small complete evidence and marks no omissions", () => {
  const session = largeSession();
  session.attempts![0]!.observations[0]!.text = "npm test\nAssertions passed\nOutcome: success";
  const { request } = projectVexRequest(assessmentRequest(session, "attempt"));
  expect(request.context.evidence).toMatchObject(session.attempts![0]!.observations);
  expect(request.context.projection).toBeUndefined();
});

const models = [{ model: "gpt-6.1-sol", efforts: ["medium" as const] }];
for (const kind of ["workflow", "stage", "side", "control", "assessment", "adopt_side"]) it(`budgets the entire ${kind} tool request deterministically without changing saved inputs`, () => {
  const session = largeSession();
  session.activeTask!.criteria = [{ id: "criterion", text: "All checks pass", required: true }];
  session.activeTask!.constraints = ["Preserve the API"];
  session.turns = Array.from({ length: 20 }, (_, index) => ({ prompt: `Question ${index}: ` + "content ".repeat(500), result: "Realistically long history: " + "content ".repeat(5000), at: String(index) }));
  const state = { activeTask: session.activeTask };
  const raw: VexRequest = kind === "workflow" ? shapeRequest("Work", session.turns, models, undefined, state)
    : kind === "control" ? controlRequest("Continue", session)
    : kind === "assessment" ? assessmentRequest(session, "attempt")
    : kind === "adopt_side" ? { question: "Choose source", constraints: "One source only", options: [{ id: "source", description: "A side answer" }], decisionType: "routing", context: { request: "Use source", sources: [{ id: "source", result: "x".repeat(100_000) }], activeTask: session.activeTask } }
    : stageRequest("Work", session.turns, models, kind === "side" ? "Side answer" : "Complete", "handoff ".repeat(10_000), models, undefined, state);
  const before = JSON.stringify(raw), saved = JSON.stringify(session);
  const projected = projectVexRequest(raw);
  expect(projected).toEqual(projectVexRequest(raw));
  expect(projectVexRequest(projected.request).request).toEqual(projected.request);
  expect(vexPayloadBytes(projected.request)).toBeLessThanOrEqual(VEX_PAYLOAD_BUDGET);
  expect(projected.projection).toMatchObject({ truncated: true, originalBytes: vexPayloadBytes(raw), finalBytes: vexPayloadBytes(projected.request) });
  expect(projected.projection.omittedClasses.length).toBeGreaterThan(0);
  expect(projected.request.options).toEqual(raw.options);
  expect(projected.request.question).toBe(raw.question);
  expect(projected.request.constraints).toBe(raw.constraints);
  expect(JSON.stringify(projected.request.context)).toContain("All checks pass");
  expect(JSON.stringify(projected.request.context)).toContain("Preserve the API");
  expect(JSON.stringify(raw)).toBe(before); expect(JSON.stringify(session)).toBe(saved);
});

it("preserves under-budget requests exactly and fails explicitly when protected fields cannot fit", () => {
  const raw = shapeRequest("Work", [], models);
  expect(projectVexRequest(raw).request).toBe(raw);
  raw.options[0]!.description = "option ".repeat(10_000);
  expect(() => projectVexRequest(raw)).toThrow(VexPayloadBudgetError);
  raw.options[0]!.description = "Single";
  raw.context.activeTask = { originalRequest: "Work", instructions: [], criteria: [{ id: "c", text: "c".repeat(30_000), required: true }] };
  expect(() => projectVexRequest(raw)).toThrow(VexPayloadBudgetError);
  raw.context.activeTask = { originalRequest: "Work", instructions: [], constraints: ["c".repeat(30_000)] };
  expect(() => projectVexRequest(raw)).toThrow(VexPayloadBudgetError);
});

it("can omit pathological optional key counts while retaining the active criteria and constraints", () => {
  const raw = shapeRequest("Work", [], models);
  raw.context.activeTask = { id: "task", originalRequest: "Work", instructions: [], criteria: [{ id: "c", text: "Pass checks", required: true }], constraints: ["Keep API"] };
  raw.context.optionalArchive = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`large-key-${index}`, "data"]));
  const result = projectVexRequest(raw);
  expect(vexPayloadBytes(result.request)).toBeLessThanOrEqual(VEX_PAYLOAD_BUDGET);
  expect(result.request.context.activeTask).toEqual(raw.context.activeTask);
  expect(result.projection).toMatchObject({ truncated: true, requiredEvidenceOmitted: true, omittedClasses: expect.arrayContaining(["otherContext"]) });
});
