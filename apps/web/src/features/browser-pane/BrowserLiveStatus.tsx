import { useEffect, useState, type RefObject } from "react";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

export function BrowserLiveStatus({ paneRef, sessionId, paused, handoff, compact = false }: {
  paneRef: RefObject<HTMLElement | null>; sessionId: string | null; paused: boolean; handoff: boolean; compact?: boolean;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [sample, setSample] = useState({ fps: 0, rtt: "", state: "idle", mode: "" });
  useEffect(() => {
    let previous = Number(paneRef.current?.dataset.browserPresentedFrames ?? 0);
    let startedAt = performance.now();
    setSample({ fps: 0, rtt: "", state: "idle", mode: "" });
    if (!sessionId) return;
    const timer = window.setInterval(() => {
      const data = paneRef.current?.dataset;
      const now = performance.now();
      const count = Number(data?.browserPresentedFrames ?? 0);
      setSample({ fps: Math.max(0, Math.round((count - previous) * 1000 / (now - startedAt))),
        rtt: now - Number(data?.browserInputRttAt ?? 0) < 5000 ? data?.browserInputRttMs ?? "" : "", state: data?.browserStreamState ?? "idle", mode: data?.browserStreamMode ?? "" });
      previous = count;
      startedAt = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [paneRef, sessionId]);
  const connected = sample.state === "ready" || sample.state === "legacy-ready";
  return <div className={`browser-live-status${compact ? " browser-live-status-compact" : ""}`} aria-label={t("Browser live performance")}
    title={`${handoff ? t("You have control") : t("Shared with room agents")}${sample.rtt ? ` · ${t("{ms} ms input", { ms: sample.rtt })}` : ""}`}>
    <span>{!sessionId ? t("Offline") : paused ? t("Paused") : connected ? t("Live") : sample.state === "silent" ? t("Silent") : t("Connecting")}</span>
    <span title={t("Actual rendered frames per second; Live targets up to 35. Static pages only send changed frames.")}>{t("{fps} fps", { fps: sample.fps })}</span>
    {!compact && sample.rtt ? <span title={t("Last input acknowledgement round trip")}>{t("{ms} ms input", { ms: sample.rtt })}</span> : null}
    {!compact ? <span>{handoff ? t("You have control") : t("Shared with room agents")}</span> : null}
  </div>;
}
