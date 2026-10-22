import { enabledSkills, updateAutoLaunchSkills, validSkillName } from "../../core/system/skills.js";
import type { Session } from "../../shared/types.js";
import { commandToken } from "../Composer.js";
import {
  commands,
  hiddenCommands,
  commandArguments,
  skillArguments,
  commandDescriptions,
} from "./commands.js";
import { store } from "./runtime.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { AppState } from "./useAppState.js";

type CommandCompletionOptions = {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  rememberSession: (session: Session) => void;
};

export function createCommandCompletion({ state, transcript, rememberSession }: CommandCompletionOptions) {
  const {
    config,
    skills,
    shellMode,
    draft,
    selection,
    session,
    latestConfig,
    setConfig,
    setSession,
  } = state;
  const { add } = transcript;

  const skillCommands = (config ? enabledSkills(skills, config) : [])
    .flatMap(skill => [`/${skill.name}`, `@${skill.name}`])
    .filter(command => !commands.includes(command));
  const selectableAutoSkills = (config ? enabledSkills(skills, config) : []).filter(skill => validSkillName(skill.name));
  const registeredCommands = [...commands, ...hiddenCommands, ...skillCommands];
  const commandDescriptionsWithSkills = Object.fromEntries([
    ...Object.entries(commandDescriptions),
    ...skills.map(skill => [`/skills auto ${skill.name}`, skill.description]),
    ["/skills auto off", "Clear ON-LAUNCH skills for this and future conversations"],
    ...(config ? enabledSkills(skills, config).flatMap(skill => [
      [`/${skill.name}`, skill.description],
      [`@${skill.name}`, skill.description],
    ] as [string, string][]) : []),
  ]);
  const commandArgsWithSkills: Record<string, string> = {
    ...commandArguments,
    ...(config ? Object.fromEntries(
      enabledSkills(skills, config).flatMap(skill => [
        [`/${skill.name}`, skillArguments(skill.name)],
        [`@${skill.name}`, skillArguments(skill.name)],
      ]),
    ) : {}),
  };
  const autoSkillInput = !shellMode && /^\/skills auto(?:\s+([a-z0-9_-]*))?$/i.exec(draft);
  const token = autoSkillInput ? { start: 0, prefix: draft } : shellMode ? undefined : commandToken(draft);
  const matches = autoSkillInput
    ? [...selectableAutoSkills.map(skill => `/skills auto ${skill.name}`), "/skills auto off"].filter(command => command.startsWith(draft.endsWith(" ") ? draft : `${draft} `) || command === draft)
    : token ? [...commands, ...skillCommands].filter(command => command.startsWith(token.prefix)) : [];
  const selectedAutoSkill = () => {
    const match = matches[selection];
    if (!match || (!skillCommands.includes(match) && !match.startsWith("/skills auto "))) return undefined;
    const name = match.startsWith("/skills auto ") ? match.slice("/skills auto ".length) : match.replace(/^[/@]/, "");
    return selectableAutoSkills.find(skill => skill.name === name);
  };
  const changeAutoLaunch = async (name?: string, toggle = false) => {
    if (!session || !config) return;
    const updatedSession = { ...session };
    const selected = updateAutoLaunchSkills(updatedSession, name, toggle);
    const updatedConfig = { ...latestConfig.current ?? config, autoLaunchSkills: [...selected] };
    try {
      await store.saveConfig(updatedConfig);
      latestConfig.current = updatedConfig;
      setConfig(updatedConfig);
      await store.saveChanges(updatedSession);
      rememberSession(updatedSession);
      setSession(updatedSession);
      add("info", selected.length ? `ON-LAUNCH skills: ${selected.join(", ")}.` : "ON-LAUNCH skills cleared.");
    } catch (error) { add("error", `Could not save ON-LAUNCH skills: ${String(error)}`); }
  };

  return {
    skillCommands,
    registeredCommands,
    commandDescriptionsWithSkills,
    commandArgsWithSkills,
    token,
    matches,
    selectedAutoSkill,
    changeAutoLaunch,
  };
}
