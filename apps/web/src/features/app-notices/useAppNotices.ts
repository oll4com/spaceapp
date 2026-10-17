import { useCallback, useEffect, useRef, useState } from "react";
import { SPACE_CLIPBOARD_NOTICE_EVENT } from "../clipboard-dock/clipboard-events.js";
import { readStoredSessionString, writeStoredSessionString } from "../../session-string-storage.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { connectorResultMessage } from "../agent-pane/connector-result.js";

// Workspace-wide notices: the Live debug toast, room watchdog alerts, clipboard and
// Clip Tool notices, the Google account link result and the storage warning.

const DISMISSED_STORAGE_WARNING_STORAGE_KEY = "space.dismissedStorageWarning";

export type LiveDebugTone = "info" | "success" | "error";
export interface LiveDebugToast { id: number; message: string; type: LiveDebugTone }
export interface WatchdogAlert { id: string; message: string; timestamp: string }

export interface AppNotices {
  liveDebugToast: LiveDebugToast | null;
  dismissLiveDebugToast: () => void;
  /** Logs every message; only errors show a toast for 4.5 seconds. */
  showLiveDebug: (message: string, type?: LiveDebugTone) => void;
  watchdogAlerts: WatchdogAlert[];
  /** Adds an alert unless one with the same id is shown. */
  addWatchdogAlert: (alert: WatchdogAlert) => void;
  dismissWatchdogAlert: (id: string) => void;
  clipboardNotice: string | null;
  setClipboardNotice: (notice: string | null) => void;
  clipToolNotice: string | null;
  setClipToolNotice: (notice: string | null) => void;
  accountNotice: string | null;
  setAccountNotice: (notice: string | null) => void;
  accountError: string | null;
  setAccountError: (error: string | null) => void;
  storageWarning: string;
  /** The warning stays dismissed for this tab until the server stops reporting it. */
  dismissedStorageWarning: string | null;
  /** Applies the server's storage warning; an empty warning clears the dismissal. */
  applyStorageWarning: (warning: string) => void;
  dismissStorageWarning: () => void;
}

export function useAppNotices(): AppNotices {
  const [liveDebugToast, setLiveDebugToast] = useState<LiveDebugToast | null>(null);
  const liveDebugTimerRef = useRef<number | null>(null);

  const showLiveDebug = useCallback((message: string, type: LiveDebugTone = "info") => {
    console.log(`[AI-Live-Debug][${type.toUpperCase()}] ${message}`);
    // Progress notes ("button tapped", "pane opened") stay in the console; only failures reach the screen.
    if (type !== "error") return;
    if (liveDebugTimerRef.current !== null) window.clearTimeout(liveDebugTimerRef.current);
    setLiveDebugToast({ id: Date.now(), message, type });
    liveDebugTimerRef.current = window.setTimeout(() => {
      setLiveDebugToast(null);
      liveDebugTimerRef.current = null;
    }, 4500);
  }, []);

  useEffect(() => {
    const ownerWindow = window;
    const handleDebug = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; type?: LiveDebugTone }>).detail;
      if (detail?.message) showLiveDebug(detail.message, detail.type || "info");
    };
    ownerWindow.addEventListener("space-live-debug", handleDebug);
    return () => {
      ownerWindow.removeEventListener("space-live-debug", handleDebug);
      if (liveDebugTimerRef.current !== null) {
        ownerWindow.clearTimeout(liveDebugTimerRef.current);
        liveDebugTimerRef.current = null;
      }
    };
  }, [showLiveDebug]);

  const [storageWarning, setStorageWarning] = useState<string>("");
  const [dismissedStorageWarning, setDismissedStorageWarning] = useState<string | null>(() =>
    readStoredSessionString(DISMISSED_STORAGE_WARNING_STORAGE_KEY)
  );
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [clipToolNotice, setClipToolNotice] = useState<string | null>(null);
  useAutoDismiss(clipToolNotice, setClipToolNotice);
  const [watchdogAlerts, setWatchdogAlerts] = useState<WatchdogAlert[]>([]);

  useEffect(() => {
    const handleWatchdogCustomEvent = (customEvent: globalThis.Event) => {
      const detail = (customEvent as CustomEvent<{ id?: string; message: string; timestamp?: string }>).detail;
      if (!detail?.message) return;
      const id = detail.id ?? `watchdog-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setWatchdogAlerts((current) => {
        if (current.some((item) => item.id === id)) return current;
        return [...current, { id, message: detail.message, timestamp: detail.timestamp ?? new Date().toISOString() }];
      });
    };
    window.addEventListener("space:room-watchdog-alert", handleWatchdogCustomEvent as EventListener);
    return () => {
      window.removeEventListener("space:room-watchdog-alert", handleWatchdogCustomEvent as EventListener);
    };
  }, []);

  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  useAutoDismiss(accountNotice, setAccountNotice);
  useAutoDismiss(accountError, setAccountError);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const googleLinked = params.get("googleLinked");
      const googleLinkError = params.get("googleLinkError");
      const connectorResult = connectorResultMessage(params.get("connector"), params.get("connectorFor"));
      if (connectorResult) {
        if (connectorResult.tone === "notice") setAccountNotice(connectorResult.text);
        else setAccountError(connectorResult.text);
        params.delete("connector");
        params.delete("connectorFor");
        const query = params.toString();
        window.history.replaceState({}, document.title, `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
      } else if (googleLinked === "true") {
        setAccountNotice("Google account linked. To save its browser sign-in, select it in a Browser or YouTube pane and choose “Sign in to selected account” once.");
        const nextUrl = window.location.pathname;
        window.history.replaceState({}, document.title, nextUrl);
      } else if (googleLinkError) {
        setAccountError(decodeURIComponent(googleLinkError));
        const nextUrl = window.location.pathname;
        window.history.replaceState({}, document.title, nextUrl);
      }
    } catch {
      // Ignore URL parsing errors
    }
  }, []);

  useEffect(() => {
    let dismissTimer: number | null = null;
    const handleClipboardNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message !== "string" || !detail.message.trim()) return;
      setClipboardNotice(detail.message);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => setClipboardNotice(null), 5_000);
    };
    window.addEventListener(SPACE_CLIPBOARD_NOTICE_EVENT, handleClipboardNotice);
    return () => {
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      window.removeEventListener(SPACE_CLIPBOARD_NOTICE_EVENT, handleClipboardNotice);
    };
  }, []);

  function applyStorageWarning(warning: string) {
    setStorageWarning(warning);
    if (!warning) {
      setDismissedStorageWarning(null);
      writeStoredSessionString(DISMISSED_STORAGE_WARNING_STORAGE_KEY, null);
    }
  }

  function dismissStorageWarning() {
    setDismissedStorageWarning(storageWarning);
    writeStoredSessionString(DISMISSED_STORAGE_WARNING_STORAGE_KEY, storageWarning);
  }

  return {
    liveDebugToast,
    dismissLiveDebugToast: () => setLiveDebugToast(null),
    showLiveDebug,
    watchdogAlerts,
    addWatchdogAlert: (alert) => setWatchdogAlerts((current) => {
      if (current.some((item) => item.id === alert.id)) return current;
      return [...current, alert];
    }),
    dismissWatchdogAlert: (id) => setWatchdogAlerts((current) => current.filter((item) => item.id !== id)),
    clipboardNotice,
    setClipboardNotice,
    clipToolNotice,
    setClipToolNotice,
    accountNotice,
    setAccountNotice,
    accountError,
    setAccountError,
    storageWarning,
    dismissedStorageWarning,
    applyStorageWarning,
    dismissStorageWarning
  };
}
