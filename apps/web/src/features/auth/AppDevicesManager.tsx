import { useEffect, useState } from "react";
import type { AppDeviceSession } from "@space/contracts";
import { api } from "../../api.js";

const APP_LABELS: Record<string, string> = { nous: "Nous app" };
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Settings > Account > Devices (plan clipboard:VLBu2ge110ho step 4): the phone apps signed in to this account with their own device
 * session (30 days each), and Revoke for a lost or replaced phone. Read once when the card opens; nothing runs in the background.
 */
export function AppDevicesManager() {
  const [devices, setDevices] = useState<AppDeviceSession[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    Promise.resolve().then(() => api.listAppDevices()).then((result) => { if (!disposed) setDevices(result.devices); }, () => { if (!disposed) setDevices([]); });
    return () => { disposed = true; };
  }, []);

  async function revoke(device: AppDeviceSession) {
    setPendingId(device.id);
    setError(null);
    try {
      const { device: revoked } = await api.revokeAppDevice(device.id);
      setDevices((current) => (current ?? []).map((entry) => entry.id === revoked.id ? revoked : entry));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The device could not be revoked.");
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
      return <div className="settings-flat-row" key={device.id} style={{ gridTemplateColumns: "minmax(0, 1fr) auto", gap: "0.75rem" }}>
        <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
          <strong>{label}</strong>
          <small>Signed in {day(device.createdAt)} · until {day(device.expiresAt)}</small>
        </span>
        <button type="button" className="button" disabled={pendingId !== null} aria-label={`Revoke ${label}`} onClick={() => void revoke(device)}>Revoke</button>
      </div>;
    })}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
