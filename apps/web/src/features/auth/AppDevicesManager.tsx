import { useEffect, useState } from "react";
import { MOBILE_PAIRING_CONFIRM_MS, type AppDeviceSession } from "@space/contracts";
import { api } from "../../api.js";
import { NOTIFICATION_STREAM_EVENT } from "../notifications/useNotifications.js";

const APP_LABELS: Record<string, string> = { nous: "Nous app", spaceapp: "SpaceApp app" };
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Settings > Account > Devices (plan clipboard:VLBu2ge110ho step 4): the phone apps signed in to this account with their own device
 * session (30 days each), and Revoke for a lost or replaced phone. A phone paired over the mobile channel (Nous Pro 1b) only reads until it
 * is allowed here, within 10 minutes of pairing. The list is read when the card opens, again when a phone pairs or its wait ends (the
 * MOBILE_PAIRED card's stream event) and when the tab or window comes back (9/11: a list read at 02:13:59Z never showed the phone paired at
 * 02:15:46Z, so its 10 minutes ran out without an Allow button).
 */
export function AppDevicesManager() {
  const [devices, setDevices] = useState<AppDeviceSession[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    const read = () => void Promise.resolve().then(() => api.listAppDevices())
      .then((result) => { if (!disposed) { setDevices(result.devices); setNow(Date.now()); } }, () => { if (!disposed) setDevices((current) => current ?? []); });
    const onNotification = (event: Event) => { if ((event as CustomEvent<{ kind?: unknown } | undefined>).detail?.kind === "MOBILE_PAIRED") read(); };
    const onVisible = () => { if (!document.hidden) read(); };
    read();
    window.addEventListener(NOTIFICATION_STREAM_EVENT, onNotification);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      disposed = true;
      window.removeEventListener(NOTIFICATION_STREAM_EVENT, onNotification);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  // The minutes left to allow a waiting phone count down while one waits.
  const waiting = (devices ?? []).some((device) => device.paired && !device.paired.allowedAt && !device.revokedAt);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [waiting]);

  async function change(device: AppDeviceSession, action: "revoke" | "allow") {
    setPendingId(device.id);
    setError(null);
    try {
      const { device: changed } = await (action === "allow" ? api.allowAppDevice(device.id) : api.revokeAppDevice(device.id));
      setDevices((current) => (current ?? []).map((entry) => entry.id === changed.id ? changed : entry));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `The device could not be ${action === "allow" ? "allowed" : "revoked"}.`);
    } finally {
      setPendingId(null);
    }
  }

  const live = (devices ?? []).filter((device) => !device.revokedAt && Date.parse(device.expiresAt) > Date.now());
  return <section aria-label="Devices" className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <span className="settings-flat-row-copy"><strong>Devices</strong><small>Phone apps signed in to this account. Each sign-in lasts 30 days; revoke a lost or replaced phone.</small></span>
    </div>
    {devices !== null && live.length === 0 ? <p className="settings-flat-note">No phone app is signed in.</p> : null}
    {live.map((device) => {
      const label = `${APP_LABELS[device.app] ?? device.app} on ${device.deviceName}`;
      const paired = device.paired, held = paired && !paired.allowedAt;
      const left = Math.ceil((Date.parse(device.createdAt) + MOBILE_PAIRING_CONFIRM_MS - now) / 60_000);
      return <div className="settings-flat-row" key={device.id} style={paired ? { display: "flex", flexWrap: "wrap", gap: "0.5rem 0.75rem", alignItems: "center" } : { gridTemplateColumns: "minmax(0, 1fr) auto", gap: "0.75rem" }}>
        <span className="settings-flat-row-copy" style={{ minWidth: 0, flex: "1 1 12rem" }}>
          <strong>{label}</strong>
          <small>{!paired ? `Signed in ${day(device.createdAt)} · until ${day(device.expiresAt)}`
            : held ? `Paired ${day(device.createdAt)} · it only reads until you allow it; it asks to ${paired.requestedScopes.join(", ")} · ${left > 0 ? `${left} min left to allow` : "its 10 minutes to allow are up"}`
              : `Paired ${day(device.createdAt)} · may ${paired.scopes.join(", ")}${paired.decide ? " (decisions signed with a hardware key)" : ""} · until ${day(device.expiresAt)}`}</small>
        </span>
        {held ? <button type="button" className="button" disabled={pendingId !== null} aria-label={`Allow ${label}`} onClick={() => void change(device, "allow")}>Allow</button> : null}
        <button type="button" className="button" disabled={pendingId !== null} aria-label={`Revoke ${label}`} onClick={() => void change(device, "revoke")}>Revoke</button>
      </div>;
    })}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
