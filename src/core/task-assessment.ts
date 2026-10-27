import type { ActiveTask, AssessmentEvidence, CompletionAssessment, StageAttempt, TaskAssessment } from "../shared/types.js";

export function taskCriteria(task: ActiveTask | undefined) {
  if (task?.criteria?.length) return task.criteria;
  // Preserve the goal verbatim; Pace cannot infer separate acceptance criteria.
  return task ? [{ id: `${task.id ?? "legacy"}:goal`, text: task.originalRequest, required: true }] : [];
}
export function assessmentEvidence(attempt: StageAttempt): AssessmentEvidence[] {
  return attempt.observations.map((observation, observationIndex) => ({
    id: `${attempt.id}:observation:${observationIndex}`, attemptId: attempt.id, observationIndex,
    source: observation.kind, ...(observation.paths ? { paths: [...observation.paths] } : {}), verification: "reported",
  }));
}

/** vex_choose v1 supplies no criterion/evidence links. Never manufacture those links. */
export function limitedAssessment(attempt: StageAttempt, task: ActiveTask | undefined, proposedValue: TaskAssessment | undefined, decisionId: string, evidenceOmitted: boolean): CompletionAssessment {
  const limitation = "vex_choose contractVersion 1 returns a choice and probabilities, without criterion statuses or evidence references.";
  const criteria = attempt.taskCriteria ?? taskCriteria(task);
  return {
    version: 1, value: proposedValue === "partial" && !evidenceOmitted ? "partial" : "unknown",
    proposedValue, decisionId, evidence: attempt.observations.length,
    criteria: criteria.map(criterion => ({
      id: criterion.id, criterion: criterion.text, required: criterion.required, status: "unknown",
      evidenceIds: [], missing: ["A supported criterion-to-evidence assessment is unavailable."],
      uncertainty: [limitation, ...(evidenceOmitted ? ["Request projection omitted potentially necessary evidence."] : [])],
    })),
    evidenceCatalog: assessmentEvidence(attempt),
    limitations: [limitation, "Observations and agent answers are reported evidence; their presence does not prove an independently verified test.",
      ...(criteria.length ? [] : ["No explicit task goal or criteria were recorded."]),
      ...(proposedValue ? [] : ["The assessment decision was unavailable."])],
  };
}
