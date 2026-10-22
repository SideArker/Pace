import type { Dispatch, RefObject, SetStateAction } from "react";
import qrcode from "qrcode-terminal";
import type { Config, Session, QueuedOperation, OperationIntent } from "../../shared/types.js";
import type { PaceStore } from "../../core/sessions.js";
import type { Orchestrator } from "../../core/orchestrator.js";
import type { PromptQueue } from "../../core/prompt-queue.js";
import type { Progress } from "../../integrations/codex.js";
import { RemoteDomain } from "../../remote/domain.js";
import { startRemoteHost, type RemoteHost } from "../../remote/server.js";
import { lanAddresses } from "../../remote/security.js";
import { modelName } from "../turn-format.js";
import type { createTurnRunner, TurnJob } from "../turn-runner.js";
import type { Line } from "../Transcript.js";

type AuxiliaryOptions = {
  session: Session | undefined;
  config: Config | undefined;
  store: PaceStore;
  orchestrator: Orchestrator;
  project: string;
  sideBusy: boolean;
  sideAbort: RefObject<AbortController | undefined>;
  turnSequence: RefObject<number>;
  activeSessionId: RefObject<string | undefined>;
  remoteHost: RefObject<RemoteHost | undefined>;
  jobs: RefObject<Map<string, TurnJob>>;
  sessionRecords: RefObject<Map<string, Session>>;
  sessionRef: RefObject<Session | undefined>;
  historyBusy: RefObject<boolean>;
  promptQueue: RefObject<PromptQueue>;
  queueSaves: RefObject<Map<string, Promise<void>>>;
  runTurnRef: RefObject<ReturnType<typeof createTurnRunner> | undefined>;
  latestConfig: RefObject<Config | undefined>;
  setSideBusy: Dispatch<SetStateAction<boolean>>;
  setQueueVersion: Dispatch<SetStateAction<number>>;
  setSession: Dispatch<SetStateAction<Session | undefined>>;
  rememberSession: (session: Session) => void;
  activity: (progress: Extract<Progress, { kind: "activity" }>) => void;
  add: (role: Line["role"], text: string) => void;
};

export function createAuxiliaryActions({
  session, config, store, orchestrator, project, sideBusy, sideAbort, turnSequence, activeSessionId, remoteHost, jobs, sessionRecords, sessionRef, historyBusy, promptQueue, queueSaves, runTurnRef, latestConfig, setSideBusy, setQueueVersion, setSession, rememberSession, activity, add
}: AuxiliaryOptions) {
  const askBtw = async (question: string) => {
    if (!session || !config) return;
    if (!question.trim()) { add("error", "Type /btw <question> to ask a side question."); return; }
    if (sideBusy) { add("info", "A side question is already running."); return; }
    const controller = new AbortController();
    const sideId = ++turnSequence.current;
    sideAbort.current = controller;
    setSideBusy(true);
    add("you", `/btw ${question}`);
    try {
      const result = await orchestrator.aside(question, session, config, progress => {
        if (sideAbort.current !== controller) return;
        if (progress.kind === "activity") activity({ ...progress, id: `side-${sideId}-${progress.id}` });
        if (progress.kind === "error") add("error", progress.text);
      }, controller.signal, () => activeSessionId.current === session.id);
      rememberSession(result.session);
      if (activeSessionId.current === session.id) setSession({ ...session });
      if (sideAbort.current === controller) {
        const record = session.sideAnswers?.at(-1);
        add("side", result.result);
        add("meta", `Side: ${modelName(result.route)} ${result.route.effort ?? "default"} · Main: ${modelName(session.route)} ${session.route.effort ?? "default"}${record ? ` · /adopt ${record.id}` : ""}`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        add("meta", "Side question cancelled");
      } else if (sideAbort.current === controller) {
        add("error", `Side question failed: ${String(error)}`);
      }
    } finally {
      if (sideAbort.current === controller) { sideAbort.current = undefined; setSideBusy(false); }
    }
  };

  const handleRemote = async (text: string) => {
    const [, action] = text.split(/\s+/);
    if (action && action !== "stop") { add("error", "Use /remote or /remote stop."); return; }
    if (remoteHost.current) {
      await remoteHost.current.close(); remoteHost.current = undefined;
      add("info", "Remote host stopped."); return;
    }
    if (action === "stop") { add("info", "Remote host is already stopped."); return; }
    const addresses = lanAddresses();
    if (!addresses.length) { add("error", "No private IPv4 LAN interface found."); return; }
    try {
      const sessions = await store.listProjects({ summariesOnly: true });
      const roots = [...new Set([project, ...sessions.filter(item => item.exists).map(item => item.projectPath)])];
      const bridge = {
        session: (id: string) => jobs.current.get(id)?.session ?? sessionRecords.current.get(id) ?? (sessionRef.current?.id === id ? sessionRef.current : undefined),
        busy: (id: string) => jobs.current.has(id) || historyBusy.current,
        queue: async (target: Session, prompt: QueuedOperation) => {
          if (promptQueue.current.list(target.id).length >= 20) return false;
          promptQueue.current.add(target.id, prompt); setQueueVersion(value => value + 1);
          await queueSaves.current.get(target.id); return true;
        },
        cancel: (id: string) => { const job = jobs.current.get(id); if (!job) return false; job.controller.abort(); return true; },
        submit: async (prompt: string, target: Session, intent?: OperationIntent, item?: QueuedOperation) => { const success = await runTurnRef.current?.(prompt, target, latestConfig.current ?? config!, intent, undefined, false, item); if (!success) throw new Error("UI operation did not finish; queue remains paused."); },
        changed: (target: Session) => { rememberSession(target); if (activeSessionId.current === target.id) setSession({ ...target }); },
      };
      const domain = new RemoteDomain(store, orchestrator, roots, bridge);
      const host = await startRemoteHost({ baseDir: store.baseDir, address: addresses[0]!, domain });
      remoteHost.current = host;
      add("info", `Remote host listening on ${host.address}. Scan this one-time pairing code within 2 minutes:`);
      qrcode.generate(JSON.stringify(host.pairing), { small: true }, code => add("info", code));
    } catch (error) { add("error", `Could not start remote host: ${String(error)}`); }
    return;
  };
  return { askBtw, handleRemote };
}
