import type { ApprovalMode } from "../../shared/types.js";
import { retryableTurn } from "../../core/sessions.js";
import { adoptedSidePrompt, operation } from "../../core/operations.js";
import { enabledSkills, skillCommand, skillOption, skillRequest } from "../../core/system/skills.js";
import { oneOffShellCommand } from "../shell-runner.js";
import { commands, isRegisteredCommand, normalizeNewCommand } from "./commands.js";
import { infoCommands, showCommandInfo } from "./info-commands.js";
import { configureRouting } from "./routing-commands.js";
import { configureCommand } from "./configuration-commands.js";
import { store, installedVersion } from "./runtime.js";
import type { useModelRouting } from "./useModelRouting.js";
import type { createCommandCompletion } from "./command-completion.js";
import type { useSessionActions } from "./useSessionActions.js";
import type { createPlanningActions } from "./planning-actions.js";
import type { createAuxiliaryActions } from "./auxiliary-actions.js";
import type { createExecutionActions } from "./execution-actions.js";
import type { AppState } from "./useAppState.js";
import type { createTranscriptActions } from "./transcript-actions.js";
import type { usePromptQueue } from "./usePromptQueue.js";

export function createSubmit({ state, transcript, queue, routing, completion, sessions, planning, auxiliary, execution, exit }: {
  state: AppState;
  transcript: ReturnType<typeof createTranscriptActions>;
  queue: ReturnType<typeof usePromptQueue>;
  routing: ReturnType<typeof useModelRouting>;
  completion: ReturnType<typeof createCommandCompletion>;
  sessions: ReturnType<typeof useSessionActions>;
  planning: ReturnType<typeof createPlanningActions>;
  auxiliary: ReturnType<typeof createAuxiliaryActions>;
  execution: ReturnType<typeof createExecutionActions>;
  exit: () => void;
}) {
  const { historyBusy, switchingSession, session, config, setDraft, shellMode, setHistory,
    setShellMode, jobs, setQueueVersion, skills, setSelection, runTurnRef, setMcpOpen,
    approvalMenu, setApprovalMenu, setConfig, latestConfig, setDiffOpen, setConvoMenu, vexState } = state;
  const { add } = transcript;
  const { promptQueue } = queue;
  const { setKnownModels, enabledModels, availableWorkflows, saveRouting, saveWorkflow,
    setWorkflowOnly, setManualWizard, setManualMenu, setMenuIndex, setModelMenu, refreshModelCatalog } = routing;
  const { registeredCommands, changeAutoLaunch } = completion;
  const { startNewConversation, changeHistory, cancelRetry } = sessions;
  const { continueVerifier, startOrTogglePlanning, handleExecutePlan, handleVerifyPlan } = planning;
  const { askBtw, handleRemote } = auxiliary;
  const { runTurn, shell, compact } = execution;
  const { setSkills } = state;
  const submit = async (raw: string) => {
    if (historyBusy.current) { add("info", "Wait for file history to finish saving."); return; }
    if (switchingSession.current) return;
    if (!session || !config) return;
    const directVerifier = /^v\s+([\s\S]+)$/i.exec(raw.trim());
    if (directVerifier && session.verifierThreadId) {
      continueVerifier(directVerifier[1]!);
      setDraft("");
      return;
    }
    const text = shellMode ? raw.trim() : normalizeNewCommand(raw);
    if (!text) return;
    setHistory(old => [...old.slice(-99), raw]);
    if (text === "!") {
      add("info", shellMode ? "$ !" : "> !");
      setShellMode((value) => !value);
      setDraft("");
      add(
        "info",
        shellMode
          ? "Bash mode off."
          : "Bash mode on. Type ! to return to Pace.",
      );
      return;
    }
    const shellCommand = oneOffShellCommand(text);
    if (shellCommand !== undefined) {
      setDraft("");
      shell(shellCommand);
      return;
    }
    if (shellMode) {
      setDraft("");
      shell(text);
      return;
    }
    if (text === "/btw" || text.startsWith("/btw ")) {
      setDraft("");
      void askBtw(text.slice(4).trim());
      return;
    }
    if (text === "/remote" || text.startsWith("/remote ")) {
      await handleRemote(text);
      return;
    }
    const commandOperation = operation(text, session.id, session.activeTask?.id);
    const queuedCommand = /^\/(verify|execute|run-plan|adopt)(?:\s+([\s\S]*))?$/.exec(text);
    if (queuedCommand) {
      commandOperation.intent = queuedCommand[1] === "verify" ? "verify_plan" : queuedCommand[1] === "adopt" ? "adopt_side" : "execute_plan";
      commandOperation.role = commandOperation.intent === "verify_plan" ? "verifier" : "main";
      if (commandOperation.intent === "adopt_side") {
        commandOperation.sourceSideId = queuedCommand[2]?.trim();
        try { adoptedSidePrompt(session, commandOperation.sourceSideId ?? ""); }
        catch (error) { add("error", String(error)); return; }
      }
    }
    if ((jobs.current.has(session.id) || !!session.deferredTurn) && queuedCommand) {
      const position = promptQueue.current.add(session.id, commandOperation);
      setQueueVersion(value => value + 1); setDraft("");
      add("info", `Queued operation ${position}: ${text}`); return;
    }
    if (jobs.current.has(session.id) && !/^\/(?:new|clear|help|exit|stats|compact|context|route|artifacts|models|mcp|trust|skills|approval|tasks|remote)(?:\s|$)/.test(text)) {
      if (isRegisteredCommand(text, registeredCommands) && !skillCommand(text, enabledSkills(skills, config))) {
        add("info", "This conversation is working. Use /new or the conversation picker to switch conversations.");
        return;
      }
      const position = promptQueue.current.add(session.id, commandOperation);
      setQueueVersion(value => value + 1);
      setDraft("");
      add("info", `Queued prompt ${position}: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
      return;
    }
    setDraft("");
    setSelection(0);
    if (text.startsWith("/") && isRegisteredCommand(text, registeredCommands)) {
      const [command, ...parts] = text.split(/\s+/);
      if (command === "/clear" || command === "/new") {
        if (parts.length) {
          add("error", `Type ${command} without arguments.`);
          return;
        }
        await startNewConversation();
        return;
      }
      if (command === "/plan") {
        const promptText = parts.join(" ").trim();
        await startOrTogglePlanning(promptText || undefined);
        return;
      }
      if (command === "/execute" || command === "/run-plan") {
        const extraPrompt = parts.join(" ").trim();
        await handleExecutePlan(extraPrompt || undefined);
        return;
      }
      if (command === "/adopt") {
        void runTurnRef.current?.(text, session, config, "adopt_side", undefined, false, commandOperation);
        return;
      }
      if (command === "/verify") {
        const arg = text.replace(/^\/verify\s*/, "").trim();
        await handleVerifyPlan(arg || undefined);
        return;
      }
      if (command === "/exit") {
        exit();
        return;
      }
      if (infoCommands.includes(command)) {
        await showCommandInfo(command, parts, { session, config, store, installedVersion, setMcpOpen, setKnownModels, add });
        return;
      }
      if (command === "/auto" || command === "/workflow" || command === "/manual") {
        await configureRouting(command, parts, {
          config, session, enabledModels, availableWorkflows, saveRouting, saveWorkflow, setWorkflowOnly, setManualWizard, setManualMenu, setMenuIndex, add
        });
        return;
      }
      if (command === "/approval") {
        const mode = parts[0] as ApprovalMode | undefined;
        if (!mode) {
          setApprovalMenu(true);
          setMenuIndex(["request-approval", "limited", "full-access"].indexOf(config.approvalMode ?? "request-approval"));
          return;
        }
        if (parts.length !== 1 || !["full-access", "request-approval", "limited"].includes(mode)) { add("error", "Use /approval full-access, /approval request-approval, or /approval limited."); return; }
        try {
          const updated = { ...config, approvalMode: mode };
          await store.saveConfig(updated);
          setConfig(updated);
          latestConfig.current = updated;
          add("info", `Approval mode: ${mode}. Active turns keep their starting mode.`);
        } catch (error) { add("error", `Could not save approval mode: ${String(error)}`); }
        return;
      }
      if (command === "/compact") {
        if (parts.length) { add("error", "Type /compact without arguments."); return; }
        if (!session.threadId) { add("error", "This conversation has no Codex thread to compact."); return; }
        if (jobs.current.has(session.id)) { add("error", "Wait for this conversation to finish before compacting."); return; }
        compact();
        return;
      }
      if (command === "/models") {
        if (parts.length) {
          add("error", "Type /models to open the menu.");
          return;
        }
        setModelMenu("models");
        setMenuIndex(0);
        refreshModelCatalog(true);
        return;
      }
      if (command === "/trust" || command === "/skills") {
        await configureCommand(command, parts, { config, skills, store, setConfig, setSkills, changeAutoLaunch, add });
        return;
      }
      if (command === "/diff") {
        if (parts.length) { add("error", "Type /diff without arguments."); return; }
        setDiffOpen(true);
        return;
      }
      if (command === "/undo" || command === "/redo") {
        if (parts.length) { add("error", `Type ${command} without arguments.`); return; }
        await changeHistory(command === "/undo" ? "undo" : "redo");
        return;
      }
      if (command === "/retry") {
        if (parts.length) { add("error", "Type /retry without arguments."); return; }
        const pending = session.deferredTurn;
        const failed = pending ? undefined : retryableTurn(session);
        if (!pending && !failed) { add("info", "No failed request to retry."); return; }
        add("meta", "Retrying saved request. Existing file changes remain in place.");
        void runTurn(
          pending?.prompt ?? failed!.prompt,
          session,
          config,
          pending?.intent ?? failed?.intent,
          pending?.displayPrompt ?? failed?.displayPrompt,
        );
        return;
      }
      if (command === "/cancelretry") {
        if (parts.length) { add("error", "Type /cancelretry without arguments."); return; }
        if (!session.deferredTurn) { add("info", "No automatic retry is scheduled."); return; }
        await cancelRetry();
        return;
      }
      if (command === "/convo" || command === "/turns") {
        if (!session.turns.length) {
          add("info", "No messages in conversation yet.");
          return;
        }
        setConvoMenu(true);
        setMenuIndex(session.turns.length - 1);
        return;
      }
      if (!skillCommand(text, enabledSkills(skills, config)) || commands.includes(command)) {
        add("error", `Unknown command ${command}. Type / to browse commands.`);
        return;
      }
    }
    const invokedSkill = skillCommand(text, enabledSkills(skills, config));
    const skillArgument = invokedSkill ? skillRequest(text, invokedSkill) : undefined;
    const localSkillCommand = invokedSkill && (!skillArgument || skillArgument === "off" || !!skillOption(invokedSkill, skillArgument));
    const stopCaveman = /^(?:stop caveman|normal mode)$/i.test(text) && session.activeSkills?.includes("caveman");
    if (session.deferredTurn && !localSkillCommand && !stopCaveman) {
      if (text === session.deferredTurn.prompt) {
        add("info", "That request is already saved for automatic retry.");
        return;
      }
      const position = promptQueue.current.add(session.id, commandOperation);
      setQueueVersion(value => value + 1);
      add("info", `Queued prompt ${position} until the automatic retry finishes.`);
      return;
    }
    if (vexState !== "connected" && session.routingMode === "auto" && !localSkillCommand && !stopCaveman) {
      add(
        "error",
        "Vex MCP is unavailable. Auto routing is blocked. Choose a model in /models for manual turns, or restart Pace after fixing Vex.",
      );
      return;
    }
    void runTurn(text, session, config);
  };

  return { submit };
}
