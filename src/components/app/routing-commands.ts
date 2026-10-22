import type { Config, Session, Route } from "../../shared/types.js";
import { workflowStages, type useModelRouting } from "./useModelRouting.js";
import type { Line } from "../Transcript.js";

type RoutingOptions = Pick<ReturnType<typeof useModelRouting>,
  "enabledModels" | "availableWorkflows" | "saveRouting" | "saveWorkflow" |
  "setWorkflowOnly" | "setManualWizard" | "setManualMenu" | "setMenuIndex"
> & {
  config: Config;
  session: Session;
  add: (role: Line["role"], text: string) => void;
};

export async function configureRouting(command: string, parts: string[], {
  config, session, enabledModels, availableWorkflows, saveRouting, saveWorkflow, setWorkflowOnly, setManualWizard, setManualMenu, setMenuIndex, add
}: RoutingOptions) {
  if (command === "/auto") {
    // Auto selection uses the enabled model list in the orchestrator.
    try {
      await saveRouting(session, "auto");
      add("info", "Auto routing enabled for the next turn.");
    } catch (error) {
      add("error", `Could not save routing mode: ${String(error)}`);
    }
    return;
  }
  if (command === "/workflow") {
    if (parts.length > 1) { add("error", "Type /workflow [name|auto]."); return; }
    if (!enabledModels.length) { add("error", "No models enabled. Open /models and enable one first."); return; }
    if (!parts.length) {
      setWorkflowOnly(true);
      setManualWizard({ step: "workflow", stageIndex: 0, routes: {} });
      setManualMenu(true);
      setMenuIndex(0);
      return;
    }
    const requested = parts[0]!.toLowerCase().replaceAll("-", "_");
    if (requested === "auto" || requested === "vex") {
      try {
        await saveRouting(session, "auto");
        add("info", "Workflow choice delegated to Vex.");
      } catch (error) { add("error", `Could not save routing mode: ${String(error)}`); }
      return;
    }
    const choice = availableWorkflows.find(item => item.shape === requested);
    if (!choice) {
      add("error", `Unknown or unavailable workflow '${parts[0]}'. Available: ${availableWorkflows.map(item => item.shape).join(", ")}.`);
      return;
    }
    await saveWorkflow(choice.shape, Object.fromEntries(workflowStages(choice.shape).map(stage => [stage, "vex"])));
    return;
  }
  if (command === "/manual") {
    const enabled = (config?.models ?? []).filter((m) => m.enabled !== false);
    if (!enabled.length) {
      add("error", "No models enabled. Open /models and enable one first.");
      return;
    }
    if (!parts.length) {
      setWorkflowOnly(false);
      setManualWizard({ step: "workflow", stageIndex: 0, routes: {} });
      setManualMenu(true);
      setMenuIndex(0);
      return;
    }
    if (parts[0] === "off" || parts[0] === "auto") {
      try {
        await saveRouting(session, "auto");
        add("info", "Auto routing enabled for the next turn.");
      } catch (error) {
        add("error", `Could not save routing mode: ${String(error)}`);
      }
      return;
    }
    const query = parts[0]!.toLowerCase();
    const matched = enabled.find((m) => {
      const lower = m.model.toLowerCase();
      return lower === query || lower.endsWith("-" + query) || lower.includes(query);
    });
    if (!matched) {
      add(
        "error",
        `Unknown model '${parts[0]}'. Enabled models: ${enabled.map((m) => m.model.replace(/^gpt-\d+-/, "")).join(", ")}.`,
      );
      return;
    }
    const effortArg = parts[1]?.toLowerCase();
    const effort = effortArg
      ? (matched.efforts.find((e) => e.toLowerCase() === effortArg) as Route["effort"])
      : (matched.defaultEffort ?? matched.efforts[0]);
    if (!effort || !matched.efforts.includes(effort)) {
      add(
        "error",
        `Invalid effort '${parts[1]}' for ${matched.model}. Available: ${matched.efforts.join(", ")}.`,
      );
      return;
    }
    try {
      await saveRouting(session, { model: matched.model, effort });
      const name = matched.model.replace(
        /^gpt-(\d+)-(.+)$/,
        (_match: string, ver: string, n: string) =>
          `GPT-${ver} ${n[0]!.toUpperCase()}${n.slice(1)}`,
      );
      add("info", `Manual routing enabled: ${name} ${effort[0]!.toUpperCase()}${effort.slice(1)}.`);
    } catch (error) {
      add("error", `Could not save manual route: ${String(error)}`);
    }
    return;
  }
}
