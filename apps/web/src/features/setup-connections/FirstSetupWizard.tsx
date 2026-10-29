import { SetupServiceConnection, type SetupServiceClient } from "./SetupServiceConnection.js";
import { SetupAssistantHelp, type SetupAssistantResponse } from "./SetupAssistantHelp.js";
import { verifySelectedSetupClientRuntimes, type SetupClientRuntimeClient } from "./setup-client-runtime-check.js";
import { SetupCaptureCheck, type SetupCaptureClient } from "./SetupCaptureCheck.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { buildSetupSelection, getSetupDependencyClosure, removeSetupFeature, getAllLiveAudioProviders, SETUP_CATALOG, type SetupFeatureId, type SetupLevel, type SetupPersona } from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { SetupVoiceConnection, type SetupVoiceChoice, type SetupVoiceClient } from "./SetupVoiceConnection.js";
import { runSetupVoiceAudioCheck, type SetupVoiceAudioClient } from "./setup-voice-audio.js";
import "./first-setup-wizard.css";

type CatalogEntry = (typeof SETUP_CATALOG)[number] & {
  availability: "AVAILABLE" | "INSTALLABLE" | "UNAVAILABLE" | "FORBIDDEN";
  reasonCode: string | null;
};

interface DraftView {
  selectionOrigin?: "EXISTING_SETTINGS";
  id: string | null;
  ownerId: string;
  revision: number | null;
  persona: SetupPersona;
  level: SetupLevel;
  requestedFeatureIds: SetupFeatureId[];
  connectionChoices: SetupVoiceChoice[];
  catalogVersion: string;
}

interface PlanView {
  id: string;
  draftRevision: number;
  planDigest: string;
  effectiveFeatureIds: SetupFeatureId[];
  requiredHumanInputs: Array<{ featureId: SetupFeatureId; kind: string; reasonCode: string }>;
}

interface RunView {
  id: string;
  status: "RUNNING" | "WAITING_FOR_INPUT" | "PAUSED" | "FAILED" | "READY" | "CANCELLED" | "SUPERSEDED";
  revision: number;
}

interface SnapshotView {
  run: RunView;
  plan: PlanView;
  tasks: Array<{ id: string; featureId: SetupFeatureId; actionId: string; status: string; errorCode: string | null }>;
}

interface FreeModelView { id: string; anonymousAvailable: boolean; setupPassed: number; latencyMs: number }

export interface FirstSetupClient extends SetupClientRuntimeClient {
  askSetupAssistant?(question: string, signal?: AbortSignal): Promise<SetupAssistantResponse>;
  beginSetupCaptureCheck?: SetupCaptureClient["beginSetupCaptureCheck"];
  completeSetupCaptureCheck?: SetupCaptureClient["completeSetupCaptureCheck"];
  cancelSetupCaptureCheck?: SetupCaptureClient["cancelSetupCaptureCheck"];
  getSetupServiceChoices?: SetupServiceClient["getSetupServiceChoices"];
  checkSetupService?: SetupServiceClient["checkSetupService"];
  getSetupVoiceProviders?: SetupVoiceClient["getSetupVoiceProviders"];
  saveSetupVoiceCredential?: SetupVoiceClient["saveSetupVoiceCredential"];
  startSetupVoiceCheck?: SetupVoiceAudioClient["startSetupVoiceCheck"];
  getSetupFreeModels?(): Promise<{ selectedModelId: string | null; checkedAt: string | null; models: FreeModelView[]; selectable?: boolean }>;
  selectSetupFreeModel?(modelId: string | null): Promise<{ modelId: string | null; verified: boolean }>;
  getSetupFreeModel?(): Promise<{ choice: "AUTO_BEST_FREE"; modelId: string | null; verified: boolean }>;
  getSetupCatalog(): Promise<{ features: CatalogEntry[] }>;
  getSetupDraft(): Promise<DraftView>;
  saveSetupDraft(input: Pick<DraftView, "persona" | "level" | "requestedFeatureIds" | "connectionChoices"> & { expectedRevision: number | null }): Promise<DraftView>;
  createSetupPlan(draftRevision: number): Promise<PlanView>;
  startSetupRun(plan: PlanView, idempotencyKey: string): Promise<RunView>;
  getSetupRun(runId: string): Promise<SnapshotView>;
  getCurrentSetup(): Promise<{ run: RunView | null; plan: PlanView | null; completedRunId?: string | null; tasks: SnapshotView["tasks"] }>;
  verifySetupConnection?(connectionId: string): Promise<{ liveVerificationState?: string; functionalState?: string }>;
  retrySetupRun(runId: string, taskIds: string[], expectedRunRevision: number): Promise<{ run: RunView }>;
  reconcileSetupTask?(runId: string, taskId: string): Promise<SnapshotView>;
  pauseSetupRun?(runId: string): Promise<{ run: RunView }>;
  resumeSetupRun?(runId: string): Promise<{ run: RunView }>;
  finishSetupRun(run: RunView, plan: PlanView): Promise<{ isComplete: boolean }>;
}

