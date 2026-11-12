import { useEffect, useState } from "react";
import { api, type TransferAction, type TransferStatus } from "../../api.js";
import { useDockConfirm } from "../dock-kit/DockKit.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";

/**
 * Settings › Maintenance › Transfer (plan clipboard:HO2VBvn_aaPI step 4): this Space as the source of a move to a new host.
 * Pair the target by its card and code, read the manifest, sync, then cutover (after a rollback dry run) or roll back.
 */
export function TransferSettingsCard() {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const { confirm, confirmDialog } = useDockConfirm();
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [card, setCard] = useState("");
  const [code, setCode] = useState("");
  const running = Boolean(status?.job && !status.job.endedAt);

  async function refresh() {
    try { setStatus(await api.transferStatus()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => { void refresh(); }, []);
  // While a job runs its progress is the job itself: read it again every two seconds until it ends.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [running]);

  async function act(step: () => Promise<unknown>) {
    setError(null);
    try { await step(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    await refresh();
  }
  const run = (action: TransferAction, dryRun = false) => act(() => api.transferRun(action, dryRun));
  async function guarded(action: "cutover" | "rollback") {
    const ok = await confirm(action === "cutover"
      ? { title: t("Cut over to the target?"), message: t("This Space turns read-only, its last changes go to the target and the route moves there. Rollback brings it back."), confirmLabel: t("Cut over"), tone: "danger" }
      : { title: t("Roll back to this Space?"), message: t("The route moves back here and this Space is writable again."), confirmLabel: t("Roll back"), tone: "danger" });
    if (ok) await run(action);
  }

  const job = status?.job;
  const state = status?.state;
  const commandsReady = Boolean(status?.commands.apply && status.commands.switch);
  return <section className="agent-settings-card settings-flat-card" aria-label={t("Transfer")} aria-busy={running}>
    {confirmDialog}
    <div className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>{t("This Space")}</strong>
        <small>{status?.pairingCode ? t("Pairing code: {code}", { code: status.pairingCode }) : t("No transfer keys yet.")}</small>
      </span>
      {status && !status.pairingCode ? <button type="button" className="settings-flat-button" disabled={running} onClick={() => void run("keys")}>{t("Create keys")}</button> : null}
    </div>

    <div className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>{t("Target")}</strong>
        <small>{status?.target ? t("Paired, code {code}", { code: status.target.pairingCode }) : t("Not paired. On the target run keys, then paste its card.json and the code it printed.")}</small>
      </span>
    </div>
    {status && !status.target ? <form className="settings-flat-row" onSubmit={(event) => { event.preventDefault(); void act(() => api.transferPair(card, code)); }}>
      <label className="settings-flat-row-copy">
        <span>{t("Target card")}</span>
        <textarea value={card} onChange={(event) => setCard(event.target.value)} rows={4} spellCheck={false} required />
      </label>
      <label className="settings-flat-row-copy">
        <span>{t("Target code")}</span>
        <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} required />
      </label>
      <button type="submit" className="settings-flat-button" disabled={running}>{t("Pair")}</button>
    </form> : null}

    <div className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>{t("Standby")}</strong>
        <small>{state ? t("Last bundle {head}: {tables} tables, {files} files.", { head: state.head ?? "-", tables: state.tables, files: state.files }) : t("Nothing sent yet.")}</small>
        {state?.cutoverAt ? <small>{t("Cut over at {time}.", { time: state.cutoverAt })}</small> : null}
        {!commandsReady ? <small>{t("Cutover and rollback need the apply and switch commands in var/transfer/commands.json on this host.")}</small> : null}
      </span>
      <span>
        <button type="button" className="settings-flat-button" disabled={running} onClick={() => void run("manifest")}>{t("Manifest")}</button>
        <button type="button" className="settings-flat-button" disabled={running || !status?.target} onClick={() => void run("sync")}>{t("Sync")}</button>
      </span>
    </div>

    <div className="settings-flat-row">
      <span className="settings-flat-row-copy">
        <strong>{t("Cutover")}</strong>
        <small>{state?.rollbackDryRun ? t("Rollback rehearsed at {time}.", { time: state.rollbackDryRun }) : t("Rehearse the rollback first: cutover needs it.")}</small>
      </span>
      <span>
        <button type="button" className="settings-flat-button" disabled={running || !status?.commands.switch} onClick={() => void run("rollback", true)}>{t("Rollback dry run")}</button>
        <button type="button" className="settings-flat-button" disabled={running || !commandsReady || !state} onClick={() => void run("cutover", true)}>{t("Cutover dry run")}</button>
        <button type="button" className="settings-flat-button" disabled={running || !commandsReady || !state?.rollbackDryRun} onClick={() => void guarded("cutover")}>{t("Cut over")}</button>
        <button type="button" className="settings-flat-button" disabled={running || !status?.commands.switch} onClick={() => void guarded("rollback")}>{t("Roll back")}</button>
      </span>
    </div>

    <div className="settings-flat-row" aria-live="polite">
      <span className="settings-flat-row-copy">
        <strong>{t("Last job")}</strong>
        <small>{!job ? t("None yet.") : !job.endedAt ? t("{action} runs since {time}…", { action: job.action, time: job.startedAt })
          : job.error ? t("{action} failed: {error}", { action: job.action, error: job.error }) : t("{action} ended at {time}.", { action: job.action, time: job.endedAt })}</small>
        {error ? <small role="alert">{error}</small> : null}
      </span>
    </div>
    {job?.endedAt && !job.error ? <details>
      <summary>{t("Report")}</summary>
      <pre tabIndex={0}>{JSON.stringify(job.result, null, 2)}</pre>
    </details> : null}
  </section>;
}
