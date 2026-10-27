import { useRef, useState } from "react";
import type { Progress } from "../../integrations/codex.js";
import type { Config, OperationIntent, QueuedOperation, Session } from "../../shared/types.js";
import type { Skill } from "../../core/system/skills.js";
import type { RemoteHost } from "../../remote/server.js";
import type { RunningProcess } from "../RunningProcesses.js";
import type { PendingApproval, PendingQuestion, TurnJob } from "../turn-runner.js";
import type { Line } from "../Transcript.js";

export function useAppState() {
  const [config, setConfig] = useState<Config>();
  const latestConfig = useRef<Config | undefined>(undefined);
  if (config) latestConfig.current = config;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [session, setSession] = useState<Session>();
  const sessionRef = useRef<Session | undefined>(undefined);
  sessionRef.current = session;
  const sessionRecords = useRef(new Map<string, Session>());
  const [openSessions, setOpenSessions] = useState<Session[]>([]);
  const thisPaceIds = useRef(new Set<string>());
  const [pickerFocused, setPickerFocused] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerSearch, setPickerSearch] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const [sideBusy, setSideBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [outputsExpanded, setOutputsExpanded] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [benchmarkOpen, setBenchmarkOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [historyChanging, setHistoryChanging] = useState(false);
  const historyBusy = useRef(false);
  const [transcriptRevision, setTranscriptRevision] = useState(0);
  const [showHeader, setShowHeader] = useState(true);
  const [selection, setSelection] = useState(0);
  const [tick, setTick] = useState(0);
  const [shellMode, setShellMode] = useState(false);
  const [shellJobs, setShellJobs] = useState(0);
  const [processes, setProcesses] = useState<RunningProcess[]>([]);
  const [liveUsage, setLiveUsage] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<Extract<Progress, { kind: "approval" }>>();
  const [question, setQuestion] = useState<PendingQuestion>();
  const [pendingRevision, setPendingRevision] = useState(0);
  const runTurnRef = useRef<((text: string, turnSession: Session, turnConfig: Config, intent?: OperationIntent, displayPrompt?: string, automaticRetry?: boolean, operation?: QueuedOperation) => Promise<boolean>) | undefined>(undefined);
  const remoteHost = useRef<RemoteHost | undefined>(undefined);
  const [approvalMenu, setApprovalMenu] = useState(false);
  const [vexState, setVexState] = useState<
    "connecting" | "connected" | "failed"
  >("connecting");
  const [resumeMenu, setResumeMenu] = useState(false);
  const [convoMenu, setConvoMenu] = useState(false);
  const [queueMenu, setQueueMenu] = useState(false);
  const [resumeChoices, setResumeChoices] = useState<Session[]>([]);
  const [resumeProcessIds, setResumeProcessIds] = useState<string[]>([]);
  const [missingProjectPaths, setMissingProjectPaths] = useState<string[]>([]);
  const nextId = useRef(0);
  const turnSequence = useRef(0);
  const jobs = useRef(new Map<string, TurnJob>());
  const queueSaves = useRef(new Map<string, Promise<void>>());
  const [, setQueueVersion] = useState(0);
  const activeSessionId = useRef<string | undefined>(undefined);
  const sessionLines = useRef(new Map<string, Line[]>());
  const lastReasoningTokens = useRef(new Map<string, number>());
  const sessionDrafts = useRef(new Map<string, string>());
  const preSessionLines = useRef<Line[]>([]);
  const sessionStatuses = useRef(new Map<string, string>());
  const unreadCompletions = useRef(new Set<string>());
  const pendingApprovals = useRef(new Map<string, PendingApproval>());
  const pendingQuestions = useRef(new Map<string, PendingQuestion>());
  const sideAbort = useRef<AbortController | undefined>(undefined);
  const titleAborts = useRef(new Map<string, AbortController>());
  const shells = useRef(new Set<{ kill: () => boolean }>());
  const lastInterruptAt = useRef(0);
  const switchingSession = useRef(false);
  const staticHistory = useRef<{ sessionId?: string; firstId?: number; key: number }>({ key: 0 });
  const busy = !!session && runningIds.includes(session.id);
  const [showConversationsTab, setShowConversationsTab] = useState(false);

  return {
    config, setConfig, latestConfig, skills, setSkills,
    session, setSession, sessionRef, sessionRecords, openSessions,
    setOpenSessions, thisPaceIds, pickerFocused, setPickerFocused, pickerIndex,
    setPickerIndex, pickerSearch, setPickerSearch, lines, setLines,
    status, setStatus, runningIds, setRunningIds, sideBusy,
    setSideBusy, draft, setDraft, history, setHistory,
    outputsExpanded, setOutputsExpanded, diffOpen, setDiffOpen, mcpOpen,
    setMcpOpen, benchmarkOpen, setBenchmarkOpen, historyChanging, setHistoryChanging, historyBusy, transcriptRevision,
    memoryOpen, setMemoryOpen,
    setTranscriptRevision, showHeader, setShowHeader, selection, setSelection,
    tick, setTick, shellMode, setShellMode, shellJobs,
    setShellJobs, processes, setProcesses, liveUsage, setLiveUsage,
    approval, setApproval, question, setQuestion, pendingRevision,
    setPendingRevision, runTurnRef, remoteHost, approvalMenu, setApprovalMenu,
    vexState, setVexState, resumeMenu, setResumeMenu, convoMenu,
    setConvoMenu, queueMenu, setQueueMenu, resumeChoices, setResumeChoices,
    resumeProcessIds, setResumeProcessIds, missingProjectPaths, setMissingProjectPaths, nextId,
    turnSequence, jobs, queueSaves, setQueueVersion, activeSessionId,
    sessionLines, lastReasoningTokens, sessionDrafts, preSessionLines, sessionStatuses,
    unreadCompletions, pendingApprovals, pendingQuestions, sideAbort, titleAborts,
    shells, lastInterruptAt, switchingSession, staticHistory, busy,
    showConversationsTab, setShowConversationsTab,
  };
}

export type AppState = ReturnType<typeof useAppState>;
