import type { ModelOption, Route, Session } from "../shared/types.js";
import type { Progress, UserAnswers } from "../integrations/codex-types.js";

type WorkflowClarification = { choice?: string; clarification?: string; cancelled?: boolean };

export function requestWorkflowClarification(
  session: Session,
  enabled: ModelOption[],
  onProgress: (progress: Progress) => void,
  signal?: AbortSignal,
): Promise<WorkflowClarification> | undefined {
  const isInteractive = (onProgress as { interactive?: boolean }).interactive === true;
  if (!isInteractive) return;

  onProgress({ kind: "status", text: "Waiting for clarification..." });
  const formatRoute = (r?: Route) => {
    if (!r?.model) return "Codex default";
    const name = r.model.replace(
      /^gpt-(\d+)-(.+)$/,
      (_match, version: string, n: string) =>
        `GPT-${version} ${n[0]!.toUpperCase()}${n.slice(1)}`,
    );
    return `${name}${r.effort ? ` ${r.effort[0]!.toUpperCase()}${r.effort.slice(1)}` : ""}`;
  };
  const defaultRouteDesc = formatRoute(session.route);
  const options = [
    {
      label: "Run as single agent",
      description: "Direct answer or action using the standard route",
    },
    ...(enabled.some(m => m.efforts.length > 0)
      ? [
          {
            label: "Scout codebase first",
            description: "Read-only exploration to find files and report context",
          },
        ]
      : []),
    { label: "Plan only", description: "Save a plan in conversation artifacts; use /execute later" },
  ];
  if (session.route?.model) {
    options.push({
      label: `Use manual route (${defaultRouteDesc})`,
      description: `Bypass workflow and route stages directly to ${defaultRouteDesc}`,
    });
  }

  return new Promise<WorkflowClarification>((resolve) => {
    const questionId = `clarify-${Date.now()}`;
    const abortListener = () => resolve({ cancelled: true });
    signal?.addEventListener("abort", abortListener, { once: true });

    onProgress({
      kind: "question",
      id: questionId,
      questions: [
        {
          id: "workflow",
          header: "Clarification Needed",
          question: "Vex is unsure about the deliverable for this request. How would you like to proceed?",
          options,
          isOther: true,
          isSecret: false,
        },
      ],
      respond: (answers: UserAnswers) => {
        signal?.removeEventListener("abort", abortListener);
        const val = answers["workflow"]?.answers[0]?.trim();
        if (!val) {
          resolve({ cancelled: true });
          return;
        }
        if (val === "Run as single agent") {
          resolve({ choice: "single" });
        } else if (val === "Scout codebase first") {
          resolve({ choice: "scout" });
        } else if (val === "Plan only") {
          resolve({ choice: "plan" });
        } else if (val.startsWith("Use manual route")) {
          resolve({ choice: "manual" });
        } else {
          resolve({ clarification: val });
        }
      },
    });
  });
}