const personas: { id: SetupPersona; label: string; description: string }[] = [
  { id: "everyday", label: "Everyday", description: "A calm space for everyday help." },
  { id: "creator", label: "Creator & Research", description: "Media, references and research tools." },
  { id: "developer", label: "Developer", description: "Code, projects and source control." }
];
const levels: { id: SetupLevel; label: string; description: string }[] = [
  { id: "minimal", label: "Minimal", description: "Only what you need to begin." },
  { id: "balanced", label: "Balanced", description: "A useful set of everyday tools." },
  { id: "full", label: "Full", description: "Every supported workspace tool. Other agents remain optional." }
];
const connectionLabels: Record<string, string> = {
  "live-provider": "a compatible Live provider and its API credentials",
  microphone: "microphone and playback permission plus a real audio check",
  "database-target": "an authorized database connection",
  "vnc-target": "an authorized remote desktop target",
  "harness-target": "a compatible Harness runtime",
  "streaming-destination": "an authorized streaming destination"
};

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "Setup could not continue. Try again.";
}

function taskFailureMessage(code: string | null, task: SnapshotView["tasks"][number]): string {
  if (code === "PROVIDER_FAILED") return "Provider check failed. Reconnect and retry this step.";
  if (code === "LEASE_EXPIRED_RECONCILE") return "This step was interrupted. Check its current state before retrying.";
  if (code === "ACTION_ADAPTER_UNAVAILABLE") return "This tool cannot be checked on this installation. Remove it from your selection or install its runtime.";
  if (code === "ACTION_STATE_UNKNOWN") return "The previous action could not be verified. Check the installation and retry.";
  if (code === "ACTION_APPLY_FAILED" && task.featureId === "agent:opencode") return "OpenCode runtime check failed. Check the installer and retry this step.";
  if (code === "ACTION_APPLY_FAILED" && task.featureId.startsWith("agent:")) return "The selected agent did not pass its provider check. Reconnect and retry.";
  if (code === "ACTION_APPLY_FAILED") return "This tool could not be prepared. Review its requirements and retry.";
  if (code === "ACTION_INSPECTION_FAILED" || code === "ACTION_VERIFICATION_FAILED") return "The server could not verify this tool. Check its runtime and retry.";
  return "This selected tool needs a current check. Review its connection, then retry.";
}

