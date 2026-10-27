import { expect, it } from "vitest";
import { limitedAssessment, taskCriteria } from "../src/core/task-assessment.js";
import { parseSession } from "../src/core/session-record.js";
import { newSession } from "../src/core/sessions.js";
import type { StageAttempt } from "../src/shared/types.js";

function fixture() {
  const session = newSession("/project", "auto");
  session.activeTask = { id: "task", originalRequest: "Implement the feature", instructions: [], criteria: [
    { id: "api", text: "Preserve API", required: true }, { id: "tests", text: "Pass checks", required: true },
  ] };
  const attempt: StageAttempt = { id: "attempt", taskId: "task", role: "main", generation: 1, stage: "final", status: "completed", route: {}, startedAt: "now",
    taskCriteria: structuredClone(session.activeTask.criteria), observations: [
      { kind: "answer", text: "All tests passed (agent declaration)" },
      { kind: "activity", text: "command: npm test\nAssertions passed\nOutcome: success" },
      { kind: "artifacts", paths: ["artifacts/report.md"] },
    ] };
  session.attempts = [attempt];
  attempt.assessment = limitedAssessment(attempt, session.activeTask, "closed", "decision", false);
  return { session, attempt };
}

it("records versioned criteria and real evidence sources, while unsupported closed remains unknown", () => {
  const { session, attempt } = fixture();
  expect(attempt.assessment).toMatchObject({ version: 1, proposedValue: "closed", value: "unknown", evidence: 3,
    criteria: [{ id: "api", status: "unknown", evidenceIds: [] }, { id: "tests", status: "unknown", evidenceIds: [] }],
    evidenceCatalog: [{ id: "attempt:observation:0", source: "answer", verification: "reported" }, { id: "attempt:observation:1", source: "activity", verification: "reported" }, { id: "attempt:observation:2", source: "artifacts", paths: ["artifacts/report.md"] }],
  });
  expect(parseSession(JSON.parse(JSON.stringify(session)), session.projectPath)).toEqual(session);
  session.activeTask!.criteria![0]!.text = "Later criteria do not rewrite earlier attempts";
  expect(attempt.assessment!.criteria![0]!.criterion).toBe("Preserve API");
});

it("retains limited partial semantics, but omitted evidence or unavailable decisions produce unknown", () => {
  const { session, attempt } = fixture();
  expect(limitedAssessment(attempt, session.activeTask, "partial", "d", false).value).toBe("partial");
  expect(limitedAssessment(attempt, session.activeTask, "partial", "d", true).value).toBe("unknown");
  expect(limitedAssessment(attempt, session.activeTask, undefined, "d", false).value).toBe("unknown");
  expect(taskCriteria({ id: "legacy", originalRequest: "Do everything", instructions: [] })).toEqual([{ id: "legacy:goal", text: "Do everything", required: true }]);
});

for (const corruption of ["unknown-id", "wrong-source", "fake-path", "closed", "dropped-criterion", "fake-coverage"]) it(`rejects ${corruption} in a saved assessment`, () => {
  const { session, attempt } = fixture();
  const result = attempt.assessment!;
  if (corruption === "unknown-id") result.criteria![0]!.evidenceIds = ["invented-test"];
  if (corruption === "wrong-source") result.evidenceCatalog![0]!.source = "activity";
  if (corruption === "fake-path") result.evidenceCatalog![2]!.paths = ["imaginary.md"];
  if (corruption === "closed") result.value = "closed";
  if (corruption === "dropped-criterion") result.criteria!.pop();
  if (corruption === "fake-coverage") Object.assign(result.criteria![0]!, { status: "satisfied", missing: [], uncertainty: [] });
  expect(parseSession(session, session.projectPath)).toBeUndefined();
});

it("continues reading legacy enum assessments without inventing profile or evidence mappings", () => {
  const { session, attempt } = fixture();
  attempt.assessment = { value: "closed", evidence: 3, decisionId: "legacy" };
  expect(parseSession(session, session.projectPath)?.attempts?.[0]?.assessment).toEqual(attempt.assessment);
});
