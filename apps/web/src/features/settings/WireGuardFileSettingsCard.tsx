import { useEffect, useState } from "react";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { SettingsLabel } from "./SettingsLabel.js";

export interface WireGuardFileStatus {
  set: boolean;
  active: boolean;
  lastError: string | null;
}

interface WireGuardBridge {
  status: () => Promise<WireGuardFileStatus>;
  choose: () => Promise<WireGuardFileStatus>;
  remove: () => Promise<WireGuardFileStatus>;
}

/** The SpaceApp desktop bridge's WireGuard actions; null in a browser or a desktop build older than 0.1.28. */
export function desktopWireGuardBridge(): WireGuardBridge | null {
  const bridge = typeof window !== "undefined" ? (window as { spaceDesktop?: { wireGuard?: WireGuardBridge } }).spaceDesktop : undefined;
  return typeof bridge?.wireGuard?.status === "function" ? bridge.wireGuard : null;
}

/** Settings › Accounts & connections › WireGuard file: the desktop app's own tunnel file (its menu bar is hidden on Windows). */
export function WireGuardFileSettingsCard({ bridge }: { bridge: WireGuardBridge }) {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  const [status, setStatus] = useState<WireGuardFileStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    bridge.status().then((next) => { if (live) setStatus(next); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [bridge]);

  async function run(action: () => Promise<WireGuardFileStatus>) {
    setPending(true);
    setError(null);
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const state = !status ? t("Loading…") : !status.set ? t("Not set: SpaceApp connects directly.") : status.active ? t("Set and connected.") : t("Set.");
  const problem = error ?? status?.lastError ?? null;
  return <section className="agent-settings-card settings-flat-card" aria-label={t("WireGuard file")}>
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <SettingsLabel label="WireGuard file" help="The desktop app's own WireGuard tunnel file: with one set, SpaceApp connects through that tunnel; without one, it connects directly.">
        <span data-wireguard-state={status ? (status.set ? "set" : "unset") : "loading"}>{state}</span>
      </SettingsLabel>
    </div>
    {problem ? <p className="settings-flat-note" role="alert">{t("Last error:")} {problem}</p> : null}
    <div className="settings-flat-actions">
      <button type="button" className="settings-flat-button" disabled={pending} onClick={() => void run(bridge.choose)}>{t("Choose WireGuard file…")}</button>
      {status?.set ? <button type="button" className="settings-flat-button" disabled={pending} onClick={() => void run(bridge.remove)}>{t("Remove")}</button> : null}
    </div>
  </section>;
}
