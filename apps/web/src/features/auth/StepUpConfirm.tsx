import { useEffect, useRef, useState } from "react";
import { api } from "../../api.js";
import { useUiText } from "../ui-language/ui-language.js";

const STEP_UP_URL = "/api/auth/google/start?stepUp=mobile";
/** Set by the tab that opened the mailed link (useAppNotices), so the tab that asked continues at once. */
export const STEP_UP_MAIL_KEY = "space:step-up-mail";
const plainError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^[A-Z_]+: /, "") : String(cause);

/**
 * Confirm it is you before an action the server held with STEP_UP_REQUIRED (operator 17/11, nous_msg:a0e6a7a4da2944d0af75ce09 and
 * nous_msg:db5f61cafe3847b1ad5f59f6: "if I don't know the password I can't type it"; no password field where he may not know it).
 * Google first where it works (beforeGoogle marks the action so it runs on return, step-up-resume.ts), and a link by mail everywhere: it
 * confirms this session only and changes no password (POST /api/auth/step-up/mail). Opened in another tab of this browser, this one
 * continues by itself; in the desktop app it is pasted here. The SpaceApp password stays behind a link for whoever knows it.
 */
export function StepUpConfirm({ reason, google, beforeGoogle, onConfirmed, onCancel, dock = false, passwordLabel = "Use my password instead" }: {
  reason: string;
  google: boolean;
  beforeGoogle(): void;
  /** The step-up is fresh: run the held action again. */
  onConfirmed(): Promise<void> | void;
  /** No Cancel button without it (Settings › Login password has nothing to cancel). */
  onCancel?(): void;
  /** In the Nous dock: its button and form classes. */
  dock?: boolean;
  /** The link that shows the password field. */
  passwordLabel?: string;
}) {
  const t = useUiText();
  const [mode, setMode] = useState<"choose" | "mailed" | "password">("choose");
  const [sentTo, setSentTo] = useState("");
  const [link, setLink] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(true);
  // A server that cannot mail links (`canMail` false, 17/11 spaceapp-hz) never shows a mail button that sends nothing; null until known.
  const [canMail, setCanMail] = useState<boolean | null>(null);
  // The desktop app has no Google step-up: with no mail either, it opens this SpaceApp in the system browser, which has one.
  const desktop = typeof window !== "undefined" && "spaceDesktop" in window;
  const [browserAddress, setBrowserAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const confirmedRef = useRef(onConfirmed);
  confirmedRef.current = onConfirmed;
  const button = dock ? "dock-kit-button" : "button";
  const copy = dock ? undefined : "settings-flat-row-copy";
  const actions = dock ? "nous-decision-actions" : "settings-flat-actions";

  // An account with no SpaceApp password (Google only) gets no password link.
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.passwordStatus()).then((status) => {
      if (!live) return;
      if (status?.hasPassword === false) setHasPassword(false);
      setCanMail(status?.canMail !== false);
    }, () => { if (live) setCanMail(true); });
    return () => { live = false; };
  }, []);

  const finish = async () => {
    if (done.current) return;
    done.current = true;
    setPassword(""); setLink("");
    await confirmedRef.current();
  };

  // The link opened in another tab of this browser confirmed this session: continue here without a paste.
  useEffect(() => {
    if (mode !== "mailed") return;
    const check = () => {
      Promise.resolve().then(() => api.passwordStatus()).then((status) => {
        if (status?.stepUpUntil && Date.parse(status.stepUpUntil) > Date.now()) void finish().catch((cause) => setError(plainError(cause)));
      }, () => undefined);
    };
    const onStorage = (event: StorageEvent) => { if (event.key === STEP_UP_MAIL_KEY) check(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", check);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("focus", check); };
  }, [mode]);

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await work(); } catch (cause) { done.current = false; setError(plainError(cause)); } finally { setBusy(false); }
  }
  const confirm = () => attempt(async () => {
    if (mode === "mailed") {
      // The whole link from the mail, or only its token.
      const token = /(?:space-step-up=)?([A-Za-z0-9_-]{32,})\s*$/.exec(link.trim())?.[1];
      if (!token) throw new Error(t("Paste the whole link from the mail."));
      await api.stepUpWithMail(token);
    } else {
      await api.stepUpWithPassword(password);
    }
    await finish();
  });
  const mail = () => attempt(async () => {
    const answer = await api.requestStepUpMail();
    setSentTo(answer?.sentTo ?? "");
    setLink("");
    setMode("mailed");
  });
  const goToGoogle = () => { beforeGoogle(); window.location.assign(STEP_UP_URL); };
  const openInBrowser = async () => {
    const address = `${window.location.origin}/`;
    const bridge = (window as unknown as { spaceDesktop?: { openExternal?(url: string): Promise<boolean | undefined> } }).spaceDesktop;
    const opened = await bridge?.openExternal?.(address).catch(() => false);
    // An older app, or a refused address: the address to open by hand.
    setBrowserAddress(opened === true ? null : address);
  };
  const stuck = !google && canMail === false;
  const cancel = onCancel ? <button type="button" className={button} disabled={busy} onClick={onCancel}>{t("Cancel")}</button> : null;

  return <form className={dock ? "nous-decision-answer" : undefined} aria-label={t("Confirm it is you")} onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
    <div className={dock ? undefined : "settings-flat-row"} style={dock ? undefined : { gridTemplateColumns: "1fr" }}>
      <p className={copy} role="status" style={{ margin: 0 }}><small>{reason}</small></p>
      {mode === "mailed" ? <>
        <p className={copy} style={{ margin: 0 }}><small>{sentTo
          ? t("A link is on its way to {address}. Open it in this browser within 15 minutes, or paste it here.", { address: sentTo })
          : t("A link is on its way to your address. Open it in this browser within 15 minutes, or paste it here.")}</small></p>
        <label className={copy}><small>{t("Link from the mail")}</small>
          <input type="text" autoComplete="off" spellCheck={false} autoFocus aria-label={t("Link from the mail")} value={link} onChange={(event) => setLink(event.target.value)} /></label>
      </> : mode === "password" ? <label className={copy}><small>{t("Your SpaceApp password")}</small>
        <input type="password" autoComplete="current-password" autoFocus aria-label={t("Your SpaceApp password")} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      : stuck ? <p className={copy} style={{ margin: 0 }}><small>{desktop
        ? t("This server cannot send mail, and the desktop app cannot confirm with Google. Open SpaceApp in your browser and do this there: the browser confirms with Google.")
        : t("This server cannot send mail and Google sign-in is not turned on, so only your SpaceApp password confirms it is you. The owner can reset it on the host: npx --yes run-spaceapp@latest owner reset-password.")}</small></p>
      : null}
      {stuck && desktop && browserAddress ? <p className={copy} style={{ margin: 0 }}><small>{t("Open {address} in your browser.", { address: browserAddress })}</small></p> : null}
    </div>
    {error ? <p className={dock ? undefined : "settings-flat-note"} role="alert">{error}</p> : null}
    <div className={actions}>
      {mode === "choose" ? <>
        {google ? <button type="button" className={`${button} is-primary`} disabled={busy} autoFocus onClick={goToGoogle}>{t("Confirm with Google")}</button> : null}
        {canMail ? <button type="button" className={google ? button : `${button} is-primary`} disabled={busy} autoFocus={!google} onClick={() => void mail()}>{t("Email me a link")}</button> : null}
        {stuck && desktop ? <button type="button" className={`${button} is-primary`} disabled={busy} onClick={() => void openInBrowser()}>{t("Open SpaceApp in your browser")}</button> : null}
      </> : <>
        <button type="submit" className={`${button} is-primary`} disabled={busy || (mode === "mailed" ? !link.trim() : !password)}>{t("Confirm")}</button>
        {mode === "mailed" ? <button type="button" className={button} disabled={busy} onClick={() => void mail()}>{t("Send a new link")}</button>
          : <button type="button" className={button} disabled={busy} onClick={() => { setPassword(""); setError(null); setMode("choose"); }}>{t("Back")}</button>}
      </>}
      {cancel}
    </div>
    {mode !== "password" && hasPassword ? <p className="step-up-password-link">
      <button type="button" disabled={busy} onClick={() => { setError(null); setMode("password"); }}><small>{t(passwordLabel)}</small></button>
    </p> : null}
  </form>;
}
