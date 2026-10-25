import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayClaudeApiKeyUse } from "@space/contracts";
import { recordAlarmEvent } from "../desktop-widgets/alarm-log-service.js";
import { playChime } from "../desktop-widgets/audio-chime.js";

/**
 * Watches whether Space Gateway sent a Claude request through the Claude API key (operator request 2026-10-13: the
 * key is paid per token and must serve only when every subscription account is out of quota). The ADMIN rail polls
 * the gateway's key account once a minute; the first poll that shows a newer `lastUsedAt` than the one already
 * announced raises the alert: a chime, an Alarm log entry, a browser notification when allowed, and a banner that
 * stays until dismissed. The announced time is kept in localStorage, so one use is announced once per browser.
 */
export const CLAUDE_API_KEY_ALERT_STORAGE_KEY = "space:claude-api-key:announced-use-at";
export const CLAUDE_API_KEY_ALERT_POLL_MS = 60_000;
/** A use older than this, seen for the first time (a fresh browser), is history rather than news. */
export const CLAUDE_API_KEY_ALERT_NEWS_MS = 24 * 3_600_000;
const alertRings = 3;

export interface ClaudeApiKeyAlertVerdict {
  /** Announce this use now. */
  alert: boolean;
  /** The use time to remember as announced (unchanged when nothing new happened). */
  announcedAt: string | null;
}

/** Decides whether a poll result is news: a use later than the one announced, and recent when nothing was announced yet. */
export function judgeClaudeApiKeyUse(use: GatewayClaudeApiKeyUse | null, announcedAt: string | null, nowMs: number): ClaudeApiKeyAlertVerdict {
  const lastUsedAt = use?.account?.lastUsedAt ?? null;
  if (!lastUsedAt) return { alert: false, announcedAt };
  const usedMs = Date.parse(lastUsedAt);
  if (!Number.isFinite(usedMs)) return { alert: false, announcedAt };
  if (announcedAt !== null) {
    const announcedMs = Date.parse(announcedAt);
    if (Number.isFinite(announcedMs) && usedMs <= announcedMs) return { alert: false, announcedAt };
    return { alert: true, announcedAt: lastUsedAt };
  }
  return { alert: nowMs - usedMs <= CLAUDE_API_KEY_ALERT_NEWS_MS, announcedAt: lastUsedAt };
}

export function readAnnouncedUse(storage: Pick<Storage, "getItem"> | null = localStorageOrNull()): string | null {
  try {
    const value = storage?.getItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY) ?? null;
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function writeAnnouncedUse(value: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = localStorageOrNull()): void {
  try {
    if (value === null) storage?.removeItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY);
    else storage?.setItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY, value);
  } catch {
    // Best-effort persistence.
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function agoText(value: string | null, nowMs: number): string {
  const ms = value ? nowMs - Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** The banner's text: how much went through the key and when it last did. */
export function claudeApiKeyAlertText(use: GatewayClaudeApiKeyUse, nowMs: number): string {
  const account = use.account;
  if (!account) return "Space Gateway served Claude requests through the Claude API key.";
  const cost = account.costUsd >= 0.005 ? ` ($${account.costUsd.toFixed(2)})` : "";
  return `Claude API key in use: Space Gateway sent ${account.requests} ${account.requests === 1 ? "request" : "requests"} through the paid key${cost}, `
    + `last ${agoText(account.lastUsedAt, nowMs)}. Every Claude account was out of quota; the accounts take over again at their reset.`;
}

/** Chime, Alarm log entry and (when allowed) a browser notification for a use of the key. */
export function raiseClaudeApiKeyAlert(use: GatewayClaudeApiKeyUse, options: { nowMs?: number; sound?: boolean; notify?: boolean } = {}): void {
  const nowMs = options.nowMs ?? Date.now();
  const text = claudeApiKeyAlertText(use, nowMs);
  recordAlarmEvent({
    triggerSource: "claude_api_key_fallback", provider: "claude", proOnly: false, availableCount: 0, totalCount: 0,
    availableAccounts: [], nextBack: null
  });
  if (options.sound ?? true) {
    let rings = 0;
    const ring = () => {
      try { playChime("pushup-alert"); } catch { /* No audio in this browser. */ }
      rings += 1;
      if (rings < alertRings) setTimeout(ring, 1000);
    };
    ring();
  }
  if ((options.notify ?? true) && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification("Claude API key in use", { body: text, tag: "space-claude-api-key-fallback" }); } catch { /* Blocked. */ }
  }
}

export interface ClaudeApiKeyFallbackWatch {
  use: GatewayClaudeApiKeyUse | null;
  /** The use to show in the banner; null once dismissed or when nothing was announced in this session. */
  banner: GatewayClaudeApiKeyUse | null;
  dismiss: () => void;
}

/**
 * Polls the gateway's Claude API key use while `enabled` and the page is visible, announcing each new use once.
 * One instance is enough; a second one on the same page shares the announced time through storage.
 */
export function useClaudeApiKeyFallbackWatch(input: {
  enabled: boolean;
  load: () => Promise<GatewayClaudeApiKeyUse>;
  pollMs?: number;
  now?: () => number;
}): ClaudeApiKeyFallbackWatch {
  const { enabled, load } = input;
  const pollMs = input.pollMs ?? CLAUDE_API_KEY_ALERT_POLL_MS;
  const nowRef = useRef(input.now ?? Date.now);
  nowRef.current = input.now ?? Date.now;
  const loadRef = useRef(load);
  loadRef.current = load;
  const [use, setUse] = useState<GatewayClaudeApiKeyUse | null>(null);
  const [banner, setBanner] = useState<GatewayClaudeApiKeyUse | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      inFlight = true;
      try {
        const result = await loadRef.current();
        if (disposed) return;
        setUse(result);
        const verdict = judgeClaudeApiKeyUse(result, readAnnouncedUse(), nowRef.current());
        if (verdict.announcedAt !== null) writeAnnouncedUse(verdict.announcedAt);
        if (verdict.alert) {
          raiseClaudeApiKeyAlert(result, { nowMs: nowRef.current() });
          setBanner(result);
        }
      } catch {
        // The next poll tries again; a missing answer is never an alert.
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), pollMs);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, pollMs]);

  const dismiss = useCallback(() => setBanner(null), []);
  return { use, banner, dismiss };
}
