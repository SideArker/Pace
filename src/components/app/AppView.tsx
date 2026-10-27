import React, { useMemo } from "react";
import { Box, Static, Text } from "ink";
import { join } from "node:path";
import { ApprovalPanel } from "../ApprovalPanel.js";
import { BottomPanel } from "../BottomPanel.js";
import { Composer } from "../Composer.js";
import { ComposerFrame } from "../ComposerFrame.js";
import { FileDiffPanel } from "../FileDiffPanel.js";
import { HeaderLogo, HeaderStatus } from "../Header.js";
import { BenchmarkManager } from "../BenchmarkManager.js";
import { McpManager } from "../McpManager.js";
import { ApprovalModeMenu, CommandMenu, ConvoMenu, ManualWorkflowMenu, ModelMenu, QueueMenu } from "../Menus.js";
import { saveClipboardImage } from "../pasted-images.js";
import { QuestionPanel } from "../QuestionPanel.js";
import { RunningProcesses } from "../RunningProcesses.js";
import { TaskPanel } from "../TaskPanel.js";
import { Transcript, splitTranscript, type Line } from "../Transcript.js";
import { WorkingStatus } from "../WorkingStatus.js";
import type { AppController } from './useAppController.js';
import { store, project } from './runtime.js';

export function AppView({ model }: { model: AppController }) {
  const {
    lines, staticHistory, session, transcriptRevision, showHeader, vexState, terminalDimensions, busy,
    liveUsage, workingTip, diffOpen, setDiffOpen, onClear, setTranscriptRevision, setSession,
    rememberSession, mcpOpen, setMcpOpen, outputsExpanded, modelMenu, menuModels, availableModels,
    menuEfforts, modelCatalogStatus, menuModel, menuIndex, config, approvalMenu, manualMenu, manualWizard,
    manualStage, manualOptions, convoMenu, queueMenu, queued, status, runningIds, shellJobs, tick,
    backgroundApprovals, backgroundQuestions, processes, approval, question, pickerFocused, cancelArmed,
    shellMode, draft, setDraft, setSelection, submit, history, add, historyChanging, resumeMenu,
    registeredCommands, matches, selection, commandArgsWithSkills, token, selectedAutoSkill,
    changeAutoLaunch, focusQueuedOrPicker, handleQueueEdit, handleQueueDelete,
    commandDescriptionsWithSkills, skillCommands, pickerChoices, missingProjectPaths, activeSessionId,
    pickerIndex, pickerSearch, showConversationsTab, sortedSessions, usageLimits, usageError,
  } = model;
  const { history: settledLines, live: liveLines } = useMemo(() => splitTranscript(lines), [lines]);
  const staticState = staticHistory.current;
  if (session?.id && staticState.sessionId && session.id !== staticState.sessionId) {
    staticState.key++;
    staticState.firstId = lines[0]?.id;
  } else if (staticState.firstId !== undefined && staticState.firstId !== lines[0]?.id) {
    staticState.key++;
    staticState.firstId = lines[0]?.id;
  } else if (staticState.firstId === undefined) {
    staticState.firstId = lines[0]?.id;
  }
  staticState.sessionId = session?.id ?? staticState.sessionId;
  const staticKey = `${staticState.key}-${transcriptRevision}`;
  const staticItems: ({ kind: "logo" } | { kind: "status" } | { kind: "lines"; group: Line[] })[] = [
    ...(showHeader ? [{ kind: "logo" as const }] : []),
    ...(showHeader && vexState !== "connecting" ? [{ kind: "status" as const }] : []),
    ...settledLines.map(group => ({ kind: "lines" as const, group })),
  ];
  const terminalColumns = terminalDimensions.columns;
  const terminalRows = terminalDimensions.rows;
  const contentWidth = Math.max(20, terminalColumns - 2);
  const composerChromeRows = contentWidth < 50 || (contentWidth >= 72 && contentWidth < 112) ? 6 : 5;
  const extraWorkingRows = (busy && session && liveUsage[session.id] ? 1 : 0) + (busy && workingTip ? 1 : 0);
  const maxComposerRows = Math.max(1, terminalRows - composerChromeRows - extraWorkingRows - 1);

  if (model.benchmarkOpen) return <BenchmarkManager width={terminalColumns} height={Math.max(1, terminalRows - 1)}
    canStart={() => model.jobs.current.size || model.sideAbort.current || model.titleAborts.current.size || model.shells.current.size || model.remoteHost.current || [...model.sessionRecords.current.values()].some(record => record.deferredTurn || record.queuedPrompts?.length || model.promptQueue.current.operations(record.id).length)
      ? "Wait for main/side jobs, title jobs, shells, remote host and queued/deferred work to finish before Start. Results remain available." : undefined}
    onClose={() => { model.setBenchmarkOpen(false); onClear(); setTranscriptRevision(value => value + 1); }} />;

  if (diffOpen && session) return <FileDiffPanel store={store} session={session} width={terminalColumns} height={Math.max(1, terminalRows - 1)}
    onClose={() => { setDiffOpen(false); onClear(); setTranscriptRevision(value => value + 1); }}
    onChange={updated => { setSession({ ...updated }); rememberSession(updated); }} />;

  if (mcpOpen && session) return <McpManager key={session.projectPath} project={session.projectPath} width={terminalColumns} height={Math.max(1, terminalRows - 1)}
    onClose={() => { setMcpOpen(false); onClear(); setTranscriptRevision(value => value + 1); }} />;

  return (
    // Ink clears the terminal on every update when the live frame exceeds the viewport.
    <Box flexDirection="column" paddingX={1} width={terminalColumns} maxHeight={Math.max(1, terminalRows - 1)} overflowY="hidden">
      <Static key={staticKey} items={staticItems} style={{ width: contentWidth }}>
        {item => item.kind === "logo"
          ? <HeaderLogo key="logo" width={contentWidth} />
          : item.kind === "status"
            ? <HeaderStatus project={session?.projectPath ?? project} vexState={vexState} sessionKind={session?.kind} width={contentWidth} />
            : <Transcript key={item.group[0]?.id} lines={item.group} outputsExpanded={outputsExpanded} detailsExpanded={outputsExpanded} width={contentWidth} />}
      </Static>
      <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
      <Box flexDirection="column" flexShrink={1} minHeight={0} overflowY="hidden">
        <Transcript lines={liveLines.slice(-Math.max(1, Math.floor(((terminalRows - 12) / 4))))} outputsExpanded={outputsExpanded} detailsExpanded={outputsExpanded} livePreview width={contentWidth} />
      </Box>
      {modelMenu ? <ModelMenu mode={modelMenu} models={menuModels} availableModels={availableModels.map(model => model.model)} efforts={menuEfforts} catalogStatus={modelCatalogStatus} selectedModel={menuModel} selectedIndex={menuIndex} config={config} /> : null}
      {approvalMenu ? <ApprovalModeMenu selectedIndex={menuIndex} currentMode={config?.approvalMode ?? "request-approval"} /> : null}
      {manualMenu ? <ManualWorkflowMenu title={manualWizard.step === "workflow" ? "Manual workflow" : `${manualWizard.shape} · ${manualStage} · ${manualWizard.step}`} options={manualOptions} selectedIndex={menuIndex} /> : null}
      {convoMenu && session ? <ConvoMenu turns={session.turns} selectedIndex={menuIndex} /> : null}
      {queueMenu && session ? <QueueMenu prompts={queued} selectedIndex={menuIndex} /> : null}
      <WorkingStatus busy={busy} status={status} runningCount={runningIds.length} shellJobs={shellJobs} tick={tick}
        usage={busy && session ? liveUsage[session.id] : undefined} tip={workingTip} />
      {backgroundApprovals.length ? <Text color="#FBBF24" bold>⚠ {backgroundApprovals.length} background approval{backgroundApprovals.length === 1 ? "" : "s"} waiting · ↓ select conversation · Enter open</Text> : null}
      {backgroundQuestions.length ? <Text color="#A5B4FC" bold>◆ {backgroundQuestions.length} background question{backgroundQuestions.length === 1 ? "" : "s"} waiting · {question ? "Shift+Tab" : "↓"} select conversation · Enter open</Text> : null}
      <RunningProcesses processes={processes} now={Date.now()} />
      <TaskPanel tasks={session?.tasks ?? []} />
      {approval ? <ApprovalPanel approval={approval} /> : null}
      {question ? <QuestionPanel key={`${session?.id}-${question.id}`} questions={question.questions} onSubmit={question.respond} isActive={!pickerFocused && !approval} /> : null}
      {cancelArmed ? <Text color="#FBBF24">Press Esc again to cancel the turn</Text> : null}
      {session?.deferredTurn && !busy ? <Text color="#FBBF24">Automatic retry ({session.deferredTurn.reason ?? "usage"}): {session.deferredTurn.reason === "network" ? "checking connection" : `after ${new Date(session.deferredTurn.retryAt).toLocaleString()}`} · Esc cancels</Text> : null}
      </Box>
      <ComposerFrame width={contentWidth} session={session} shellMode={shellMode} approvalMode={config?.approvalMode}>
        <Composer key={session?.id} value={draft} width={contentWidth} maxRows={maxComposerRows} onChange={value => { setDraft(value); setSelection(0); }} onSubmit={value => { void submit(value); }} history={history}
          onImagePaste={async () => {
            try {
              const targetDir = session ? store.conversationDir(session.projectPath, session.id) : join(store.sessionDir(project), "pasted-images");
              const path = await saveClipboardImage(targetDir);
              if (!path) add("info", "No image found in clipboard. On WSL, use Alt+V when terminal handles Ctrl+V.");
              return path ? `[Pace image: ${path}]` : undefined;
            } catch (error) {
              add("error", `Could not paste image: ${String(error)}`);
              return undefined;
            }
          }}
          disabled={!session || !config || historyChanging || !!approval || !!question || !!modelMenu || approvalMenu || resumeMenu || convoMenu || queueMenu || manualMenu || pickerFocused} shellMode={shellMode} registeredCommands={registeredCommands}
          completion={matches[selection] ? (commandArgsWithSkills[matches[selection]!] ? `${matches[selection]} ` : matches[selection]) : matches[0] ? (commandArgsWithSkills[matches[0]!] ? `${matches[0]} ` : matches[0]) : undefined} completionStart={token?.start}
          onComplete={() => {
            const chosen = matches[selection] ?? matches[0];
            const completed = chosen ? (commandArgsWithSkills[chosen] ? `${chosen} ` : chosen) : token?.prefix;
            setDraft(token ? draft.slice(0, token.start) + (completed ?? token.prefix) : draft);
          }}
          onAutoLaunchToggle={matches.length && selectedAutoSkill() ? () => { void changeAutoLaunch(selectedAutoSkill()!.name, true); } : undefined}
          onHistory={direction => {
            if (!matches.length) return false;
            setSelection(value => (value + (direction === "up" ? -1 : 1) + matches.length) % matches.length);
            return true;
          }}
          onMoveDown={focusQueuedOrPicker}
          onQueueEdit={() => handleQueueEdit()}
          onDeleteQueued={handleQueueDelete}
          placeholder={modelMenu || approvalMenu || resumeMenu || convoMenu || queueMenu || manualMenu ? "Close menu to type" : shellMode ? "Bash command; ! returns to Pace" : vexState !== "connected" ? "Vex unavailable; manual turns work" : busy ? "Type next prompt to queue it" : "Ask Pace or type /"}
        />
      </ComposerFrame>
      {!modelMenu && !approvalMenu && !resumeMenu && !convoMenu && !queueMenu && !manualMenu && matches.length > 0 ? (
        <CommandMenu
          matches={matches}
          descriptions={commandDescriptionsWithSkills}
          args={commandArgsWithSkills}
          selectedIndex={selection}
          width={contentWidth}
          skillNames={skillCommands}
          autoLaunchSkills={session?.autoLaunchSkills}
        />
      ) : null}
      <BottomPanel
        width={contentWidth}
        height={terminalRows}
        pendingInteraction={!!question || !!approval}
        conversations={{
          choices: pickerChoices,
          missingProjectPaths,
          activeId: activeSessionId.current,
          selectedIndex: pickerIndex,
          focused: pickerFocused,
          searchQuery: pickerSearch,
        }}
        showConversations={showConversationsTab || sortedSessions.length > 1 || pickerFocused}
        queuedPrompts={queued}
        usageLimits={usageLimits}
        usageError={usageError}
      />
    </Box>
  );
}
