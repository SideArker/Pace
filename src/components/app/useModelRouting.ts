import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Config, ManualWorkflow, Route, Session } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import { saveRoutingSelection } from "../../core/operations.js";
import { EFFORTS, withModels } from "../../shared/config.js";
import { currentVersionManifest, modelRates, refreshVersionManifest } from "../../core/routing/pricing.js";
import { readAvailableModels, type AvailableModel } from "../../integrations/models.js";
import type { Line } from "../Transcript.js";
import type { TurnJob } from "../turn-runner.js";

export const workflowChoices = [
  { shape: "single", label: "Single agent" },
  { shape: "scout", label: "Scout → Completion" },
  { shape: "plan", label: "Plan only" },
  { shape: "scout_plan", label: "Scout → Plan" },
] as const;
export type WorkflowShape = ManualWorkflow["shape"];
export type WorkflowStage = keyof ManualWorkflow["routes"];
export const workflowStages = (shape: WorkflowShape): WorkflowStage[] =>
  shape === "scout" || shape === "scout_plan" ? ["scout", "final"] : ["final"];

export type ManualWizard = {
  step: "workflow" | "model" | "effort";
  shape?: WorkflowShape;
  stageIndex: number;
  model?: string;
  routes: ManualWorkflow["routes"];
};

export type ModelRoutingOptions = {
  config: Config | undefined;
  setConfig: Dispatch<SetStateAction<Config | undefined>>;
  session: Session | undefined;
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  jobs: RefObject<Map<string, TurnJob>>;
  activeSessionId: RefObject<string | undefined>;
  store: PaceStore;
  rememberSession: (session: Session) => void;
  add: (role: Line["role"], text: string) => void;
};

