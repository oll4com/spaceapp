import { useEffect, useMemo, useState } from "react";
import { api, SpaceApiError, type MobileInstanceStatus, type MobilePairingOffer } from "../../api.js";
import { markPairAfterStepUp, takePairAfterStepUp } from "./mobile-pair-resume.js";
import { pairingQrPath } from "./pairing-qr.js";
import { useUiText } from "../ui-language/ui-language.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";

/**
 * Settings > Account > Mobile app (Nous Pro 1b, ADR-013): pair the Nous app straight to this SpaceApp, end to end encrypted. Setting up and
 * pairing take your SpaceApp password or a fresh Google sign-in (the server answers STEP_UP_REQUIRED with where to go; the password
 * also serves installs without Google sign-in). The QR carries a one-time code for 120 s and
 * shows only in this tab (capture sessions are read-only and cannot ask for one); agents' pictures of the page blur it (data-sensitive-masked="pairing",
 * PAIRING_MASK in browser-sessions.ts), the operator's own Hide sensitive data does not (12/11: it hid the code he had to scan).
 * A paired phone only reads until it is allowed under Devices. Pair a phone also sets the keys up when there are none (7/11: Set up was a
 * step of its own and a confirmed step-up still met 409 MOBILE_NOT_SET_UP), and a Google step-up comes back here and pairs (mobile-pair-resume).
 */
const WRAP = { display: "flex", flexWrap: "wrap", gap: "0.5rem 0.75rem", alignItems: "center" } as const;

