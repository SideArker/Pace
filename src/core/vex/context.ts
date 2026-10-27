import type { VexProjection } from "../../shared/types.js";
import type { VexRequest } from "./requests.js";

export const MAX_VEX_TOOL_BYTES = 24_000;
export const VEX_ENVELOPE_RESERVE_BYTES = 2_000;
export const VEX_PAYLOAD_BUDGET = MAX_VEX_TOOL_BYTES - VEX_ENVELOPE_RESERVE_BYTES;
const OMISSION = "\n[Omitted; full record retained in Pace session.]\n";
export const vexPayloadBytes = (request: VexRequest) => Buffer.byteLength(JSON.stringify({ name: "vex_choose", arguments: request }));

export class VexPayloadBudgetError extends Error {
  constructor(readonly projection: VexProjection) {
    super("Vex payload exceeds its byte budget without dropping the current request, options, active criteria or constraints");
  }
}
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const available = Math.max(0, limit - OMISSION.length);
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + OMISSION + (available - head ? text.slice(-(available - head)) : "");
}
function compact(value: unknown, textLimit: number, itemLimit: number): unknown {
  if (typeof value === "string") return clip(value, textLimit);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const unique = [...new Map(value.map(item => [JSON.stringify(item), item])).values()];
    return unique.slice(-itemLimit).map(item => compact(item, textLimit, itemLimit));
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "activity" && typeof record.text === "string" && record.text.length > textLimit) {
    const firstLine = record.text.split("\n", 1)[0]!;
    const lastLine = record.text.slice(record.text.lastIndexOf("\n") + 1);
    return { ...record, text: clip(firstLine, textLimit / 2) + OMISSION + clip(lastLine, textLimit / 2) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    // Evidence identity and source remain resolvable even when text is omitted.
    ["id", "source", "attemptId", "paths", "observationIndex", "kind"].includes(key) ? item : compact(item, textLimit, itemLimit),
  ]));
}
function taskProjection(value: unknown, limit: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const task = value as Record<string, unknown>;
  const workflow = task.workflow as Record<string, unknown> | undefined;
  return { ...task,
    ...(typeof task.latestOutcome === "string" ? { latestOutcome: clip(task.latestOutcome, limit) } : {}),
    ...(workflow ? { workflow: { ...workflow,
      ...(typeof workflow.scoutHandoff === "string" ? { scoutHandoff: clip(workflow.scoutHandoff, limit) } : {}),
    } } : {}),
  };
}
function projectContext(context: Record<string, unknown>, limit: number, items: number) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => key !== "projection").map(([key, value]) => {
    if (["originalRequest", "latestRequest", "request", "stageObjective", "criteria", "constraints", "taskStateUpdates"].includes(key)) return [key, value];
    if (["activeTask", "goal"].includes(key)) return [key, taskProjection(value, limit)];
    if (key === "conversationState" && value && typeof value === "object") {
      const state = value as Record<string, unknown>;
      return [key, { ...state, ...(state.activeTask ? { activeTask: taskProjection(state.activeTask, limit) } : {}) }];
    }
    // Spend the larger share on recent evidence; history/handoffs go first.
    const history = ["recentConversation", "priorStageHandoff", "priorAttempts"].includes(key);
    return [key, compact(value, history ? Math.max(80, Math.floor(limit / 4)) : limit, history ? Math.min(items, 3) : items)];
  }));
}

/** The only budget policy, applied to the whole tool payload, never to saved data. */
export function projectVexRequest(request: VexRequest): { request: VexRequest; projection: VexProjection } {
  const originalBytes = vexPayloadBytes(request);
  const previous = request.context.projection as VexProjection | undefined;
  const projection: VexProjection = {
    version: 1, truncated: false, originalBytes, finalBytes: originalBytes,
    maxBytes: VEX_PAYLOAD_BUDGET, omittedClasses: [], requiredEvidenceOmitted: false,
  };
  if (originalBytes <= VEX_PAYLOAD_BUDGET) return { request, projection: previous?.version === 1 ? { ...previous, finalBytes: originalBytes } : projection };
  projection.truncated = true;
  for (const [limit, items] of [[1600, 16], [800, 8], [400, 4], [160, 2], [80, 1]] as const) {
    const context = projectContext(request.context, limit, items);
    projection.omittedClasses = Object.keys(request.context).filter(key => key !== "projection" && JSON.stringify(context[key]) !== JSON.stringify(request.context[key]));
    projection.requiredEvidenceOmitted = projection.omittedClasses.some(key => ["evidence", "priorAttempts", "attempt", "attempts", "sideAnswers", "recentConversation"].includes(key));
    const candidate: VexRequest = { ...request, context: { ...context, projection: { ...projection } } };
    const metadata = candidate.context.projection as VexProjection;
    // finalBytes includes its own serialized number.
    for (let pass = 0; pass < 4; pass++) metadata.finalBytes = vexPayloadBytes(candidate);
    projection.finalBytes = metadata.finalBytes;
    if (metadata.finalBytes <= VEX_PAYLOAD_BUDGET) return { request: candidate, projection: metadata };
  }
  // Pathological optional key/path counts may still exceed the budget. Keep
  // the protected task data and explicit references instead of clipping it.
  const protectedKeys = ["originalRequest", "latestRequest", "request", "stageObjective", "criteria", "constraints", "taskStateUpdates", "activeTask", "goal", "conversationState"];
  const minimal = Object.fromEntries(Object.entries(projectContext(request.context, 80, 1)).filter(([key]) => protectedKeys.includes(key)));
  const omitted = Object.keys(request.context).filter(key => key !== "projection" && JSON.stringify(minimal[key]) !== JSON.stringify(request.context[key]));
  const knownClasses = ["recentConversation", "priorStageHandoff", "priorAttempts", "attempts", "sideAnswers", "sources", "availableModels", "priceSnapshot", "attempt", "evidence", ...protectedKeys];
  projection.omittedClasses = [...new Set(omitted.map(key => knownClasses.includes(key) ? key : "otherContext"))];
  projection.requiredEvidenceOmitted = true;
  const candidate: VexRequest = { ...request, context: { ...minimal,
    omittedData: "Full records, including evidence IDs and sources, remain in this Pace session; omitted data cannot establish completion.", projection: { ...projection },
  } };
  const metadata = candidate.context.projection as VexProjection;
  for (let pass = 0; pass < 4; pass++) metadata.finalBytes = vexPayloadBytes(candidate);
  if (metadata.finalBytes <= VEX_PAYLOAD_BUDGET) return { request: candidate, projection: metadata };
  throw new VexPayloadBudgetError(metadata);
}

export const PROJECTION_CONSTRAINT = "Context may contain a projection.truncated flag and omission markers. Do not infer success or full coverage from omitted material. Choose unknown for a completion assessment when required evidence is omitted; technical execution status alone does not establish completion.";