export function useModelRouting({
  config, setConfig, session, setSession, jobs, activeSessionId, store, rememberSession, add,
}: ModelRoutingOptions) {
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [knownModels, setKnownModels] = useState(() => Object.keys(currentVersionManifest().pricing.rates));
  const [modelCatalogStatus, setModelCatalogStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const modelCatalogRequest = useRef(0);
  const [modelMenu, setModelMenu] = useState<
    "models" | "efforts" | undefined
  >();
  const [manualMenu, setManualMenu] = useState(false);
  const [workflowOnly, setWorkflowOnly] = useState(false);
  const [manualWizard, setManualWizard] = useState<ManualWizard>({ step: "workflow", stageIndex: 0, routes: {} });
  const [menuModel, setMenuModel] = useState("");
  const [menuIndex, setMenuIndex] = useState(0);

  const menuModels = [
    ...new Set([
      ...(config?.models.map((model) => model.model) ?? []),
      ...availableModels.map((model) => model.model),
      ...knownModels,
    ]),
  ];
  const menuEfforts = availableModels.find((model) => model.model === menuModel)?.efforts ?? currentVersionManifest().models?.[menuModel]?.efforts ?? EFFORTS;
  const refreshModelCatalog = (forceManifest = false) => {
    const request = ++modelCatalogRequest.current;
    setModelCatalogStatus("loading");
    void refreshVersionManifest(fetch, undefined, forceManifest).then(manifest => {
      if (request === modelCatalogRequest.current) setKnownModels(Object.keys(manifest.pricing.rates));
    });
    void readAvailableModels()
      .then((models) => {
        if (request !== modelCatalogRequest.current) return;
        setAvailableModels(models);
        setModelCatalogStatus("ready");
      })
      .catch(() => {
        if (request === modelCatalogRequest.current) setModelCatalogStatus("unavailable");
      });
  };
  useEffect(() => {
    refreshModelCatalog();
    return () => { modelCatalogRequest.current++; };
  }, []);
  useEffect(() => {
    let active = true;
    void refreshVersionManifest().then(manifest => {
      if (!active) return;
      setKnownModels(Object.keys(manifest.pricing.rates));
    });
    return () => { active = false; };
  }, []);
  const saveModels = async (models: Config["models"], confirmation: string) => {
    if (!config) return;
    try {
      const updated = withModels(config, models);
      await store.saveConfig(updated);
      setConfig(updated);
      add("info", confirmation);
    } catch (error) {
      add("error", `Could not save models: ${String(error)}`);
    }
  };
  const toggleModel = (name: string) => {
    if (!config) return;
    const found = config.models.find((model) => model.model === name);
    const discovered = availableModels.find((model) => model.model === name) ?? currentVersionManifest().models?.[name];
    const enabled = found?.enabled === false || !found;
    const models = found
      ? config.models.map((model) =>
          model.model === name ? { ...model, enabled } : model,
        )
      : [
          ...config.models,
          {
            model: name,
            efforts: [discovered?.defaultEffort ?? "medium"],
            defaultEffort: discovered?.defaultEffort ?? "medium",
            enabled: true,
          },
        ];
    void saveModels(models, `${name} ${enabled ? "enabled" : "disabled"}.`);
  };
  const toggleEffort = (effort: (typeof EFFORTS)[number]) => {
    if (!config) return;
    const found = config.models.find((model) => model.model === menuModel);
    const present = found?.efforts.includes(effort) ?? false;
    if (present && found?.efforts.length === 1) {
      add(
        "error",
        "Keep at least one reasoning level; disable the model from the model list.",
      );
      return;
    }
    const models = found
      ? config.models.map((model) =>
          model.model === menuModel
            ? {
                ...model,
                efforts: present
                  ? model.efforts.filter((value) => value !== effort)
                  : [...model.efforts, effort],
                defaultEffort:
                  model.defaultEffort === effort && present
                    ? model.efforts.find((value) => value !== effort)
                    : model.defaultEffort,
              }
            : model,
        )
      : [
          ...config.models,
          {
            model: menuModel,
            efforts: [effort],
            defaultEffort: effort,
            enabled: true,
          },
        ];
    void saveModels(
      models,
      `${menuModel}: ${effort} ${present ? "disabled" : "enabled"}.`,
    );
  };
  const saveRouting = async (target: Session, selection: Route | ManualWorkflow | "auto") => {
    if (jobs.current.has(target.id)) throw new Error("Wait for the current turn to finish before changing routing.");
    const updated = await saveRoutingSelection(store, target, selection, () => activeSessionId.current === target.id);
    rememberSession(updated);
    if (activeSessionId.current === updated.id) setSession(updated);
    return updated;
  };
  const selectManualRoute = async (target: Route | (typeof EFFORTS)[number]) => {
    if (typeof target === "string") {
      const effort = target;
      if (!config || !session || !menuModel) return;
      if (jobs.current.has(session.id)) {
        add("error", "Wait for the current turn to finish before changing its manual route.");
        return;
      }
      try {
        const existing = config.models.find((model) => model.model === menuModel);
        const models = existing
          ? config.models.map((model) => model.model === menuModel
            ? { ...model, enabled: true, efforts: model.efforts.includes(effort) ? model.efforts : [...model.efforts, effort] }
            : model)
          : [...config.models, { model: menuModel, efforts: [effort], defaultEffort: effort, enabled: true }];
        const updatedConfig = withModels(config, models);
        await store.saveConfig(updatedConfig);
        await saveRouting(session, { model: menuModel, effort });
        setConfig(updatedConfig);
        setModelMenu(undefined);
        add("info", `Manual route: ${menuModel} ${effort}.${modelRates(menuModel) ? " Use /auto to return to Vex routing." : " This model has no verified auto-routing price; disable it before using /auto."}`);
      } catch (error) {
        add("error", `Could not select model: ${String(error)}`);
      }
      return;
    }
    const route = target;
    setManualMenu(false);
    if (!session) return;
    try {
      await saveRouting(session, route);
      const name =
        route.model?.replace(
          /^gpt-(\d+)-(.+)$/,
          (_match: string, ver: string, n: string) =>
            `GPT-${ver} ${n[0]!.toUpperCase()}${n.slice(1)}`,
        ) ?? route.model ?? "";
      const effort = route.effort
        ? ` ${route.effort[0]!.toUpperCase()}${route.effort.slice(1)}`
        : "";
      add("info", `Manual routing enabled: ${name}${effort}.`);
    } catch (error) {
      add("error", `Could not save manual route: ${String(error)}`);
    }
  };
  const enabledModels = (config?.models ?? []).filter((m) => m.enabled !== false);
  const manualRoutes: Route[] = enabledModels.flatMap((m) =>
    m.efforts.map((e) => ({ model: m.model, effort: e })),
  );
  const availableWorkflows = workflowChoices.filter(choice =>
    !["scout", "scout_plan"].includes(choice.shape) || enabledModels.some(model => model.efforts.length > 0));
  const manualStage = manualWizard.shape ? workflowStages(manualWizard.shape)[manualWizard.stageIndex] : undefined;
  const manualOptions = manualWizard.step === "workflow"
    ? ["Delegate choice to Vex", ...availableWorkflows.map(choice => choice.label)]
    : manualWizard.step === "model"
      ? ["Delegate choice to Vex", ...enabledModels.filter(m => m.efforts.length > 0).map(m => m.model)]
      : ["Delegate choice to Vex", ...(enabledModels.find(m => m.model === manualWizard.model)?.efforts ?? [])];
  const saveWorkflow = async (shape: WorkflowShape, routes: ManualWorkflow["routes"]) => {
    if (!session) return;
    try {
      await saveRouting(session, { shape, routes });
      setManualMenu(false);
      add("info", `Manual ${shape} workflow saved. Send the task as your next message.`);
    } catch (error) { add("error", `Could not save workflow: ${String(error)}`); }
  };
  const finishManualStage = async (selection: Route | "vex") => {
    if (!session || !manualWizard.shape || !manualStage) return;
    const routes = { ...manualWizard.routes, [manualStage]: selection };
    const nextIndex = manualWizard.stageIndex + 1;
    if (nextIndex < workflowStages(manualWizard.shape).length) {
      setManualWizard({ ...manualWizard, step: "model", stageIndex: nextIndex, model: undefined, routes });
      setMenuIndex(0);
      return;
    }
    await saveWorkflow(manualWizard.shape, routes);
  };
  const selectManualOption = (index: number) => {
    if (manualWizard.step === "workflow") {
      if (index === 0) {
        if (!session) return;
        void saveRouting(session, "auto").then(() => {
          setManualMenu(false);
          add("info", "Workflow choice delegated to Vex.");
        }).catch(error => add("error", `Could not save routing mode: ${String(error)}`));
        return;
      }
      const shape = availableWorkflows[index - 1]?.shape;
      if (!shape) return;
      if (workflowOnly) {
        void saveWorkflow(shape, Object.fromEntries(workflowStages(shape).map(stage => [stage, "vex"])));
        return;
      }
      setManualWizard({ step: "model", shape, stageIndex: 0, routes: {} });
    } else if (manualWizard.step === "model") {
      if (index === 0) { void finishManualStage("vex"); return; }
      const model = manualOptions[index];
      if (!model) return;
      setManualWizard({ ...manualWizard, step: "effort", model });
    } else {
      if (!manualWizard.model) return;
      const effort = manualOptions[index];
      void finishManualStage(index === 0 ? { model: manualWizard.model } : { model: manualWizard.model, effort: effort as Route["effort"] });
    }
    setMenuIndex(0);
  };

  return {
    availableModels, setKnownModels, modelCatalogStatus,
    modelMenu, setModelMenu, manualMenu, setManualMenu,
    setWorkflowOnly, manualWizard, setManualWizard, menuModel, setMenuModel, menuIndex, setMenuIndex,
    menuModels, menuEfforts, refreshModelCatalog, toggleModel, toggleEffort, saveRouting, selectManualRoute,
    enabledModels, manualRoutes, availableWorkflows, manualStage, manualOptions, saveWorkflow, selectManualOption,
  };
}
