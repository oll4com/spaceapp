import {
  setupConnectionCheckEventSchema,
  setupConnectionCheckRunSchema,
  setupOverviewSchema,
  type SetupConnection,
  type SetupConnectionCheckEvent,
  type SetupConnectionCheckReplay,
  type SetupConnectionCheckRun,
  type SetupOverview
} from "@space/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";
import { useAutoDismiss } from "../../use-auto-dismiss.js";

const activeRunStorageKey = "space.setupConnections.activeRunId.v1";

export interface SetupConnectionChecksClient {
  startSetupConnectionChecks(): Promise<SetupConnectionCheckRun>;
  startSetupConnectionCheck(connectionId: string): Promise<SetupConnectionCheckRun>;
  getSetupConnectionCheckReplay(
    runId: string,
    afterSequence?: number
  ): Promise<SetupConnectionCheckReplay>;
  openSetupConnectionCheckStream(
    runId: string,
    afterSequence?: number
  ): EventSource | null;
}

interface UseSetupConnectionsWizardOptions {
  checks: SetupConnectionChecksClient;
  finish: () => Promise<SetupOverview>;
  loadOverview: () => Promise<SetupOverview>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  openLogin: (connectionId: string) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  replayIntervalMs: number;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

function focusableButtons(container: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function readActiveRunId(): string | null {
  try {
    return window.sessionStorage.getItem(activeRunStorageKey);
  } catch {
    return null;
  }
}

function saveActiveRun(run: SetupConnectionCheckRun): void {
  try {
    if (run.status === "RUNNING") {
      window.sessionStorage.setItem(activeRunStorageKey, run.id);
    } else if (window.sessionStorage.getItem(activeRunStorageKey) === run.id) {
      window.sessionStorage.removeItem(activeRunStorageKey);
    }
  } catch {
    // Session storage is an optimization; durable replay remains authoritative.
  }
}

function clearActiveRun(runId?: string): void {
  try {
    if (!runId || window.sessionStorage.getItem(activeRunStorageKey) === runId) {
      window.sessionStorage.removeItem(activeRunStorageKey);
    }
  } catch {
    // Session storage is optional.
  }
}

function mergeEvents(
  current: SetupConnectionCheckEvent[],
  incoming: SetupConnectionCheckEvent[]
): SetupConnectionCheckEvent[] {
  const bySequence = new Map(current.map((event) => [event.sequence, event]));
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function summaryFor(connections: SetupConnection[]): SetupOverview["summary"] {
  const functional = connections.filter((connection) =>
    connection.functionalState === "FUNCTIONAL"
  ).length;
  return {
    total: connections.length,
    functional,
    liveVerified: connections.filter((connection) =>
      connection.liveVerificationState === "VERIFIED"
    ).length,
    needsSetup: connections.length - functional
  };
}

function applyCompletedEvent(
  overview: SetupOverview,
  event: SetupConnectionCheckEvent
): SetupOverview {
  if (
    event.state !== "COMPLETED" ||
    !event.functionalState ||
    !event.liveVerificationState
  ) {
    return overview;
  }
  const functionalState = event.functionalState;
  const liveVerificationState = event.liveVerificationState;
  const connections = overview.connections.map((connection) => {
    if (connection.id !== event.connectionId) return connection;
    return {
      ...connection,
      state: functionalState === "FUNCTIONAL"
        ? "CONNECTED" as const
        : functionalState,
      functionalState,
      liveVerificationState,
      reasonCode: event.reasonCode
    };
  });
  return {
    ...overview,
    summary: summaryFor(connections),
    connections
  };
}

function parseEventData(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

export function useSetupConnectionsWizard({
  checks,
  finish,
  loadOverview,
  onOpenChange,
  open,
  openLogin,
  pollIntervalMs,
  pollTimeoutMs,
  replayIntervalMs,
  triggerRef
}: UseSetupConnectionsWizardOptions) {
  const [overview, setOverview] = useState<SetupOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [checkAllPending, setCheckAllPending] = useState(false);
  const [finishPending, setFinishPending] = useState(false);
  const [waitingConnectionId, setWaitingConnectionId] = useState<string | null>(null);
  const [checkRun, setCheckRun] = useState<SetupConnectionCheckRun | null>(null);
  const [checkEvents, setCheckEvents] = useState<SetupConnectionCheckEvent[]>([]);
  const [clock, setClock] = useState(() => Date.now());
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeIntentRef = useRef<"dismissal" | "login">("dismissal");
  const latestSequenceRef = useRef(0);
  const checkRunRef = useRef<SetupConnectionCheckRun | null>(null);
  const terminalRunRef = useRef<SetupConnectionCheckRun | null>(null);
  const actionsRef = useRef({ checks, loadOverview, onOpenChange });
  actionsRef.current = { checks, loadOverview, onOpenChange };
  checkRunRef.current = checkRun;

  useAutoDismiss(error, setError);
  useAutoDismiss(notice, setNotice);
  useAutoDismiss(streamNotice, setStreamNotice);

  const applyReplay = useCallback((next: SetupConnectionCheckReplay) => {
    terminalRunRef.current = null;
    latestSequenceRef.current = Math.max(
      latestSequenceRef.current,
      next.events.at(-1)?.sequence ?? 0
    );
    setCheckEvents((current) => mergeEvents(current, next.events));
    setCheckRun(next.run);
    setOverview(next.overview);
    saveActiveRun(next.run);
    if (next.run.status === "COMPLETED") {
      setStreamNotice(null);
    }
  }, []);

  const applyProgressEvent = useCallback((event: SetupConnectionCheckEvent) => {
    latestSequenceRef.current = Math.max(latestSequenceRef.current, event.sequence);
    setCheckEvents((current) => mergeEvents(current, [event]));
    setOverview((current) => current ? applyCompletedEvent(current, event) : current);
  }, []);

  const applyRun = useCallback((run: SetupConnectionCheckRun) => {
    setCheckRun(run);
    saveActiveRun(run);
    if (run.status === "COMPLETED") setStreamNotice(null);
  }, []);

  async function refreshOverview() {
    setLoading(true);
    setError(null);
    try {
      setOverview(await loadOverview());
    } catch (cause) {
      setError(errorMessage(cause, "Setup connections could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await actionsRef.current.loadOverview();
        if (disposed) return;
        setOverview(loaded);
        const activeRunId = checkRunRef.current?.status === "RUNNING"
          ? checkRunRef.current.id
          : readActiveRunId();
        if (activeRunId) {
          try {
            const recovered = await actionsRef.current.checks.getSetupConnectionCheckReplay(
              activeRunId,
              latestSequenceRef.current
            );
            if (!disposed) applyReplay(recovered);
          } catch {
            clearActiveRun(activeRunId);
            if (!disposed) {
              setStreamNotice("The previous CLI check is no longer active. Start a new check when ready.");
            }
          }
        }
      } catch (cause) {
        if (!disposed) {
          setError(errorMessage(cause, "Setup connections could not be loaded."));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus());
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
    };
  }, [applyReplay, open]);

  useEffect(() => {
    if (!waitingConnectionId) return;
    let disposed = false;
    const startedAt = Date.now();
    let timer = 0;

    async function poll() {
      try {
        const next = await actionsRef.current.loadOverview();
        if (disposed) return;
        setOverview(next);
        const connection = next.connections.find((item) => item.id === waitingConnectionId);
        if (connection?.functionalState === "FUNCTIONAL") {
          setWaitingConnectionId(null);
          setNotice(`${connection.label} is functional. Continue with the next tool when you are ready.`);
          actionsRef.current.onOpenChange(true);
          return;
        }
      } catch {
        // Temporary API failures should not interrupt an in-progress terminal login.
      }
      if (Date.now() - startedAt >= pollTimeoutMs) {
        setWaitingConnectionId(null);
        setError("Login is still not functional. Reopen the terminal or retry the connection.");
        actionsRef.current.onOpenChange(true);
        return;
      }
      timer = window.setTimeout(poll, pollIntervalMs);
    }

    timer = window.setTimeout(poll, pollIntervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [pollIntervalMs, pollTimeoutMs, waitingConnectionId]);

  useEffect(() => {
    if (open || closeIntentRef.current !== "dismissal") return;
    const frame = window.requestAnimationFrame(() => triggerRef?.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, triggerRef]);

  useEffect(() => {
    if (!checkRun || checkRun.status !== "RUNNING") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [checkRun?.id, checkRun?.status]);

  useEffect(() => {
    if (!checkRun || checkRun.status !== "RUNNING") return;
    const source = checks.openSetupConnectionCheckStream(
      checkRun.id,
      latestSequenceRef.current
    );
    if (!source) {
      setStreamNotice("Live progress is unavailable; durable replay remains active.");
      return;
    }

    const handleReady = () => setStreamNotice(null);
    const handleProgress = (event: Event) => {
      const parsed = setupConnectionCheckEventSchema.safeParse(parseEventData(event));
      if (parsed.success) applyProgressEvent(parsed.data);
    };
    const handleRun = (event: Event) => {
      const parsed = setupConnectionCheckRunSchema.safeParse(parseEventData(event));
      if (!parsed.success) return;
      if (parsed.data.status === "COMPLETED") {
        terminalRunRef.current = parsed.data;
        return;
      }
      applyRun(parsed.data);
    };
    const handleOverview = (event: Event) => {
      const parsed = setupOverviewSchema.safeParse(parseEventData(event));
      if (!parsed.success) return;
      setOverview(parsed.data);
      if (terminalRunRef.current) {
        applyRun(terminalRunRef.current);
        terminalRunRef.current = null;
      }
    };
    const handleReconnect = () => {
      setStreamNotice("Live progress is reconnecting; durable replay will recover any missed stages.");
    };
    const handleStreamError = () => {
      setStreamNotice("Live progress paused; durable replay remains active.");
      source.close();
    };

    source.addEventListener("ready", handleReady);
    source.addEventListener("progress", handleProgress);
    source.addEventListener("run", handleRun);
    source.addEventListener("overview", handleOverview);
    source.addEventListener("stream-error", handleStreamError);
    source.addEventListener("error", handleReconnect);
    return () => source.close();
  }, [
    applyProgressEvent,
    applyRun,
    checkRun?.id,
    checkRun?.status,
    checks
  ]);

  useEffect(() => {
    if (!checkRun || checkRun.status !== "RUNNING") return;
    const timer = window.setInterval(() => {
      void checks.getSetupConnectionCheckReplay(
        checkRun.id,
        latestSequenceRef.current
      ).then(applyReplay).catch(() => {
        setStreamNotice("Live progress is reconnecting; durable replay remains available.");
      });
    }, replayIntervalMs);
    return () => window.clearInterval(timer);
  }, [
    applyReplay,
    checkRun?.id,
    checkRun?.status,
    checks,
    replayIntervalMs
  ]);

  function dismiss() {
    closeIntentRef.current = "dismissal";
    onOpenChange(false);
  }

  function updatePending(connectionId: string, pending: boolean) {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(connectionId);
      else next.delete(connectionId);
      return next;
    });
  }

  async function connect(connection: SetupConnection) {
    updatePending(connection.id, true);
    setError(null);
    setNotice(null);
    try {
      await openLogin(connection.id);
      setNotice(`Complete login in the ${connection.label} terminal. Space will detect the credential automatically.`);
      closeIntentRef.current = "login";
      setWaitingConnectionId(connection.id);
      onOpenChange(false);
    } catch (cause) {
      setNotice(null);
      setError(errorMessage(cause, `Could not open ${connection.label} login.`));
    } finally {
      updatePending(connection.id, false);
    }
  }

  async function activateRun(run: SetupConnectionCheckRun) {
    if (checkRunRef.current?.id !== run.id) {
      terminalRunRef.current = null;
      latestSequenceRef.current = 0;
      setCheckEvents([]);
    }
    applyRun(run);
    try {
      const next = await checks.getSetupConnectionCheckReplay(run.id, 0);
      applyReplay(next);
    } catch {
      setStreamNotice("The CLI check started; live progress is reconnecting through durable replay.");
    }
  }

  async function checkConnection(connection: SetupConnection) {
    updatePending(connection.id, true);
    setError(null);
    try {
      await activateRun(await checks.startSetupConnectionCheck(connection.id));
    } catch (cause) {
      setError(errorMessage(cause, `Could not check ${connection.label}.`));
    } finally {
      updatePending(connection.id, false);
    }
  }

  async function checkAll() {
    setCheckAllPending(true);
    setError(null);
    try {
      await activateRun(await checks.startSetupConnectionChecks());
    } catch (cause) {
      setError(errorMessage(cause, "CLI checks could not be started."));
    } finally {
      setCheckAllPending(false);
    }
  }

  async function finishNow() {
    setFinishPending(true);
    setError(null);
    try {
      setOverview(await finish());
      setWaitingConnectionId(null);
      dismiss();
    } catch (cause) {
      setError(errorMessage(cause, "Setup progress could not be saved."));
    } finally {
      setFinishPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !finishPending) {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = focusableButtons(dialogRef.current);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    const activeElement = document.activeElement;
    if (
      event.shiftKey &&
      (
        activeElement === first ||
        activeElement === headingRef.current ||
        !dialogRef.current?.contains(activeElement)
      )
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (activeElement === last || !dialogRef.current?.contains(activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  const elapsedSeconds = checkRun
    ? Math.max(
        0,
        Math.floor(
          (
            (checkRun.finishedAt ? Date.parse(checkRun.finishedAt) : clock) -
            Date.parse(checkRun.createdAt)
          ) / 1_000
        )
      )
    : 0;

  return {
    checkAll,
    checkAllPending,
    checkConnection,
    checkEvents,
    checkRun,
    connect,
    dialogRef,
    dismiss,
    dismissError: () => setError(null),
    dismissNotice: () => setNotice(null),
    dismissStreamNotice: () => setStreamNotice(null),
    elapsedSeconds,
    error,
    finishNow,
    finishPending,
    handleKeyDown,
    headingRef,
    loading,
    notice,
    overview,
    pendingIds,
    refreshOverview,
    streamNotice,
    waitingConnectionId
  };
}
