import { useEffect, useState } from "react";
import { api, SpaceApiError } from "../../api.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { StepUpConfirm } from "../auth/StepUpConfirm.js";

const STEP_UP_KEY = "space:password-after-step-up";

/** The Google step-up came back (?mobileStepUp=ok or its error): true once when Login password started it, in this tab, within 10 minutes. */
export function takePasswordStepUp(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(STEP_UP_KEY));
    window.sessionStorage.removeItem(STEP_UP_KEY);
    return at > 0 && Date.now() - at < 10 * 60_000;
  } catch { return false; }
}

/** Marks this tab so the Google return opens Login password (Settings' Confirm with Google, and the login screen's Forgot password?). */
export function rememberPasswordStepUp(): void {
  try { window.sessionStorage.setItem(STEP_UP_KEY, String(Date.now())); } catch { /* storage off: the notice still says it is confirmed */ }
}

const WRAP = { display: "flex", flexWrap: "wrap", gap: 8 } as const;
const plainError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^[A-Z_]+: /, "") : String(cause);

/** Settings › Login password (operator 12/11): the signed-in person changes their own password. Operator 17/11 (nous_msg:db5f61cafe3847b1ad5f59f6,
 * nous_msg:ccf452a2bf474536b8d4e685): no Current password field. It confirms it is you first, with Google or a link by mail (StepUpConfirm;
 * the password stays behind "I know my current password"), then asks only for the new password within those 5 minutes. */
export function LoginPasswordSettingsCard({ googleAuthEnabled = true }: { googleAuthEnabled?: boolean } = {}) {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  const about = (label: string) => uiText(language, "About {label}", { label: t(label) });
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // The desktop app turns /api/auth/google/start into a plain sign-in that drops stepUp=mobile (MobileAppManager): the mailed link there,
  // or, on a server that cannot mail, StepUpConfirm opens this SpaceApp in the system browser (Nous 17/11).
  const google = googleAuthEnabled && typeof window !== "undefined" && !("spaceDesktop" in window);
  const [status, setStatus] = useState<{ hasPassword: boolean; stepUpUntil: string | null } | null | undefined>(undefined);
  const readStatus = () => Promise.resolve().then(() => api.passwordStatus()).then(setStatus, () => setStatus(null));
  useEffect(() => { void readStatus(); }, []);
  const until = status?.stepUpUntil ? Date.parse(status.stepUpUntil) : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), until - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [until]);
  const steppedUp = until > now;

  async function save() {
    setError(null);
    setDone(false);
    if (next.length < 12) return setError(t("The new password needs at least 12 characters."));
    if (next !== confirm) return setError(t("The two new passwords are not the same."));
    setBusy(true);
    try {
      await api.changePassword(next);
      setNext(""); setConfirm("");
      setDone(true);
      void readStatus();
    } catch (cause) {
      const code = cause instanceof SpaceApiError ? cause.code : null;
      setError(code === "STEP_UP_REQUIRED" ? t("The 5 minutes ran out. Confirm it is you again, then save.")
        : code === "PASSWORD_NOT_STORED" ? t("This account has no SpaceApp password to change: it signs in with Google.")
        : plainError(cause));
      if (code === "STEP_UP_REQUIRED") void readStatus();
    } finally {
      setBusy(false);
    }
  }

  return <section className="agent-settings-card settings-flat-card" aria-label={t("Login password")}>
    {steppedUp ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="settings-flat-row" style={WRAP}>
        <p className="settings-flat-row-copy" role="status" style={{ flex: "1 1 100%", margin: 0 }}><small>{uiText(language, "Confirmed it is you until {time}. Choose the new password.", { time: new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</small></p>
        <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("New password")}</small>
          <InfoTip text={t("At least 12 characters. Saving it signs out your other sessions.")} label={about("New password")} />
          <input type="password" name="new-password" autoComplete="new-password" aria-label={t("New password")} minLength={12} maxLength={500} required value={next} onChange={(event) => setNext(event.target.value)} /></label>
        <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("Confirm new password")}</small>
          <input type="password" name="confirm-password" autoComplete="new-password" aria-label={t("Confirm new password")} minLength={12} maxLength={500} required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
      </div>
      <div className="settings-flat-actions">
        <button type="submit" className="settings-flat-button" disabled={busy || !next || !confirm}>{t("Save password")}</button>
      </div>
    </form> : status !== undefined ? <StepUpConfirm reason={t(status?.hasPassword !== false ? "Confirm it is you first; then choose the new password." : "This account has no SpaceApp password yet. Confirm it is you first; then choose one.")}
      google={google} beforeGoogle={rememberPasswordStepUp} onConfirmed={readStatus} passwordLabel="I know my current password" /> : null}
    {done ? <p className="settings-flat-note" role="status">{t("Password changed. Your other sessions are signed out.")}</p> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
