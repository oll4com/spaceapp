import { useCallback, useEffect, useRef, useState } from "react";
import { SPACE_CLIPBOARD_NOTICE_EVENT } from "../clipboard-dock/clipboard-events.js";
import { readStoredSessionString, writeStoredSessionString } from "../../session-string-storage.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { connectorResultMessage } from "../agent-pane/connector-result.js";
import { settlePairAfterStepUp } from "../auth/mobile-pair-resume.js";
import { runStepUpResume, takeStepUpResume } from "../auth/step-up-resume.js";
import { STEP_UP_MAIL_KEY } from "../auth/StepUpConfirm.js";
import { api } from "../../api.js";
import { takePasswordStepUp } from "../settings/LoginPasswordSettingsCard.js";
import { openSettingsSection } from "../settings/settings-section-request.js";

// Workspace-wide notices: the Live debug toast, room watchdog alerts, clipboard and
// Clip Tool notices, the Google account link result and the storage warning.

const DISMISSED_STORAGE_WARNING_STORAGE_KEY = "space.dismissedStorageWarning";

export type LiveDebugTone = "info" | "success" | "error";
export interface LiveDebugToast { id: number; message: string; type: LiveDebugTone }
export interface WatchdogAlert { id: string; message: string; timestamp: string }
// One banner per message: a room that keeps timing out shows its newest alert, not a growing stack.
const withWatchdogAlert = (current: WatchdogAlert[], alert: WatchdogAlert) =>
  current.some((item) => item.id === alert.id) ? current : [...current.filter((item) => item.message !== alert.message), alert];

export interface AppNotices {
  liveDebugToast: LiveDebugToast | null;
  dismissLiveDebugToast: () => void;
  /** Logs the message and shows it as a toast for 4.5 seconds. */
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
  // The toast's timer must not outlive the app: it set state on a torn-down tree (1.1.7 public CI, smoke test).
  useEffect(() => () => {
    if (liveDebugTimerRef.current !== null) window.clearTimeout(liveDebugTimerRef.current);
  }, []);

  useEffect(() => {
    const handleDebug = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; type?: LiveDebugTone }>).detail;
      if (detail?.message) showLiveDebug(detail.message, detail.type || "info");
    };
    window.addEventListener("space-live-debug", handleDebug);
    return () => window.removeEventListener("space-live-debug", handleDebug);
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
      setWatchdogAlerts((current) => withWatchdogAlert(current, { id, message: detail.message, timestamp: detail.timestamp ?? new Date().toISOString() }));
    };
    window.addEventListener("space:room-watchdog-alert", handleWatchdogCustomEvent as EventListener);
    return () => {
      window.removeEventListener("space:room-watchdog-alert", handleWatchdogCustomEvent as EventListener);
    };
  }, []);

  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  useAutoDismiss(accountNotice, setAccountNotice);
  // An error stays until closed: the Google step-up's refusal (what to turn on in Google's console) takes longer than 6 s to read.

  // The link from a "Confirm it is you" mail (StepUpConfirm, POST /api/auth/step-up/mail): it confirms this session; the tab that asked
  // hears it through localStorage and continues. The token leaves the address bar at once.
  useEffect(() => {
    const token = /^#space-step-up=([A-Za-z0-9_-]{32,})$/.exec(window.location.hash)?.[1];
    if (!token) return;
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    void Promise.resolve().then(() => api.stepUpWithMail(token)).then(() => {
      try { window.localStorage.setItem(STEP_UP_MAIL_KEY, String(Date.now())); } catch { /* storage off: the asking tab checks again on focus */ }
      setAccountNotice("Confirmed it is you for 5 minutes. Go back to the tab where you asked: it continues there.");
    }, (failure: unknown) => setAccountError(failure instanceof Error ? failure.message.replace(/^[A-Z_]+: /, "") : "That link did not work."));
  }, []);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const googleLinked = params.get("googleLinked");
      // A refused Google step-up (Settings > Account > Mobile app) comes back as mobileStepUpError: show its reason, as a link error.
      const googleLinkError = params.get("googleLinkError") ?? params.get("mobileStepUpError");
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
      } else if (params.get("mobileStepUp") === "ok") {
        // The Google step-up reloaded the page: Pair a phone started it, so Settings > Account opens and Mobile app pairs (mobile-pair-resume).
        const resume = takeStepUpResume();
        if (resume) {
          // Granting a link's scopes or answering a linked decision started it: that action runs now, within the step-up's 5 minutes.
          void runStepUpResume(resume).then(setAccountNotice, (failure: unknown) => setAccountError(failure instanceof Error ? failure.message : "That did not work."));
          if (resume.purpose === "link-scopes") window.setTimeout(() => openSettingsSection("account"), 0);
        } else if (takePasswordStepUp()) {
          setAccountNotice("Confirmed it is you for 5 minutes. Choose the new password in Settings > Login password.");
          window.setTimeout(() => openSettingsSection("password"), 0);
        } else if (settlePairAfterStepUp(true)) {
          setAccountNotice("Confirmed it is you. Settings > Account > Mobile app shows your pairing code.");
          window.setTimeout(() => openSettingsSection("account"), 0);
        } else {
          setAccountNotice("Confirmed it is you for 5 minutes. Press Pair a phone in Settings > Account > Mobile app.");
        }
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (googleLinkError) {
        if (params.has("mobileStepUpError")) { settlePairAfterStepUp(false); takePasswordStepUp(); takeStepUpResume(); }
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
    addWatchdogAlert: (alert) => setWatchdogAlerts((current) => withWatchdogAlert(current, alert)),
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
