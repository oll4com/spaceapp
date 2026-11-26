import { Fragment, useEffect, useState } from "react";
import { MOBILE_PAIRING_CONFIRM_MS, type AppDeviceSession } from "@space/contracts";
import { api, SpaceApiError } from "../../api.js";
import { NOTIFICATION_STREAM_EVENT } from "../notifications/useNotifications.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { StepUpConfirm } from "./StepUpConfirm.js";
import { markStepUpResume } from "./step-up-resume.js";
import { useUiText } from "../ui-language/ui-language.js";

const APP_LABELS: Record<string, string> = { nous: "Nous app", spaceapp: "SpaceApp app", "spaceapp-link": "SpaceApp link" };
/** Space Link v2 (ADR-014 v2): what an allowed link may do beyond read and act; Nous needs Manage. */
const LINK_GRANTS = [
  { scope: "manage", label: "Manage", help: "Its Nous runs this SpaceApp's panes, plans, goals, tasks and notifications, and reads its status and logs." },
  { scope: "upgrade", label: "Upgrade", help: "It moves this SpaceApp to the version it runs." },
  { scope: "nous", label: "Nous", help: "Its Nous commands this Nous, which reports to it; decisions that need a person go to its dock. Needs Manage." },
  { scope: "vault", label: "Vault", help: "Its Vault syncs into this SpaceApp's Vault: sealed to this Vault broker's key, never in clear; this SpaceApp's agents use its logins while agent access is on there." },
  { scope: "sync", label: "Settings and memory", help: "Its person's settings, Space Memory and site sign-in recipes (with the Google account each one uses) flow into this SpaceApp while both run versions that sync the same way; browser sessions, this host's own addresses, limits and Nous allowances stay as they are here." },
  { scope: "ai", label: "AI accounts", help: "This SpaceApp's Claude, Gemini and Copilot panes may use the AI accounts its Gateway serves: their prompts and answers pass through it, and no key comes here." }
] as const;
const day = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Settings > Account > Devices (plan clipboard:VLBu2ge110ho step 4): the phone apps signed in to this account with their own device
 * session (30 days each), and Revoke for a lost or replaced phone. A phone paired over the mobile channel (Nous Pro 1b) only reads until it
 * is allowed here, within 10 minutes of pairing. The list is read when the card opens, again when a phone pairs or its wait ends (the
 * MOBILE_PAIRED card's stream event) and when the tab or window comes back (9/11: a list read at 02:13:59Z never showed the phone paired at
 * 02:15:46Z, so its 10 minutes ran out without an Allow button).
 */
export function AppDevicesManager({ googleAuthEnabled = false }: { googleAuthEnabled?: boolean } = {}) {
  const [devices, setDevices] = useState<AppDeviceSession[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stepUp, setStepUp] = useState<{ reason: string; retry: () => Promise<void>; deviceId: string; scopes: string[] } | null>(null);
  // The desktop app turns /api/auth/google/start into a plain sign-in that drops stepUp=mobile: a mailed link there instead.
  const google = googleAuthEnabled && !("spaceDesktop" in window);
  const t = useUiText();

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

  const replace = (changed: AppDeviceSession) => setDevices((current) => (current ?? []).map((entry) => entry.id === changed.id ? changed : entry));
  // Granting more asks to confirm it is you first (STEP_UP_REQUIRED): Google (its return saves the grants, step-up-resume.ts), a mailed link,
  // or the SpaceApp password; the same change runs again once it is confirmed.
  async function grant(device: AppDeviceSession, scopes: string[]) {
    const work = async () => replace((await api.setLinkScopes(device.id, scopes)).device);
    setPendingId(device.id);
    setError(null);
    try {
      await work();
    } catch (failure) {
      if (failure instanceof SpaceApiError && failure.code === "STEP_UP_REQUIRED") setStepUp({ reason: failure.message.replace(/^STEP_UP_REQUIRED: /, ""), retry: work, deviceId: device.id, scopes });
      else setError(failure instanceof Error ? failure.message : "That did not change.");
    } finally {
      setPendingId(null);
    }
  }
  async function confirmed() {
    const retry = stepUp!.retry;
    setStepUp(null);
    setPendingId("step-up");
    try { await retry(); } catch (failure) { setError(failure instanceof Error ? failure.message : "That did not change."); } finally { setPendingId(null); }
  }
  const toggled = (scopes: readonly string[], scope: string, on: boolean) => {
    const next = new Set(scopes.filter((entry) => LINK_GRANTS.some((option) => option.scope === entry)));
    if (on) { next.add(scope); if (scope === "nous") next.add("manage"); } else { next.delete(scope); if (scope === "manage") next.delete("nous"); }
    return [...next];
  };

  const live = (devices ?? []).filter((device) => !device.revokedAt && Date.parse(device.expiresAt) > Date.now());
  return <section aria-label="Devices" className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <SettingsLabel label="Devices" help="Phone apps signed in to this account. Each sign-in lasts 30 days; revoke a lost or replaced phone. A newly paired phone only reads until you allow it here, within 10 minutes." />
    </div>
    {devices !== null && live.length === 0 ? <p className="settings-flat-note">No phone app is signed in.</p> : null}
    {live.map((device) => {
      const label = `${APP_LABELS[device.app] ?? device.app} on ${device.deviceName}`;
      const paired = device.paired, held = paired && !paired.allowedAt;
      const left = Math.ceil((Date.parse(device.createdAt) + MOBILE_PAIRING_CONFIRM_MS - now) / 60_000);
      return <Fragment key={device.id}>
        <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
          <span className="settings-flat-row-copy" style={{ minWidth: 0 }}>
            <strong>{label}</strong>
            <small>{!paired ? `Signed in ${day(device.createdAt)} · until ${day(device.expiresAt)}`
              : held ? `Paired ${day(device.createdAt)} · it only reads until you allow it; it asks to ${paired.requestedScopes.join(", ")} · ${left > 0 ? `${left} min left to allow` : "its 10 minutes to allow are up"}`
                : `Paired ${day(device.createdAt)} · may ${paired.scopes.join(", ")}${paired.decide ? " (decisions signed with a hardware key)" : ""} · until ${day(device.expiresAt)}`}</small>
          </span>
        </div>
        {device.app === "spaceapp-link" && paired && !held ? <div className="settings-flat-row" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem 1rem" }}>
          {LINK_GRANTS.map((option) => <SpaceToggle key={option.scope} compact label={option.label} help={option.help} ariaLabel={`${option.label}: ${label}`}
            checked={paired.scopes.includes(option.scope)} disabled={pendingId !== null || stepUp !== null}
            onChange={(on) => void grant(device, toggled(paired.scopes, option.scope, on))} />)}
        </div> : null}
        <div className="settings-flat-actions">
          {held ? <button type="button" className="button" disabled={pendingId !== null} aria-label={`Allow ${label}`} onClick={() => void change(device, "allow")}>Allow</button> : null}
          <button type="button" className="button" disabled={pendingId !== null} aria-label={`Revoke ${label}`} onClick={() => void change(device, "revoke")}>Revoke</button>
        </div>
      </Fragment>;
    })}
    {stepUp ? <StepUpConfirm reason={t("Confirm it is you to grant this link more.")} google={google}
      beforeGoogle={() => markStepUpResume({ purpose: "link-scopes", deviceId: stepUp.deviceId, scopes: stepUp.scopes })}
      onConfirmed={confirmed} onCancel={() => { setStepUp(null); setError(null); }} /> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
