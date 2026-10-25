import { useEffect, useRef, useState } from "react";
import type { Pane, T3CodeServiceStatus } from "@space/contracts";
import { t3CodeSelectionMessageSchema } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { createT3SelectionChannel } from "./t3code-selection-channel.js";
import "./t3code-pane.css";

export interface T3CodePaneProps {
  pane: Pane;
  isVisible?: boolean;
}

type PaneState = "checking" | "ready" | "unavailable" | "disabled" | "forbidden" | "workspace";

// The pane origin and path are fixed by Space; the browser never chooses an
// upstream. The app inside is the authentic T3 Code web client.
export function t3CodeAppPath(paneId: string) {
  return `/api/t3code/panes/${paneId}/app/`;
}

function stateFromError(error: unknown): PaneState {
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: string } | null)?.code;
  if (code === "T3CODE_DISABLED") return "disabled";
  if (status === 401 || status === 403) return "forbidden";
  return "unavailable";
}

export function T3CodePane({ pane, isVisible = true }: T3CodePaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<PaneState>("checking");
  const [status, setStatus] = useState<T3CodeServiceStatus | null>(null);
  const [frameRevision, setFrameRevision] = useState(0);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  // Load the app only once the pane has actually been shown; afterwards keep
  // it mounted so minimizing or switching rooms does not reload the thread.
  const [frameRequested, setFrameRequested] = useState(isVisible && !pane.isMinimized);
  const [requestedAt, setRequestedAt] = useState<number | null>(() => (isVisible && !pane.isMinimized ? Date.now() : null));
  const shown = isVisible && !pane.isMinimized;

  useEffect(() => { if (shown) { setFrameRequested(true); setRequestedAt((at) => at ?? Date.now()); } }, [shown]);

  useEffect(() => {
    recordLifecycleDebugEvent({ type: "component_mounted", scope: "T3CodePane", detail: `pane=${pane.title}`, paneId: pane.id, paneMode: pane.mode });
    return () => {
      recordLifecycleDebugEvent({ type: "component_unmounted", scope: "T3CodePane", detail: `pane=${pane.title}`, paneId: pane.id, paneMode: pane.mode });
    };
  }, [pane.id, pane.mode, pane.title]);

  // Lazy health: check only until the service answers, then stop polling.
  usePanePolling(async (signal) => {
    try {
      const next = await api.t3CodeStatus(pane.id);
      if (signal.aborted) return;
      setStatus(next);
      setState(next.state === "ready" ? (next.workspaceAllowed ? "ready" : "workspace") : next.state === "disabled" ? "disabled" : "unavailable");
    } catch (error) {
      if (!signal.aborted) setState(stateFromError(error));
    }
  }, 15_000, frameRequested && state !== "ready" && state !== "forbidden" && state !== "workspace", true, `${pane.id}:${frameRevision}`);

  // The app starts loading with the service check instead of after it. A pane
  // with its own folder waits for the check, which can refuse that folder.
  const optimistic = state === "checking" && !pane.cwd?.trim();
  const showFrame = frameRequested && (state === "ready" || optimistic);

  // Persist genuine upstream navigation for this pane only. Messages are
  // accepted from this iframe's window and this pane's binding generation.
  useEffect(() => {
    if (!showFrame) return;
    const origin = window.location.origin;
    let channel: ReturnType<typeof createT3SelectionChannel> | null = null;
    let channelGeneration: string | null = null;
    // Navigation posted while the binding is being read is replayed in order.
    let pendingGeneration: string | null = null;
    let buffered: MessageEvent[] = [];
    let disposed = false;
    const frameWindow = () => iframeRef.current?.contentWindow ?? null;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameWindow()) return;
      const parsed = t3CodeSelectionMessageSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.paneId !== pane.id) return;
      const message = parsed.data;
      if (message.type === "ready") {
        if (message.generation === channelGeneration || message.generation === pendingGeneration) return;
        pendingGeneration = message.generation;
        buffered = [];
        void api.t3CodeBinding(pane.id).then((binding) => {
          const metadata = binding.metadata;
          if (disposed || pendingGeneration !== message.generation) return;
          pendingGeneration = null;
          // Another tab opened this pane after this frame did: its navigation
          // can no longer be saved here, so say so instead of failing silently.
          if (!metadata || metadata.generation !== message.generation) {
            buffered = [];
            setSelectionError("T3_SELECTION_STALE");
            return;
          }
          channel?.dispose();
          channelGeneration = metadata.generation;
          setSelectionError(null);
          channel = createT3SelectionChannel({
            paneId: pane.id, generation: metadata.generation, origin, selection: metadata.selection,
            initialSequence: metadata.lastSequence, frameWindow,
            persist: async (input) => { await api.t3CodeSaveSelection(pane.id, input); },
            onApplied: () => setSelectionError(null),
            onError: (code) => setSelectionError(code)
          });
          const replay = buffered;
          buffered = [];
          for (const item of replay) void channel.receive(item);
        }).catch(() => { if (!disposed) setSelectionError("T3_SELECTION_SAVE_FAILED"); });
        return;
      }
      if (message.generation === pendingGeneration) { if (buffered.length < 32) buffered.push(event); return; }
      if (message.generation === channelGeneration) void channel?.receive(event);
    };
    window.addEventListener("message", onMessage);
    return () => { disposed = true; channel?.dispose(); window.removeEventListener("message", onMessage); };
  }, [pane.id, showFrame, frameRevision]);

  const retry = () => {
    setState("checking");
    setSelectionError(null);
    setFrameRevision((revision) => revision + 1);
  };

  return (
    <section
      className="t3code-pane"
      aria-label={`T3 Code ${pane.title}`}
      data-t3code-pane-id={pane.id}
      data-t3code-state={frameRequested ? state : "deferred"}
      data-t3code-runtime={status?.runtime?.runtimeId ?? undefined}
      data-t3code-requested-at={requestedAt ?? undefined}
    >
      {showFrame ? (
        <iframe
          key={frameRevision}
          ref={iframeRef}
          className="t3code-pane-frame"
          title={`T3 Code ${pane.title}`}
          src={t3CodeAppPath(pane.id)}
          allow="clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
        />
      ) : frameRequested ? (
        <div className="t3code-pane-status" role="status">
          <span className={`pill ${state === "checking" ? "pending" : "down"}`}>
            {state === "checking" ? "Checking" : state === "disabled" ? "Disabled" : state === "forbidden" || state === "workspace" ? "Restricted" : "Unavailable"}
          </span>
          <p>
            {state === "checking"
              ? "Connecting to T3 Code…"
              : state === "disabled"
                ? "T3 Code is turned off for this Space installation."
                : state === "forbidden"
                  ? "T3 Code is available to the Space owner account."
                  : state === "workspace"
                    ? "This pane's folder is outside the T3 Code workspace. Clear the pane folder to start with its own T3 Code project."
                    : "The T3 Code service is not responding. An ADMIN can start it in Settings → CLI Tools → T3 Code."}
          </p>
          {state === "unavailable" ? (
            <button type="button" className="t3code-pane-retry" onClick={retry}>Retry</button>
          ) : null}
        </div>
      ) : (
        <div className="t3code-pane-status" data-t3code-deferred="true" aria-hidden="true" />
      )}
      {showFrame && selectionError ? (
        <div className="t3code-pane-notice" role="status">
          <span>This pane could not save its T3 Code selection.</span>
          <button type="button" className="t3code-pane-retry" onClick={retry}>Reload</button>
        </div>
      ) : null}
    </section>
  );
}
