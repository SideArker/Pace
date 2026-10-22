import { expect, it } from "vitest";
import { assessmentRequest, controlRequest } from "../src/core/vex/requests.js";
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
  const request = assessmentRequest(session, "attempt");
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
  session.activeTask!.instructions = Array(100).fill("instruction ".repeat(1000));
  session.attempts = Array.from({ length: 12 }, (_, i) => ({ ...session.attempts![0]!, id: `attempt-${i}` }));
  session.sideAnswers = Array.from({ length: 20 }, (_, i) => ({ id: `side-${i}`, taskId: "task", attemptId: "attempt", question: "q".repeat(50_000), result: "r".repeat(50_000), snapshotAt: "now", route: {} }));
  const before = JSON.stringify(session);
  const request = controlRequest("Continue", session);
  expect(Buffer.byteLength(JSON.stringify(request.context))).toBeLessThanOrEqual(24_000);
  expect(request.context.projection).toMatchObject({ truncated: true });
  expect(request.context.latestRequest).toBe("Continue");
  expect(JSON.stringify(session)).toBe(before);
});

it("retains small complete evidence and marks no omissions", () => {
  const session = largeSession();
  session.attempts![0]!.observations[0]!.text = "npm test\nAssertions passed\nOutcome: success";
  const request = assessmentRequest(session, "attempt");
  expect(request.context.evidence).toEqual(session.attempts![0]!.observations);
  expect(request.context.projection).toBeUndefined();
});
