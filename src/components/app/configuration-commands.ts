import type { Dispatch, SetStateAction } from "react";
import { resolve } from "node:path";
import type { Config } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import { existingFolder, sameFolder } from "../../core/system/folders.js";
import { configuredSkills, defaultSkillFolder, enabledSkills, validSkillName, type Skill } from "../../core/system/skills.js";
import type { Line } from "../Transcript.js";

const folderArgument = (value: string) => value.trim().replace(/^(?:"(.*)"|'(.*)')$/, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? value);

type ConfigurationOptions = {
  config: Config;
  skills: Skill[];
  store: PaceStore;
  setConfig: Dispatch<SetStateAction<Config | undefined>>;
  setSkills: Dispatch<SetStateAction<Skill[]>>;
  changeAutoLaunch: (name?: string, toggle?: boolean) => Promise<void>;
  add: (role: Line["role"], text: string) => void;
};

export async function configureCommand(command: string, parts: string[], {
  config, skills, store, setConfig, setSkills, changeAutoLaunch, add,
}: ConfigurationOptions) {
  if (command === "/trust") {
    const action = parts[0];
    const input = folderArgument(parts.slice(1).join(" "));
    if (!action || action === "list") {
      add("info", config.trustedFolders?.length ? config.trustedFolders.join("\n") : "No trusted folders.");
      return;
    }
    if ((action !== "add" && action !== "remove") || !input) {
      add("error", "Use /trust add <folder>, /trust remove <folder>, or /trust list.");
      return;
    }
    try {
      const folder = action === "add" ? await existingFolder(input) : await existingFolder(input).catch(() => resolve(input));
      const folders = action === "add"
        ? [...(config.trustedFolders ?? []).filter(path => !sameFolder(path, folder)), folder]
        : (config.trustedFolders ?? []).filter(path => !sameFolder(path, folder));
      if (action === "remove" && folders.length === (config.trustedFolders ?? []).length) {
        add("error", `Folder is not trusted: ${input}`);
        return;
      }
      const updated = { ...config, trustedFolders: folders };
      await store.saveConfig(updated);
      setConfig(updated);
      add("info", `${action === "add" ? "Trusted" : "Removed"}: ${folder}`);
    } catch (error) { add("error", `Could not update trusted folders: ${String(error)}`); }
    return;
  }
  if (command === "/skills") {
    try {
      if (parts[0] === "auto") {
        if (parts.length !== 2) { add("error", "Use /skills auto <name|off>."); return; }
        if (parts[1] === "off") { await changeAutoLaunch(); return; }
        const found = skills.find(skill => skill.name.toLowerCase() === parts[1]!.toLowerCase());
        if (!found) { add("error", `Unknown skill: ${parts[1]}. Use /skills to refresh discovery.`); return; }
        if (!enabledSkills(skills, config).includes(found)) { add("error", `Skill is disabled: ${found.name}.`); return; }
        if (!validSkillName(found.name)) { add("error", `Skill name cannot be used for ON-LAUNCH: ${found.name}.`); return; }
        await changeAutoLaunch(found.name);
        return;
      }
      if (parts.join(" ") === "off") {
        const updated = { ...config, skillFolder: null };
        await store.saveConfig(updated);
        setConfig(updated);
        setSkills([]);
        add("info", "Skill folder disabled.");
        return;
      }
      if (parts[0] === "enable" || parts[0] === "disable") {
        const name = parts[1];
        const found = skills.find(skill => skill.name === name);
        if (!found || parts.length !== 2) { add("error", "Use /skills enable <name> or /skills disable <name> with a discovered skill."); return; }
        const disabledSkills = parts[0] === "disable"
          ? [...new Set([...(config.disabledSkills ?? []), name!])]
          : (config.disabledSkills ?? []).filter(item => item !== name);
        const updated = { ...config, disabledSkills };
        await store.saveConfig(updated);
        setConfig(updated);
        add("info", `${name} ${parts[0] === "disable" ? "disabled" : "enabled"}.`);
        return;
      }
      const folder = parts.join(" ") === "default" ? undefined
        : parts.length ? await existingFolder(folderArgument(parts.join(" "))) : config.skillFolder;
      const updated = parts.length ? { ...config, skillFolder: folder } : config;
      const found = await configuredSkills(updated);
      if (parts.length) { await store.saveConfig(updated); setConfig(updated); }
      setSkills(found);
      add("info", found.length
        ? found.map(skill => `/${skill.name} ${updated.disabledSkills?.includes(skill.name) ? "(disabled)" : "(enabled)"} · ${skill.description}`).join("\n")
        : `No skills found in ${folder === null ? "the disabled skill folder" : folder ?? defaultSkillFolder()}.`);
    } catch (error) { add("error", `Could not discover skills: ${String(error)}`); }
    return;
  }
}