export function MobileAppManager() {
  const [status, setStatus] = useState<MobileInstanceStatus | null>(null);
  const [offer, setOffer] = useState<MobilePairingOffer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The server asked to confirm it is you: why, the action to run again after the password, and Google's step-up page.
  const [stepUp, setStepUp] = useState<{ reason: string; retry: () => Promise<void>; googleUrl?: string } | null>(null);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);
  const t = useUiText();

  useEffect(() => {
    let disposed = false;
    Promise.resolve().then(() => api.mobileInstance()).then((result) => { if (!disposed) setStatus(result); }, () => { if (!disposed) setStatus({ configured: false }); });
    // Back from a confirmed Google step-up started by Pair a phone: pair now, within its 5 minutes.
    if (takePairAfterStepUp()) void run(pair);
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offer]);
  const left = offer ? Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000)) : 0;
  useEffect(() => { if (offer && left === 0) setOffer(null); }, [offer, left]);
  const qr = useMemo(() => (offer ? pairingQrPath(offer.qr) : null), [offer]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      const details = failure instanceof SpaceApiError && failure.code === "STEP_UP_REQUIRED" ? failure.details as { stepUpUrl?: string; passwordUrl?: string } | undefined : undefined;
      if (details?.passwordUrl) {
        // The desktop app turns /api/auth/google/start into a plain desktop sign-in that drops stepUp=mobile: only the password works there.
        // Say why the password field appeared (7/11: four Set up clicks answered 401 STEP_UP_REQUIRED and no password followed), as a
        // request, not an error (8/11: the operator read the red alert in the desktop app as a failed pairing and stopped there).
        setStepUp({ reason: (failure as Error).message.replace(/^STEP_UP_REQUIRED: /, ""), retry: work, googleUrl: "spaceDesktop" in window ? undefined : details.stepUpUrl });
        return;
      }
      if (details?.stepUpUrl) { markPairAfterStepUp(); window.location.assign(details.stepUpUrl); return; }

      setError(failure instanceof Error ? failure.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }
  const rotate = (compromised: boolean) => run(async () => {
    const question = compromised ? "Treat the mobile keys as exposed? Every paired phone must pair again." : "Rotate the mobile keys? Paired phones move to the new keys when they next connect.";
    // A pairing code shown before names the old keys, which the phone would refuse: it goes with them.
    if (window.confirm(question)) { setStatus(await api.rotateMobileInstance(compromised)); setOffer(null); }
  });
  const confirmPassword = () => run(async () => {
    const retry = stepUp!.retry;
    await api.stepUpWithPassword(password);
    setPassword("");
    setStepUp(null);
    await retry();
  });
  // Pair a phone: the server sets the keys up first when there are none, so the status follows.
  async function pair() {
    setCopied(false);
    setOffer(await api.createMobilePairing());
    if (!status?.configured) setStatus(await api.mobileInstance());
  }
  const goToGoogle = (url: string) => { markPairAfterStepUp(); window.location.assign(url); };
  const cancel = () => run(async () => { if (offer) await api.cancelMobilePairing(offer.offerId); setOffer(null); });

  return <section aria-label="Mobile app" className="google-accounts-manager">
    <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
      <SettingsLabel label="Mobile app" help="Pair the Nous app on your phone with this SpaceApp; it connects here directly, end to end encrypted. Pair a phone sets up the mobile keys when needed and first asks you to confirm it is you." />
    </div>
    {stepUp ? <form onSubmit={(event) => { event.preventDefault(); void confirmPassword(); }}>
      <div className="settings-flat-row" style={WRAP}>
        <p className="settings-flat-row-copy" role="status" style={{ flex: "1 1 100%", margin: 0 }}><small>{stepUp.reason}{stepUp.googleUrl ? null
          : " Google confirmation is not available in the desktop app: type your SpaceApp password, or open SpaceApp in a web browser and pair from there."}</small></p>
        <label className="settings-flat-row-copy" style={{ flex: "1 1 100%" }}><small>Your SpaceApp password</small>
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      </div>
      <div className="settings-flat-actions">
        <button type="submit" className="button" disabled={busy || !password}>Confirm</button>
        {stepUp.googleUrl ? <button type="button" className="button" disabled={busy} onClick={() => goToGoogle(stepUp.googleUrl!)}>Sign in to Google instead</button> : null}
        <button type="button" className="button" disabled={busy} onClick={() => { setStepUp(null); setPassword(""); setError(null); }}>Cancel</button>
      </div>
    </form> : null}
    {status && !status.configured ? <>
      <p className="settings-flat-note">No phone paired yet.</p>
      <div className="settings-flat-actions">
        <button type="button" className="button" disabled={busy || offer !== null} onClick={() => void run(pair)}>Pair a phone</button>
      </div>
    </> : null}
    {status?.configured ? <>
      <div className="settings-flat-row" style={{ gridTemplateColumns: "1fr" }}>
        <SettingsLabel label="Fingerprint" help="This SpaceApp's mobile keys; the Nous app shows the same fingerprint when it pairs. Rotate keys moves paired phones to new keys when they next connect; Keys exposed makes every paired phone pair again.">
          <span style={{ whiteSpace: "nowrap" }}>{status.fingerprint}</span>
        </SettingsLabel>
      </div>
      <div className="settings-flat-actions">
        <button type="button" className="button" disabled={busy || offer !== null} onClick={() => void run(pair)}>Pair a phone</button>
        <button type="button" className="button" disabled={busy} onClick={() => void rotate(false)}>Rotate keys</button>
        <button type="button" className="button" disabled={busy} onClick={() => void rotate(true)}>Keys exposed</button>
      </div>
    </> : null}
    {offer && qr ? <>
      <div data-sensitive-masked="pairing" className="settings-flat-row" style={WRAP}>
        <svg role="img" aria-label="Pairing code" viewBox={`0 0 ${qr.size} ${qr.size}`} width={224} height={224} style={{ maxWidth: "100%", height: "auto" }} shapeRendering="crispEdges">
          <rect width={qr.size} height={qr.size} fill="#ffffff" /><path d={qr.path} fill="#000000" />
        </svg>
        <span className="settings-flat-row-copy" style={{ flex: "1 1 12rem" }}>
          <small>Scan this with the Nous app and check that it shows the fingerprint {offer.fingerprint}. It works once and expires in {left} s.</small>
        </span>
      </div>
      <div className="settings-flat-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
        {/* Space Link (ADR-014): the same code links another SpaceApp, pasted there in Settings > Account > Linked SpaceApps. */}
        <button type="button" className="button" disabled={busy || !navigator.clipboard} onClick={() => void navigator.clipboard.writeText(offer.qr).then(() => setCopied(true), () => setError(t("The code could not be copied.")))}>
          {t(copied ? "Copied: paste it in the other SpaceApp" : "Copy code for another SpaceApp")}</button>
      </div>
    </> : null}
    {status?.retiring?.length ? <p className="settings-flat-note">Older keys still answer phones that have not reconnected: {status.retiring.map((key) => `${key.fingerprint} until ${new Date(key.until).toLocaleDateString("en-US")}`).join(", ")}.</p> : null}
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
  </section>;
}