export function FirstSetupWizard({ client, onOpenChange, onOpenAgentLogin, onFinished, roomTheme, colorMode }: {
  client: FirstSetupClient;
  onOpenChange: (open: boolean) => void;
  onOpenAgentLogin?: (connectionId: string) => Promise<void>;
  /** Setup finished on the server: the app reloads the settings it applied (tools shown, the tested Live default). */
  onFinished?: () => Promise<void> | void;
  roomTheme?: string;
  colorMode?: "light" | "dark";
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const finishedRef = useRef(false);
  const [captureActive, setCaptureActive] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const removalRef = useRef<HTMLDivElement>(null);
  const removalTriggerRef = useRef<HTMLElement | null>(null);
  const [removal, setRemoval] = useState<SetupFeatureId | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [freeModel, setFreeModel] = useState<string | null>(null);
  const [freeModels, setFreeModels] = useState<FreeModelView[]>([]);
  const [freeModelSelectable, setFreeModelSelectable] = useState(true);
  const [modelChoice, setModelChoice] = useState("auto");
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [persona, setPersona] = useState<SetupPersona>("everyday");
  const [level, setLevel] = useState<SetupLevel>("minimal");
  const [requested, setRequested] = useState<SetupFeatureId[]>([]);
  const [undoPreset, setUndoPreset] = useState<{ persona: SetupPersona; level: SetupLevel; requested: SetupFeatureId[] } | null>(null);
  const [exploring, setExploring] = useState(false);
  const [query, setQuery] = useState("");
  const [screen, setScreen] = useState<"your-space" | "connections" | "setting-up" | "ready">("your-space");
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [pending, setPending] = useState(false);
  const clientRuntimeAbortRef = useRef<AbortController | null>(null);
  const [checkingBrowserTools, setCheckingBrowserTools] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => () => { clientRuntimeAbortRef.current?.abort(); }, []);

  async function withBrowserChecks<T>(current: DraftView, features: SetupFeatureId[], proceed: () => Promise<T>): Promise<T> {
    if (current.revision === null) throw new Error("Save the current choices before checking browser tools.");
    clientRuntimeAbortRef.current?.abort();
    const controller = new AbortController(); clientRuntimeAbortRef.current = controller;
    setCheckingBrowserTools(true);
    try {
      await verifySelectedSetupClientRuntimes(client, features, current.revision, controller.signal);
      controller.signal.throwIfAborted();
      const result = await proceed();
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (clientRuntimeAbortRef.current === controller) { clientRuntimeAbortRef.current = null; setCheckingBrowserTools(false); }
    }
  }

  async function checkedPlan(current: DraftView): Promise<PlanView> {
    return withBrowserChecks(current, current.requestedFeatureIds, () => client.createSetupPlan(current.revision!));
  }

  useEffect(() => {
    let active = true;
    void Promise.all([client.getSetupCatalog(), client.getSetupDraft(), client.getCurrentSetup()]).then(([nextCatalog, nextDraft, current]) => {
      if (!active) return;
      setCatalog(nextCatalog.features);
      setDraft(nextDraft);
      const model = nextDraft.connectionChoices.find((choice) => choice.featureId === "agent:opencode")?.modelId;
      if (model) setModelChoice(`opencode/${model}`);
      setPersona(nextDraft.persona);
      setLevel(nextDraft.level);
      setRequested(nextDraft.requestedFeatureIds);
      if (current.run && current.run.id !== current.completedRunId && current.plan && current.plan.draftRevision === nextDraft.revision) {
        setPlan(current.plan);
        setSnapshot({ run: current.run, plan: current.plan, tasks: current.tasks });
        setScreen("setting-up");
        void refresh(current.run.id, current.plan);
      }
    }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (client.getSetupFreeModels) {
      let active = true;
      void client.getSetupFreeModels().then((result) => {
        // The choice stays visible but disabled until this installation's OpenCode can apply it.
        if (active) { setFreeModels(result.models ?? []); setFreeModelSelectable(result.selectable !== false); setFreeModel(result.selectedModelId); }
      }).catch(() => { if (active) setFreeModels([]); });
      return () => { active = false; };
    }
    if (!client.getSetupFreeModel) return;
    let active = true;
    void client.getSetupFreeModel().then((result) => {
      if (active) setFreeModel(result.verified ? result.modelId : null);
    }).catch(() => { if (active) setFreeModel(null); });
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    priorFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();
    return () => { priorFocusRef.current?.focus(); };
  }, []);

  useEffect(() => { titleRef.current?.focus(); }, [screen]);

  useEffect(() => {
    if (removal) removalRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else removalTriggerRef.current?.focus();
  }, [removal]);

  function keepFocusInside(event: KeyboardEvent<HTMLElement>) {
    if (removal && event.key === "Escape") { event.preventDefault(); setRemoval(null); return; }
    if (event.key !== "Tab") return;
    const focusRoot = removalRef.current ?? dialogRef.current;
    const focusable = Array.from(focusRoot?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]'
    ) ?? []).filter((element) => element.getClientRects().length > 0 || element.offsetParent !== null);
    // jsdom has no layout. The focus guard also works when the browser reports no rects yet.
    const ordered = focusable.length ? focusable : Array.from(focusRoot?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]'
    ) ?? []);
    if (!ordered.length) return;
    const first = ordered[0]!;
    const last = ordered.at(-1)!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  const availability = useMemo(() => Object.fromEntries(catalog.map((feature) => [feature.id, feature.availability])), [catalog]);
  const selectPreset = useCallback((nextPersona: SetupPersona, nextLevel: SetupLevel) => {
    const selectedAgents = requested.filter((id) => id.startsWith("agent:") && id !== "agent:opencode");
    const priorPreset = buildSetupSelection(persona, level, availability, selectedAgents).requestedIds;
    if (!undoPreset && (requested.length !== priorPreset.length || requested.some((id) => !priorPreset.includes(id)))) {
      setUndoPreset({ persona, level, requested });
    }
    setPersona(nextPersona);
    setLevel(nextLevel);
    setRequested(buildSetupSelection(nextPersona, nextLevel, availability, selectedAgents).requestedIds);
  }, [availability, level, persona, requested, undoPreset]);

  const visibleFeatures = catalog.filter((feature) =>
    `${feature.label} ${feature.description} ${feature.details}`.toLowerCase().includes(query.toLowerCase())
  );
  const selected = useMemo(() => getSetupDependencyClosure(requested), [requested]);
  const liveSelected = selected.includes("pane:live");
  function requestRemoval(featureId: SetupFeatureId) {
    const remaining = removeSetupFeature(requested, featureId);
    if (requested.some(id => id !== featureId && !remaining.includes(id))) {
      removalTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setRemoval(featureId);
    } else { setUndoPreset(null); setRequested(remaining); setScreen("your-space"); }
  }
  const voiceClient = useMemo<SetupVoiceClient | null>(() => client.getSetupVoiceProviders && client.saveSetupVoiceCredential ? {
    getSetupVoiceProviders: () => client.getSetupVoiceProviders!(),
    saveSetupVoiceCredential: (input) => client.saveSetupVoiceCredential!(input)
  } : null, [client]);
  const captureClient = useMemo<SetupCaptureClient | null>(() => client.beginSetupCaptureCheck && client.completeSetupCaptureCheck && client.cancelSetupCaptureCheck ? {
    beginSetupCaptureCheck: revision => client.beginSetupCaptureCheck!(revision),
    completeSetupCaptureCheck: (id, rgba) => client.completeSetupCaptureCheck!(id, rgba),
    cancelSetupCaptureCheck: id => client.cancelSetupCaptureCheck!(id)
  } : null, [client]);
  async function captureVerified() {
    if (draft?.revision === null || draft?.revision === undefined) throw new Error("Save the current choices before testing capture.");
    const verifiedPlan = await checkedPlan(draft); setPlan(verifiedPlan);
    if (!verifiedPlan.requiredHumanInputs.length) await start(verifiedPlan);
  }

  async function persistConnectionChoice(choice: SetupVoiceChoice): Promise<DraftView> {
    if (!draft || !selected.includes(choice.featureId)) throw new Error("This tool is no longer selected.");
    const prior = draft.connectionChoices.find(item => item.featureId === choice.featureId);
    if (prior && ["providerId", "modelId", "voiceId", "credentialRef"].every(key => prior[key as keyof SetupVoiceChoice] === choice[key as keyof SetupVoiceChoice])) return draft;
    const saved = await client.saveSetupDraft({
      expectedRevision: draft.revision, persona, level, requestedFeatureIds: requested,
      connectionChoices: [...draft.connectionChoices.filter(item => item.featureId !== choice.featureId && selected.includes(item.featureId)), choice]
    });
    setDraft(saved); setPlan(await checkedPlan(saved));
    return saved;
  }
  async function saveVoiceChoice(choice: SetupVoiceChoice) { await persistConnectionChoice(choice); }
  const serviceClient = useMemo<SetupServiceClient | null>(() => client.getSetupServiceChoices && client.checkSetupService ? {
    getSetupServiceChoices: id => client.getSetupServiceChoices!(id),
    checkSetupService: (id, revision, choice) => client.checkSetupService!(id, revision, choice)
  } : null, [client]);
  async function checkSelectedService(featureId: SetupFeatureId, choiceId: string) {
    if (!serviceClient) throw new Error("Service checks are unavailable.");
    const saved = await persistConnectionChoice({ featureId, modelId: choiceId });
    if (saved.revision === null) throw new Error("Save the current selection first.");
    const result = await serviceClient.checkSetupService(featureId, saved.revision, choiceId);
    if (!result.verified) throw new Error("The service did not pass its current check.");
    const verifiedPlan = await checkedPlan(saved);
    setPlan(verifiedPlan);
    if (!verifiedPlan.requiredHumanInputs.length) await start(verifiedPlan);
  }

  async function checkVoiceAudio(choice: SetupVoiceChoice, options: { signal: AbortSignal; onStatus: (message: string) => void }) {
    if (!client.startSetupVoiceCheck) throw new Error("Audio checks are unavailable.");
    const current = await client.getSetupDraft();
    const savedChoice = current.connectionChoices.find(item => item.featureId === "pane:live");
    if (current.revision === null || !current.requestedFeatureIds.includes("pane:live") ||
      ["providerId", "modelId", "voiceId", "credentialRef"].some(key => savedChoice?.[key as keyof SetupVoiceChoice] !== choice[key as keyof SetupVoiceChoice])) {
      throw new Error("Live choices changed. Review the current connection first.");
    }
    await runSetupVoiceAudioCheck({ startSetupVoiceCheck: revision => client.startSetupVoiceCheck!(revision) }, current.revision, options);
    if (options.signal.aborted) return;
    const verifiedPlan = await checkedPlan(current);
    if (options.signal.aborted) return;
    setPlan(verifiedPlan);
    if (verifiedPlan.requiredHumanInputs.length === 0) await start(verifiedPlan);
  }

  async function skipLive() {
    if (!draft || pending) return;
    setPending(true); setError(null);
    try {
      const remaining = removeSetupFeature(requested, "pane:live");
      const selected = getSetupDependencyClosure(remaining);
      const saved = await client.saveSetupDraft({ expectedRevision: draft.revision, persona, level, requestedFeatureIds: remaining,
        connectionChoices: draft.connectionChoices.filter(choice => choice.featureId !== "pane:live" && selected.includes(choice.featureId)) });
      setDraft(saved); setRequested(remaining);
      const nextPlan = await checkedPlan(saved); setPlan(nextPlan);
      if (!nextPlan.requiredHumanInputs.length) await start(nextPlan);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function chooseFreeModel(choice: string) {
    if (!draft || !client.selectSetupFreeModel || pending) return;
    setPending(true); setError(null);
    try {
      const result = await client.selectSetupFreeModel(choice === "auto" ? null : choice);
      if (!result.verified || !result.modelId || (choice !== "auto" && result.modelId !== choice)) {
        throw new Error("The selected free model did not pass its native check.");
      }
      setModelChoice(choice); setFreeModel(result.modelId);
      setDraft({ ...draft, connectionChoices: [
        ...draft.connectionChoices.filter((item) => item.featureId !== "agent:opencode"),
        ...(choice !== "auto" ? [{ featureId: "agent:opencode" as SetupFeatureId, providerId: "opencode", modelId: result.modelId.slice(9) }] : [])
      ] });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function saveAndClose() {
    if (checkingBrowserTools) { clientRuntimeAbortRef.current?.abort(); onOpenChange(false); return; }
    if (pending) return;
    if (screen !== "your-space" || !draft) { onOpenChange(false); return; }
    setPending(true);
    setError(null);
    try {
      await client.saveSetupDraft({
        expectedRevision: draft.revision, persona, level, requestedFeatureIds: requested,
        connectionChoices: draft.connectionChoices.filter((choice) => selected.includes(choice.featureId))
      });
      onOpenChange(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function begin() {
    if (!draft || pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await client.saveSetupDraft({
        expectedRevision: draft.revision,
        persona, level, requestedFeatureIds: requested,
        connectionChoices: draft.connectionChoices.filter((choice) => selected.includes(choice.featureId))
      });
      setDraft(saved);
      const nextPlan = await checkedPlan(saved);
      setPlan(nextPlan);
      if (nextPlan.requiredHumanInputs.length) {
        setScreen("connections");
        return;
      }
      await start(nextPlan);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function start(nextPlan: PlanView) {
    const nextRun = await client.startSetupRun(nextPlan, `setup:${nextPlan.planDigest.slice(0, 32)}`);
    setScreen("setting-up");
    setSnapshot({ run: nextRun, plan: nextPlan, tasks: [] });
    await refresh(nextRun.id, nextPlan);
  }

  async function checkAgent(connectionId: string) {
    if (!draft || !client.verifySetupConnection) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.verifySetupConnection(connectionId);
      if (result.functionalState !== "FUNCTIONAL" || result.liveVerificationState !== "VERIFIED") {
        throw new Error("The provider did not pass a live check. Finish sign-in and try again.");
      }
      const updatedPlan = await checkedPlan(draft);
      setPlan(updatedPlan);
      if (updatedPlan.requiredHumanInputs.length === 0) await start(updatedPlan);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function openAgentLogin(connectionId: string) {
    if (!onOpenAgentLogin) return;
    setPending(true);
    setError(null);
    try { await onOpenAgentLogin(connectionId); onOpenChange(false); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function refresh(runId: string, currentPlan: PlanView) {
    try {
      const current = await client.getSetupRun(runId);
      setSnapshot(current);
      if (current.run.status === "READY") {
        let result: { isComplete: boolean };
        try { result = await client.finishSetupRun(current.run, currentPlan); }
        catch (cause) {
          // Checks that expired before finish (a closed tab, a long pause) are checked again in this run (review 2026-10-21 #8).
          const failure = cause as { code?: unknown; details?: { missingTaskIds?: unknown } };
          const expired = failure.code === "SETUP_CHECKS_EXPIRED" && Array.isArray(failure.details?.missingTaskIds)
            ? failure.details.missingTaskIds.filter((id): id is string => typeof id === "string") : [];
          if (!expired.length) throw cause;
          const revalidated = await client.retrySetupRun(current.run.id, expired, current.run.revision);
          setSnapshot({ ...current, run: revalidated.run });
          return;
        }
        if (result.isComplete) {
          setConfirmed(true); setScreen("ready");
          if (!finishedRef.current) { finishedRef.current = true; void (async () => onFinished?.())().catch(() => undefined); }
        }
      }
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function retryFailed() {
    if (!snapshot || !plan || pending || snapshot.run.status !== "FAILED") return;
    const failedTasks = snapshot.tasks.filter((task) => task.status === "NEEDS_ATTENTION" &&
      task.errorCode !== "LEASE_EXPIRED_RECONCILE");
    const taskIds = failedTasks.map((task) => task.id);
    if (!taskIds.length) return;
    setPending(true);
    setError(null);
    try {
      const current = await client.getSetupDraft();
      if (current.revision !== plan.draftRevision) throw new Error("Setup choices changed. Review the current selection before retrying.");
      const result = await withBrowserChecks(current, failedTasks.map(task => task.featureId),
        () => client.retrySetupRun(snapshot.run.id, taskIds, snapshot.run.revision));
      setSnapshot({ ...snapshot, run: result.run });
      await refresh(result.run.id, plan);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function reconcileInterrupted(taskId: string) {
    if (!snapshot || !plan || !client.reconcileSetupTask || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.reconcileSetupTask(snapshot.run.id, taskId);
      setSnapshot(result);
      if (result.run.status === "RUNNING" || result.run.status === "READY") await refresh(result.run.id, plan);
      else setError("The previous action could not be verified. Check its connection and try again.");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  async function changeRunActivity(operation: "pause" | "resume") {
    if (!snapshot || !plan || pending) return;
    const action = operation === "pause" ? client.pauseSetupRun : client.resumeSetupRun;
    if (!action) return;
    setPending(true);
    setError(null);
    try {
      const result = await action(snapshot.run.id);
      setSnapshot({ ...snapshot, run: result.run });
      if (operation === "resume") await refresh(result.run.id, plan);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }

  useEffect(() => {
    if (screen !== "setting-up" || !snapshot || snapshot.run.status !== "RUNNING" || !plan) return;
    const timer = window.setInterval(() => { void refresh(snapshot.run.id, plan); }, 2000);
    return () => window.clearInterval(timer);
  }, [screen, snapshot?.run.id, snapshot?.run.status, plan]);

  return <div className="first-setup-overlay" data-room-theme={roomTheme} data-color-mode={colorMode}>
    <section ref={dialogRef} className="first-setup" role="dialog" aria-modal="true" aria-labelledby="first-setup-title" onKeyDown={keepFocusInside}>
      <header className="first-setup-header" inert={Boolean(removal) || captureActive}>
        <div><span className="first-setup-kicker">SpaceApp · first setup</span>
          <h2 id="first-setup-title" ref={titleRef} tabIndex={-1}>{screen === "your-space" ? "Your Space" : screen === "connections" ? "Connections" : screen === "setting-up" ? "Setting up" : "Ready"}</h2>
          <p>{screen === "your-space" ? "Choose the space you need. OpenCode and the essentials are already selected." :
            screen === "connections" ? "Connect only the tools you selected." :
              screen === "setting-up" ? "Space is checking each selected tool before opening." : "Your selected tools are ready."}</p>
        </div>
        <button type="button" className="first-setup-close" onClick={() => void saveAndClose()} disabled={pending && !checkingBrowserTools} aria-label="Save and close setup">Close</button>
      </header>
      <div className="first-setup-body" inert={Boolean(removal) || captureActive}>
        {checkingBrowserTools && <p role="status">Checking selected browser tools…</p>}
        {screen === "your-space" && <>
          {draft?.selectionOrigin === "EXISTING_SETTINGS" && <p role="note">Your existing workspace choices are selected. Review unavailable tools before continuing; choosing a preset replaces this selection.</p>}
          <div className="first-setup-section"><h3>What will you use Space for?</h3><div className="first-setup-options">
            {personas.map((option) => <button key={option.id} type="button" aria-pressed={persona === option.id} onClick={() => selectPreset(option.id, level)}><strong>{option.label}</strong><span>{option.description}</span></button>)}
          </div></div>
          <div className="first-setup-section"><h3>How much would you like to start with?</h3><div className="first-setup-options">
            {levels.map((option) => <button key={option.id} type="button" aria-pressed={level === option.id} onClick={() => selectPreset(persona, option.id)}><strong>{option.label}</strong><span>{option.description}</span></button>)}
          </div></div>
          {undoPreset && <button type="button" onClick={() => {
            setPersona(undoPreset.persona); setLevel(undoPreset.level); setRequested(undoPreset.requested); setUndoPreset(null);
          }}>Undo preset change</button>}
          <div className="first-setup-section first-setup-preview"><div><h3>Your starting tools</h3><p>{requested.length} selected · OpenCode is your first free assistant.</p>
            <p>Auto — best free{freeModel ? ` · Currently verified: ${freeModel}` : " · Runtime verification pending"}</p>
          </div><button type="button" onClick={() => setExploring(!exploring)}>{exploring ? "Hide all tools" : "Explore all tools"}</button></div>
          {freeModels.length > 0 && <details className="first-setup-section"><summary>Free model choices</summary>
            <p>Only a model that completed a tool call without an account can be selected. Models that failed remain visible for review.</p>
            {!freeModelSelectable && <p>Choosing a model needs a newer OpenCode setup on this installation. Auto — best free is used.</p>}
            <label>Free model choice<select aria-label="Free model choice" value={modelChoice} disabled={pending || !client.selectSetupFreeModel || !freeModelSelectable}
              onChange={(event) => void chooseFreeModel(event.target.value)}>
              <option value="auto">Auto — best free</option>
              {freeModels.map((model) => <option key={model.id} value={model.id} disabled={!model.anonymousAvailable}>
                {model.id} · {model.anonymousAvailable ? "verified, no account required" : "account-free access not verified"}
              </option>)}
            </select></label>
            <ul>{freeModels.map((model) => <li key={model.id}>{model.id}: {model.setupPassed}/2 setup checks passed · {model.latencyMs} ms</li>)}</ul>
          </details>}
          {exploring && <div className="first-setup-tools"><label>Search tools<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search docks, panes, widgets and agents" /></label>
            {visibleFeatures.map((feature) => <article key={feature.id} className="first-setup-tool">
              <SpaceToggle label={feature.label} ariaLabel={feature.label} checked={selected.includes(feature.id)}
                disabled={feature.requiredForFirstSetup ||
                  (!selected.includes(feature.id) && (feature.availability === "UNAVAILABLE" || feature.availability === "FORBIDDEN"))}
                onChange={(checked) => { if (checked) { setUndoPreset(null); setRequested(current => [...current, feature.id]); } else requestRemoval(feature.id); }} />
              <p>{feature.description}</p><details><summary>What this tool does</summary>
                <p>{feature.details}</p>
                {feature.id === "pane:live" && <p>Supported providers: {getAllLiveAudioProviders().map((provider) => provider.displayName).join(", ")}. Choose a compatible model and voice. Cloud use may be billed.</p>}
                {feature.connectionRequirements.length > 0 && <p>Needs: {feature.connectionRequirements.map((requirement) => connectionLabels[requirement] ?? requirement.replaceAll("-", " ")).join("; ")}.</p>}
                {feature.dependencies.length > 0 && <p>Also needs: {feature.dependencies.map((dependency) => catalog.find((item) => item.id === dependency)?.label ?? dependency).join(", ")}.</p>}
                <p>{feature.dataUse}</p><p>Cost: {feature.costClass.toLowerCase().replaceAll("_", " ")}.</p>
                {feature.reasonCode && <p>{feature.reasonCode === "HARNESS_SETUP_UNSUPPORTED"
                  ? "Automatic setup cannot safely test this Harness runtime yet. It is excluded from Full."
                  : feature.reasonCode === "AGENT_SETUP_CHECK_UNSUPPORTED"
                    ? "Automatic setup cannot safely verify this agent yet. It remains available through its normal CLI flow."
                    : "This tool cannot be verified on this installation yet."}</p>}
              </details>
            </article>)}
          </div>}
          {liveSelected && <p className="first-setup-live-note">Choose a Live provider in Connections. A compatible model, voice, API access and microphone test will be required.</p>}
        </>}
        {screen === "connections" && <div className="first-setup-section"><h3>Only your selected connections</h3>
          {liveSelected && voiceClient && <SetupVoiceConnection client={voiceClient} onChoice={saveVoiceChoice}
            onCheckAudio={client.startSetupVoiceCheck ? checkVoiceAudio : undefined}
            initialChoice={draft?.connectionChoices.find((choice) => choice.featureId === "pane:live")} />}
          {liveSelected && <button type="button" disabled={pending} onClick={() => void skipLive()}>Skip Live for now</button>}
          {selected.includes("utility:snip") && captureClient && draft?.revision !== null && draft?.revision !== undefined &&
            <SetupCaptureCheck client={captureClient} draftRevision={draft.revision} onVerified={captureVerified}
              onActiveChange={setCaptureActive} portalTarget={dialogRef.current} />}
          {plan?.requiredHumanInputs.filter((input) => input.featureId !== "pane:live" || !voiceClient).map((input) => {
            const feature = catalog.find((item) => item.id === input.featureId);
            const connectionId = input.featureId.startsWith("agent:") ? `cli:${input.featureId.slice(6)}` : null;
            return <div className="first-setup-connection" key={`${input.featureId}:${input.kind}`}>
              <strong>{feature?.label ?? input.featureId}</strong>
              <p>{input.kind === "PROVIDER_LOGIN" ? "Sign in with the provider account for this selected agent, then verify a real response." :
                input.kind === "API_CREDENTIAL" ? "This selected tool needs a provider credential and a live check before it can be enabled." :
                input.kind === "MICROPHONE" ? "Live audio needs a microphone and playback test after its provider is connected." :
                "This selected tool needs a permission or resource check before it can be enabled."}</p>
              {connectionId && <div className="first-setup-connection-actions">
                {onOpenAgentLogin && <button type="button" disabled={pending} onClick={() => void openAgentLogin(connectionId)}>Connect {feature?.label ?? "agent"}</button>}
                {client.verifySetupConnection && <button type="button" disabled={pending} onClick={() => void checkAgent(connectionId)}>Check connection</button>}
              </div>}
              {!connectionId && serviceClient && ["pane:databases", "pane:vnc", "pane:harness", "dock:streaming"].includes(input.featureId) &&
                <SetupServiceConnection client={serviceClient} featureId={input.featureId} label={feature?.label ?? "Service"}
                  initialChoice={draft?.connectionChoices.find(choice => choice.featureId === input.featureId)?.modelId}
                  onCheck={choiceId => checkSelectedService(input.featureId, choiceId)} />}
              {!connectionId && <button type="button" disabled={pending} onClick={() => requestRemoval(input.featureId)}>Remove {feature?.label ?? "tool"}</button>}
            </div>;
          })}
          <button type="button" onClick={() => setScreen("your-space")}>Change tools</button>
        </div>}
        {screen === "setting-up" && <div className="first-setup-section" aria-live="polite"><h3>Checking your Space</h3>
          <p>Only verified tasks can finish setup. You can close this window and return later.</p>
          {snapshot?.tasks.map((task) => <div key={task.id} className="first-setup-task"><span>{catalog.find((feature) => feature.id === task.featureId)?.label ?? task.featureId}
            {task.status === "NEEDS_ATTENTION" && <small>{taskFailureMessage(task.errorCode, task)}</small>}
          </span><strong>{task.status === "NEEDS_ATTENTION" ? "Needs attention" : task.status.toLowerCase()}</strong></div>)}
          {snapshot?.run.status === "FAILED" && <p>One or more selected tools need attention. Review the task and retry after fixing its connection.</p>}
          {snapshot?.run.status === "FAILED" && snapshot.tasks.some((task) => task.status === "NEEDS_ATTENTION" && task.errorCode !== "LEASE_EXPIRED_RECONCILE") &&
            <button type="button" disabled={pending} onClick={() => void retryFailed()}>Retry failed step</button>}
          {snapshot?.run.status === "FAILED" && client.reconcileSetupTask && snapshot.tasks.filter((task) =>
            task.status === "NEEDS_ATTENTION" && task.errorCode === "LEASE_EXPIRED_RECONCILE"
          ).map((task) => <button key={task.id} type="button" disabled={pending}
            onClick={() => void reconcileInterrupted(task.id)}>Check interrupted step</button>)}
          {snapshot?.run.status === "RUNNING" && client.pauseSetupRun &&
            <button type="button" disabled={pending} onClick={() => void changeRunActivity("pause")}>Pause setup</button>}
          {snapshot?.run.status === "PAUSED" && client.resumeSetupRun &&
            <button type="button" disabled={pending} onClick={() => void changeRunActivity("resume")}>Resume setup</button>}
          {snapshot && ["FAILED", "READY"].includes(snapshot.run.status) && !confirmed &&
            <button type="button" disabled={pending} onClick={() => {
              setError(null); setScreen("your-space");
            }}>Change tools</button>}
          <button type="button" onClick={() => snapshot && plan && void refresh(snapshot.run.id, plan)}>Refresh status</button>
        </div>}
        {screen === "ready" && confirmed && <div className="first-setup-section"><h3>Your Space is ready</h3><p>Every selected setup task passed its current server check.</p></div>}
        <SetupAssistantHelp ask={client.askSetupAssistant} />
        {error && <p className="first-setup-error" role="alert">{error}</p>}
      </div>
      <footer className="first-setup-footer" inert={Boolean(removal) || captureActive}><span>{screen === "setting-up" ? "Progress is saved on the server." : "You can change your choices later in Settings."}</span>
        {screen === "your-space" && <button type="button" disabled={!draft || pending} onClick={() => void begin()}>{pending ? "Preparing…" : "Set up my Space"}</button>}
        {screen === "ready" && confirmed && <button type="button" onClick={() => onOpenChange(false)}>Open Space</button>}
      </footer>
      {removal && <div className="first-setup-confirm-overlay"><div ref={removalRef} className="first-setup-confirm" role="alertdialog" aria-modal="true" aria-labelledby="setup-remove-title" aria-describedby="setup-remove-description">
        <h3 id="setup-remove-title">Remove connected tools?</h3>
        <p id="setup-remove-description">Removing {catalog.find(feature => feature.id === removal)?.label} also removes {requested.filter(id => id !== removal && !removeSetupFeature(requested, removal).includes(id)).map(id => catalog.find(feature => feature.id === id)?.label).join(", ")}.</p>
        <button type="button" onClick={() => setRemoval(null)}>Keep tools</button>
        <button type="button" onClick={() => { setRequested(current => removeSetupFeature(current, removal)); setUndoPreset(null); setRemoval(null); setScreen("your-space"); }}>Remove tools</button>
      </div></div>}
    </section>
  </div>;
}
