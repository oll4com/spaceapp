import { useState } from "react";
import { api, SpaceApiError } from "../../api.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { InfoTip } from "../ui-controls/InfoTip.js";

const STEP_UP_KEY = "space:password-after-step-up";
const STEP_UP_URL = "/api/auth/google/start?stepUp=mobile";

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

/** Settings › Login password (operator 12/11): the signed-in person changes their own password, proven by the current one or a Google step-up. */
export function LoginPasswordSettingsCard() {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  const about = (label: string) => uiText(language, "About {label}", { label: t(label) });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // The desktop app turns /api/auth/google/start into a plain sign-in that drops stepUp=mobile (MobileAppManager): only the password works there.
  const google = typeof window !== "undefined" && !("spaceDesktop" in window);

  async function save() {
    setError(null);
    setDone(false);
    if (next.length < 12) return setError(t("The new password needs at least 12 characters."));
    if (next !== confirm) return setError(t("The two new passwords are not the same."));
    setBusy(true);
    try {
      await api.changePassword(next, current || undefined);
      setCurrent(""); setNext(""); setConfirm("");
      setDone(true);
    } catch (cause) {
      const code = cause instanceof SpaceApiError ? cause.code : null;
      setError(code === "INVALID_CREDENTIALS" ? t("Your current password is not right.")
        : code === "STEP_UP_REQUIRED" ? t("Type your current password, or confirm it is you with Google first.")
        : code === "PASSWORD_NOT_STORED" ? t("This account has no SpaceApp password to change: it signs in with Google.")
        : cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const goToGoogle = () => {
    rememberPasswordStepUp();
    window.location.assign(STEP_UP_URL);
  };

  return <form className="agent-settings-card settings-flat-card" aria-label={t("Login password")} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="settings-flat-row" style={WRAP}>
      <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("Current password")}</small>
        <InfoTip text={google ? t("Proves it is you. Forgot it? Confirm it is you with Google, then leave this empty for 5 minutes.") : t("Proves it is you.")}
          label={about("Current password")} />
        <input type="password" name="current-password" autoComplete="current-password" aria-label={t("Current password")} value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
      <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("New password")}</small>
        <InfoTip text={t("At least 12 characters. Saving it signs out your other sessions.")} label={about("New password")} />
        <input type="password" name="new-password" autoComplete="new-password" aria-label={t("New password")} minLength={12} maxLength={500} required value={next} onChange={(event) => setNext(event.target.value)} /></label>
      <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>{t("Confirm new password")}</small>
        <input type="password" name="confirm-password" autoComplete="new-password" minLength={12} maxLength={500} required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
    </div>
    <div className="settings-flat-actions">
      <button type="submit" className="settings-flat-button" disabled={busy || !next || !confirm}>{t("Save password")}</button>
      {google ? <button type="button" className="settings-flat-button" disabled={busy} onClick={goToGoogle}>{t("Confirm with Google")}</button> : null}
    </div>
    {done ? <p className="settings-flat-note" role="status">{t("Password changed. Your other sessions are signed out.")}</p> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </form>;
}
