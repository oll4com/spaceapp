import { useEffect, useRef } from "react";
import type { BrowserFrame, PaneBrowserSessionResponse } from "@space/contracts";
import { api, type BrowserControlLeasePayload } from "../../api.js";

interface GoogleAccountSignInOptions {
  paneId: string;
  targetUrl: string | null | undefined;
  session: PaneBrowserSessionResponse["session"] | null;
  enabled: boolean;
  acquireControl(): Promise<BrowserControlLeasePayload | null>;
  onFrame(frame: BrowserFrame | null): void;
  onError(message: string): void;
}

// Browser and YouTube must use the same page-readiness and input sequence.
export function useGoogleAccountSignIn(options: GoogleAccountSignInOptions) {
  const { paneId, targetUrl, session, enabled } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const continuedSession = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !targetUrl || !session || session.status !== "READY" || continuedSession.current === session.sessionId) return;
    const isIdentifier = (url: string | null) => {
      try {
        const selected = new URL(targetUrl);
        const current = new URL(url ?? "about:blank");
        return selected.origin === "https://accounts.google.com" && selected.searchParams.has("Email")
          && current.origin === selected.origin && /\/signin\/identifier(?:$|\/)|^\/ServiceLogin$/.test(current.pathname);
      } catch { return false; }
    };
    if (!isIdentifier(session.currentUrl)) return;
    let disposed = false;
    // Google hydrates and focuses the prefilled identifier after navigation.
    // Recheck after that settles; passwords and MFA stay under user control.
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const fresh = await api.browserSession(paneId);
        if (disposed || fresh.session.sessionId !== session.sessionId || fresh.session.status !== "READY" || !isIdentifier(fresh.session.currentUrl)) return;
        const lease = await callbacks.current.acquireControl();
        if (disposed || !lease) return;
        continuedSession.current = session.sessionId;
        const next = await api.browserInput(paneId, { type: "KEY", eventType: "keyDown", key: "Enter", code: "Enter", text: "\r", modifiers: 0, leaseId: lease.leaseId });
        await api.browserInput(paneId, { type: "KEY", eventType: "keyUp", key: "Enter", code: "Enter", modifiers: 0, leaseId: lease.leaseId });
        if (!disposed) callbacks.current.onFrame(next.frame);
      } catch (cause) {
        if (!disposed) callbacks.current.onError(cause instanceof Error ? cause.message : "Google sign-in could not continue.");
      }
    })(); }, 1000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [paneId, targetUrl, session?.sessionId, session?.status, session?.currentUrl, enabled]);
}
