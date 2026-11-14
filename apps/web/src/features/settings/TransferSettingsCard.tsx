import { useEffect, useState } from "react";
import { api, type TransferAction, type TransferStatus } from "../../api.js";
import { useDockConfirm } from "../dock-kit/DockKit.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { SettingsLabel } from "./SettingsLabel.js";

const ONE = { gridTemplateColumns: "1fr" } as const;

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
    <div className="settings-flat-row" style={ONE}>
      <SettingsLabel label="This Space" help="This Space's transfer keys and pairing code: it is the source of a move to a new host. Create keys once before you pair a target.">
        {status?.pairingCode ? t("Pairing code: {code}", { code: status.pairingCode }) : t("No transfer keys yet.")}
      </SettingsLabel>
    </div>
    {status && !status.pairingCode ? <div className="settings-flat-actions">
      <button type="button" className="settings-flat-button" disabled={running} onClick={() => void run("keys")}>{t("Create keys")}</button>
    </div> : null}

    <div className="settings-flat-row" style={ONE}>
      <SettingsLabel label="Target" help="The new host this Space moves to. Pair it once with the card.json and the code its keys step printed.">
        {status?.target ? t("Paired, code {code}", { code: status.target.pairingCode }) : t("Not paired. On the target run keys, then paste its card.json and the code it printed.")}
      </SettingsLabel>
    </div>
    {status && !status.target ? <form onSubmit={(event) => { event.preventDefault(); void act(() => api.transferPair(card, code)); }}>
      <div className="settings-flat-row" style={ONE}>
        <label className="settings-flat-row-copy">
          <span>{t("Target card")}</span>
          <textarea value={card} onChange={(event) => setCard(event.target.value)} rows={4} spellCheck={false} required />
        </label>
        <label className="settings-flat-row-copy">
          <span>{t("Target code")}</span>
          <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} required />
        </label>
      </div>
      <div className="settings-flat-actions">
        <button type="submit" className="settings-flat-button" disabled={running}>{t("Pair")}</button>
      </div>
    </form> : null}

    <div className="settings-flat-row" style={ONE}>
      <SettingsLabel label="Standby" help="The last bundle the target holds: this Space's tables and files. Manifest reads what this Space would send; Sync sends it to the paired target.">
        {state ? t("Last bundle {head}: {tables} tables, {files} files.", { head: state.head ?? "-", tables: state.tables, files: state.files }) : t("Nothing sent yet.")}
      </SettingsLabel>
    </div>
    {state?.cutoverAt ? <p className="settings-flat-note">{t("Cut over at {time}.", { time: state.cutoverAt })}</p> : null}
    {!commandsReady ? <p className="settings-flat-note">{t("Cutover and rollback need the apply and switch commands in var/transfer/commands.json on this host.")}</p> : null}
    <div className="settings-flat-actions">
      <button type="button" className="settings-flat-button" disabled={running} onClick={() => void run("manifest")}>{t("Manifest")}</button>
      <button type="button" className="settings-flat-button" disabled={running || !status?.target} onClick={() => void run("sync")}>{t("Sync")}</button>
    </div>

    <div className="settings-flat-row" style={ONE}>
      <SettingsLabel label="Cutover" help="Cut over turns this Space read-only, sends its last changes to the target and moves the route there; Roll back brings it back. Run the rollback dry run first: cutover needs it.">
        {state?.rollbackDryRun ? t("Rollback rehearsed at {time}.", { time: state.rollbackDryRun }) : t("Rehearse the rollback first: cutover needs it.")}
      </SettingsLabel>
    </div>
    <div className="settings-flat-actions">
      <button type="button" className="settings-flat-button" disabled={running || !status?.commands.switch} onClick={() => void run("rollback", true)}>{t("Rollback dry run")}</button>
      <button type="button" className="settings-flat-button" disabled={running || !commandsReady || !state} onClick={() => void run("cutover", true)}>{t("Cutover dry run")}</button>
      <button type="button" className="settings-flat-button" disabled={running || !commandsReady || !state?.rollbackDryRun} onClick={() => void guarded("cutover")}>{t("Cut over")}</button>
      <button type="button" className="settings-flat-button" disabled={running || !status?.commands.switch} onClick={() => void guarded("rollback")}>{t("Roll back")}</button>
    </div>

    <div className="settings-flat-row" style={ONE} aria-live="polite">
      <SettingsLabel label="Last job" help="The last transfer step and how it ended; it refreshes every two seconds while a step runs. Report shows the full result of a finished step.">
        {!job ? t("None yet.") : !job.endedAt ? t("{action} runs since {time}…", { action: job.action, time: job.startedAt })
          : job.error ? t("{action} failed: {error}", { action: job.action, error: job.error }) : t("{action} ended at {time}.", { action: job.action, time: job.endedAt })}
      </SettingsLabel>
    </div>
    {error ? <p className="settings-flat-note" role="alert">{error}</p> : null}
    {job?.endedAt && !job.error ? <details>
      <summary>{t("Report")}</summary>
      <pre tabIndex={0}>{JSON.stringify(job.result, null, 2)}</pre>
    </details> : null}
  </section>;
}
