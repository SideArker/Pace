import type { Config, Effort, ModelOption, Route } from "./types.js";
export const EFFORTS: readonly Effort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "persistent",
];
export const DEFAULT_CONFIG: Config = {
  models: [
    {
      model: "gpt-6-luna",
      efforts: ["low", "medium", "high"],
      defaultEffort: "low",
    },
    {
      model: "gpt-6-sol",
      efforts: ["medium", "high", "xhigh", "ultra"],
      defaultEffort: "high",
    },
    {
      model: "gpt-6-astra",
      efforts: ["high", "xhigh", "ultra"],
      defaultEffort: "high",
    },
  ],
  defaultRoute: { model: "gpt-6-sol", effort: "high" },
  routingMode: "auto",
  approvalMode: "request-approval",
};
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validRoute(route: Route, models: ModelOption[]): boolean {
  if (!route.model) return !route.effort;
  const option = models.find((item) => item.model === route.model);
  return !!option && (!route.effort || option.efforts.includes(route.effort));
}
export function withModels(config: Config, models: ModelOption[]): Config {
  const defaultModel = models.find(
    (model) => model.model === config.defaultRoute.model,
  );
  const defaultRoute =
    defaultModel &&
    config.defaultRoute.effort &&
    !defaultModel.efforts.includes(config.defaultRoute.effort)
      ? {
          model: defaultModel.model,
          effort: defaultModel.defaultEffort ?? defaultModel.efforts[0],
        }
      : config.defaultRoute;
  return parseConfig({ ...config, models, defaultRoute });
}
export function parseConfig(value: unknown): Config {
  if (!isRecord(value) || !Array.isArray(value.models))
    throw new Error("config.json must contain a models array");
  const models: ModelOption[] = value.models.map((item: unknown) => {
    if (
      isRecord(item) &&
      Array.isArray(item.efforts) &&
      item.efforts.includes("max")
    )
      throw new Error(
        '"max" reasoning effort is not supported by Pace; remove it from config.json',
      );
    if (
      !isRecord(item) ||
      typeof item.model !== "string" ||
      !/^[a-zA-Z0-9._-]+$/.test(item.model) ||
      !Array.isArray(item.efforts) ||
      !item.efforts.length ||
      !item.efforts.every((effort: unknown) =>
        EFFORTS.includes(effort as Effort),
      )
    ) {
      throw new Error(
        "Each model needs a valid ID and a nonempty list of SDK-supported efforts",
      );
    }
    if (
      item.defaultEffort !== undefined &&
      !item.efforts.includes(item.defaultEffort)
    )
      throw new Error(`Invalid default effort for ${item.model}`);
    // Model IDs and supported reasoning efforts can vary by account and SDK
    // release. Keep the SDK's effort enum as the boundary; the provider can
    // report model-specific incompatibilities when a route is used.
    if (item.enabled !== undefined && typeof item.enabled !== "boolean")
      throw new Error(`Invalid enabled flag for ${item.model}`);
    return {
      model: item.model,
      efforts: [...new Set(item.efforts)] as Effort[],
      defaultEffort: item.defaultEffort as Effort | undefined,
      enabled: item.enabled as boolean | undefined,
    };
  });
  if (new Set(models.map((item) => item.model)).size !== models.length)
    throw new Error("Duplicate model IDs");
  const rawRoute = value.defaultRoute ?? {};
  if (!isRecord(rawRoute)) throw new Error("defaultRoute must be an object");
  if (rawRoute.effort === "max")
    throw new Error(
      '"max" reasoning effort is not supported by Pace; remove it from config.json',
    );
  const defaultRoute: Route = {
    model: typeof rawRoute.model === "string" ? rawRoute.model : undefined,
    effort:
      typeof rawRoute.effort === "string"
        ? (rawRoute.effort as Effort)
        : undefined,
  };
  if (!validRoute(defaultRoute, models))
    throw new Error("defaultRoute is not in configured model options");
  if (value.routingMode !== "auto" && value.routingMode !== "manual")
    throw new Error("routingMode must be auto or manual");
  if (value.approvalMode !== undefined && !["full-access", "request-approval", "limited"].includes(value.approvalMode as string))
    throw new Error("approvalMode must be full-access, request-approval, or limited");
  if (
    value.trustedFolders !== undefined &&
    (!Array.isArray(value.trustedFolders) ||
      !value.trustedFolders.every(
        (path: unknown) => typeof path === "string" && path.length > 0,
      ))
  )
    throw new Error("trustedFolders must be a list of folder paths");
  if (
    value.skillFolder !== undefined &&
    (value.skillFolder !== null && (typeof value.skillFolder !== "string" || !value.skillFolder.length))
  )
    throw new Error("skillFolder must be a folder path or null");
  if (value.disabledSkills !== undefined &&
      (!Array.isArray(value.disabledSkills) || !value.disabledSkills.every((name: unknown) =>
        typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name))))
    throw new Error("disabledSkills must be a list of skill names");
  if (value.autoLaunchSkills !== undefined &&
      (!Array.isArray(value.autoLaunchSkills) || value.autoLaunchSkills.length > 32 ||
        !value.autoLaunchSkills.every((name: unknown) =>
          typeof name === "string" && /^[a-z0-9][a-z0-9_-]*$/i.test(name))))
    throw new Error("autoLaunchSkills must be a list of up to 32 skill names");
  return {
    models,
    defaultRoute,
    routingMode: value.routingMode,
    approvalMode: (value.approvalMode ?? "request-approval") as Config["approvalMode"],
    trustedFolders: value.trustedFolders as string[] | undefined,
    skillFolder: value.skillFolder as string | null | undefined,
    disabledSkills: value.disabledSkills as string[] | undefined,
    autoLaunchSkills: value.autoLaunchSkills as string[] | undefined,
  };
}
