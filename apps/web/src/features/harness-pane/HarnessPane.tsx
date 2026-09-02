import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";

interface HarnessPaneProps {
  pane: Pane;
  workspaceTextSize: number;
}

export function HarnessPane({ pane, workspaceTextSize }: HarnessPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const [health, setHealth] = useState<{ ok: boolean; status: number } | null>(null);
  const [checking, setChecking] = useState(true);
  const [frameRevision, setFrameRevision] = useState(0);

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "HarnessPane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "HarnessPane",
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    };
  }, [pane.id, pane.mode, pane.title]);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      setChecking(true);
      try {
        const result = await api.harnessHealth();
        if (!cancelled) setHealth({ ok: result.ok, status: result.status });
      } catch {
        if (!cancelled) setHealth({ ok: false, status: 0 });
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    void check();
    const interval = window.setInterval(() => void check(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pane.id]);

  useEffect(() => () => {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
  }, []);

  function handleFrameLoad() {
    if (watchdogRef.current !== null) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      const frameWindow = iframeRef.current?.contentWindow as (Window & {
        __ModuleLoader__?: { mode?: string };
      }) | null;
      const frameDocument = iframeRef.current?.contentDocument;
      const loaderLive = frameWindow?.__ModuleLoader__?.mode === "live";
      const loadingPlugins = frameDocument?.body?.innerText.includes("Loading plugins...") === true;
      if (!loaderLive && loadingPlugins && frameRevision === 0) {
        setFrameRevision((revision) => revision + 1);
      }
    }, 10_000);
  }

  const healthy = health?.ok === true;

  return (
    <section
      className="harness-pane"
      aria-label={`Native harness ${pane.title}`}
      data-harness-pane-id={pane.id}
      data-harness-health={healthy ? "ok" : "down"}
      data-workspace-text-size={workspaceTextSize}
      style={{ "--harness-workspace-text-size": `${workspaceTextSize}px` } as CSSProperties}
    >
      {!healthy ? (
        <div className="pane-copy harness-pane-status" role="status">
          <span className={`pill ${checking ? "pending" : "down"}`}>
            {checking ? "Checking" : "Unavailable"}
          </span>
          <p>
            {checking
              ? "Checking Harness upstream…"
              : health?.status === 404
                ? "The Harness pane is disabled."
                : "The Harness upstream is unreachable. Start the Harness service to continue."}
          </p>
        </div>
      ) : (
        <iframe
          key={frameRevision}
          ref={iframeRef}
          className="harness-pane-frame"
          title={`Harness ${pane.title}`}
          src={`${api.harnessUrl}?spacePane=${encodeURIComponent(pane.id)}&frame=${frameRevision}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          onLoad={handleFrameLoad}
        />
      )}
    </section>
  );
}
