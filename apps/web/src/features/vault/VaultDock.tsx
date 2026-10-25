import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  VAULT_PASSWORD_SYMBOLS, VaultCryptoError, canonicalVaultOrigin, generateVaultPassword,
  type VaultItemMetadata, type VaultItemRecord, type VaultPasswordPolicy
} from "@space/contracts";
import { api } from "../../api.js";
import type { VaultItemStats, VaultStateResponse } from "../../live-api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockNotice, DockSearch, DockState, DockToolbar, useDockConfirm } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Eye, EyeOff, Lock, Pencil, Plus, RefreshCw, ShieldOff, Trash2, Unlock, Vault } from "../ui-theme/app-icons.js";
import {
  VAULT_AGENT_POLICY, changeMasterPassword, confirmVaultItem, decryptVaultItem, encryptVaultItem, restorePreviousVaultItem, setUpVault,
  recoverVault, unlockVault, type UnlockedVault, type VaultItemSecrets
} from "./vault-client.js";
import { handOverToAgents, holdVaultKeys, lockVaultSession, openVaultInbox, subscribeVaultSession, vaultSessionKeys } from "./vault-session.js";
import { useVaultDefaults, type VaultDefaults } from "./vault-defaults.js";
import { VAULT_IDLE_CHOICES, useVaultAutoLockSettings, type VaultAutoLockSettings } from "./vault-auto-lock.js";
import "./vault.css";

// The Vault dock (plan clipboard:vEYtT6-bEN0J step 5). Everything secret is decrypted in this tab's memory (vault-session.ts)
// and dropped on Lock, Revoke, sign-out, a reload or the operator's auto-lock rules, not when the dock closes (operator
// decision 2026-10-19); the server sees ciphertext only. One switch lets agents and Nous use the Vault
// (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac): while it is on, the dock hands every login to the broker after
// each unlock and item change, and the logins agents saved are added on unlock.

type View = "items" | "audit" | "settings";
interface Draft { id?: string; label: string; origins: string; acceptedRisks: string[]; secrets: VaultItemSecrets; agentUse: boolean; previous?: VaultItemRecord }
const MIN_MASTER = 12;
const emptyDraft = (): Draft => ({ label: "", origins: "", acceptedRisks: [], secrets: {}, agentUse: true });
const warningText = { INSECURE_HTTP: "not encrypted (http)", IP_LITERAL: "an IP address", PUNYCODE: "an international (punycode) name that can imitate another site" } as const;
const errorText = (error: unknown) => error instanceof VaultCryptoError ? "The master password is not correct." : error instanceof Error ? error.message : "Something went wrong.";

export function VaultDock() {
  const [state, setState] = useState<VaultStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The keys live in the tab's Vault session (vault-session.ts), not in the dock: closing the dock keeps the Vault unlocked.
  const unlockedRef = useMemo(() => ({ get current() { return vaultSessionKeys(); } }), []);
  const [unlocked, setUnlocked] = useState(() => vaultSessionKeys() !== null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [view, setView] = useState<View>("items");
  const { confirm, confirmDialog } = useDockConfirm();
  const [autoLock, setAutoLock] = useVaultAutoLockSettings();
  const [defaults, setDefaults] = useVaultDefaults();
  const [itemsVersion, setItemsVersion] = useState(0);

  const load = useCallback(async () => {
    try { setState(await api.vaultState()); setError(null); } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeVaultSession((event) => {
    if (event.kind === "unlocked") setUnlocked(true);
    if (event.kind === "imported") {
      setInfo(`Added ${event.count} login${event.count === 1 ? "" : "s"} that agents saved or changed.`);
      setItemsVersion((version) => version + 1);
      void load();
    }
    if (event.kind === "locked") {
      setUnlocked(false);
      if (event.reason === "IDLE" || event.reason === "HIDDEN" || event.reason === "SLEEP") {
        setNotice(event.reason === "IDLE" ? "The Vault locked after the idle time set in Vault Settings."
          : event.reason === "SLEEP" ? "The Vault locked because the computer slept." : "The Vault locked because the tab was hidden.");
        void load();
      }
    }
  }), [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setNotice(null);
    try { await work(); } catch (cause) { setNotice(errorText(cause)); } finally { setBusy(false); }
  };
  const holdKeys = (keys: UnlockedVault) => holdVaultKeys(keys);
  // After every unlock: logins agents saved meanwhile are added, and agents get the current items.
  const openInbox = async (keys: UnlockedVault) => { await openVaultInbox(keys); await load(); };
  const lock = () => run(async () => { lockVaultSession("LOCK"); await api.vaultLock(); await load(); });
  const revoke = async () => {
    if (!await confirm({ title: "Revoke agent access?", message: "Agents and Nous stop using the Vault at once, until you turn agent access on again. No password is needed.", confirmLabel: "Revoke access" })) return;
    await run(async () => { const result = await api.vaultRevoke(); lockVaultSession("REVOKE"); setNotice(`Agent access revoked (generation ${result.generation}).`); await load(); });
  };

  if (error) return <DockState kind="error" title="The Vault could not load" detail={error} action={{ label: "Try again", onClick: () => void load(), icon: RefreshCw }} />;
  if (!state) return <DockState kind="loading" title="Loading the Vault" />;
  if (!state.enrolled && !state.brokerAvailable) {
    return <section className="dock-panel vault-dock" aria-label="Vault">
      <DockState kind="empty" icon={Vault} title="The Vault is not ready on this server"
        detail="The Vault needs its key broker, which the operator installs on the server. Nothing is stored until it runs." />
    </section>;
  }

  const agentLine = state.agentAccess ? `Agents and Nous: on (${state.delegatedItems} login${state.delegatedItems === 1 ? "" : "s"})` : "Agents and Nous: off";
  return (
    <section className="dock-panel vault-dock" aria-label="Vault">
      {confirmDialog}
      <DockToolbar summary={state.enrolled ? `${unlocked ? "Unlocked" : "Locked"} · ${agentLine}` : "Set up your Vault"}>
        {state.enrolled && state.agentAccess ? <DockButton icon={ShieldOff} tone="danger" onClick={() => void revoke()} disabled={busy}>Revoke agent access</DockButton> : null}
        {unlocked ? <DockButton icon={Lock} onClick={() => void lock()} disabled={busy}>Lock</DockButton> : null}
      </DockToolbar>
      {notice ? <DockNotice tone="error" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
      {info ? <DockNotice tone="info" onDismiss={() => setInfo(null)}>{info}</DockNotice> : null}
      {recoveryKey ? <RecoveryKey value={recoveryKey} onDone={() => setRecoveryKey(null)} />
        : !state.enrolled ? <SetupForm busy={busy} onSubmit={(password) => run(async () => {
          const created = await setUpVault(api, state.ownerUserId, password);
          holdKeys(created.unlocked); setRecoveryKey(created.recoveryKey); await openInbox(created.unlocked); await load();
        })} />
        : !unlocked ? <UnlockForm busy={busy} brokerAvailable={state.brokerAvailable} hasRecovery={Boolean(state.vault?.hasRecovery)} pendingItems={state.pendingItems ?? 0}
          onSubmit={(password) => run(async () => { const keys = await unlockVault(api, state.ownerUserId, password); holdKeys(keys); await openInbox(keys); })}
          onRecover={(recoveryKey, password) => run(async () => {
            const keys = await recoverVault(api, state.ownerUserId, recoveryKey, password);
            holdKeys(keys); await openInbox(keys); setInfo("Your new master password is set. The old one no longer opens the Vault; your recovery key still does."); await load();
          })} />
        : (
          <>
            <DockChips label="Vault view" value={view} onChange={setView} options={[{ id: "items", label: "Items" }, { id: "audit", label: "Activity" }, { id: "settings", label: "Settings" }]} />
            {view === "items" ? <ItemsView version={itemsVersion} keys={unlockedRef} run={run} confirm={confirm} defaults={defaults} vaultState={state} onVaultChanged={load} />
              : view === "audit" ? <AuditView />
              : <SettingsView run={run} confirm={confirm} busy={busy} defaults={defaults} onDefaultsChange={setDefaults} autoLock={autoLock} onAutoLockChange={setAutoLock} onChangePassword={(password) => run(async () => { holdKeys(await changeMasterPassword(api, unlockedRef.current!, password)); setNotice(null); await load(); })} />}
          </>
        )}
      <p className="vault-risk">A site you trust can still read what you give it, and anyone with control of this device can see what you reveal here.</p>
    </section>
  );
}

function PasswordPair({ busy, submitLabel, onSubmit }: { busy: boolean; submitLabel: string; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const problem = password.length < MIN_MASTER ? `Use at least ${MIN_MASTER} characters.` : password !== again ? "The two passwords differ." : null;
  return (
    <form className="vault-form" onSubmit={(event) => { event.preventDefault(); if (!problem) onSubmit(password); }}>
      <label>Master password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>Repeat it<input type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} /></label>
      {password && problem ? <p className="vault-hint">{problem}</p> : null}
      <DockButton type="submit" tone="primary" busy={busy} disabled={busy || Boolean(problem)}>{submitLabel}</DockButton>
    </form>
  );
}

function SetupForm({ busy, onSubmit }: { busy: boolean; onSubmit: (password: string) => void }) {
  return (
    <div className="vault-card">
      <h3>Set up your Vault</h3>
      <p>Your master password never leaves this browser. Opening the Vault needs it and the server's Vault key together; neither alone opens anything. If you lose both the password and the recovery key, the Vault cannot be opened again.</p>
      <PasswordPair busy={busy} submitLabel="Create Vault" onSubmit={onSubmit} />
    </div>
  );
}

function RecoveryKey({ value, onDone }: { value: string; onDone: () => void }) {
  return (
    <div className="vault-card" role="status">
      <h3>Save your recovery key</h3>
      <p>It replaces the master password if you forget it. It is shown only now; keep it offline, never in a chat or with an agent.</p>
      <code className="vault-recovery">{value}</code>
      <DockButton tone="primary" onClick={onDone}>I saved it</DockButton>
    </div>
  );
}

function UnlockForm({ busy, brokerAvailable, hasRecovery, pendingItems, onSubmit, onRecover }: {
  busy: boolean; brokerAvailable: boolean; hasRecovery: boolean; pendingItems: number; onSubmit: (password: string) => void; onRecover: (recoveryKey: string, password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState("");
  if (recovering) {
    return (
      <div className="vault-card">
        <h3>Recover the Vault</h3>
        <p>Enter the recovery key you saved when you created the Vault, then choose a new master password. A wrong key is refused in this browser before anything is sent.</p>
        {!brokerAvailable ? <DockNotice tone="warning">The server's Vault key broker is not running, so the Vault cannot open right now.</DockNotice> : null}
        <label className="vault-form">Recovery key<input type="password" autoComplete="off" spellCheck={false} value={recoveryKey} onChange={(event) => setRecoveryKey(event.target.value)} /></label>
        <PasswordPair busy={busy} submitLabel="Recover and set the new password" onSubmit={(next) => { if (recoveryKey.trim() && brokerAvailable) onRecover(recoveryKey, next); }} />
        <DockButton onClick={() => setRecovering(false)} disabled={busy}>Back to unlock</DockButton>
      </div>
    );
  }
  return (
    <form className="vault-card vault-form" onSubmit={(event) => { event.preventDefault(); if (password) onSubmit(password); }}>
      <h3>Unlock the Vault</h3>
      {!brokerAvailable ? <DockNotice tone="warning">The server's Vault key broker is not running, so the Vault cannot open right now.</DockNotice> : null}
      {pendingItems > 0 ? <DockNotice tone="info">{`${pendingItems} login${pendingItems === 1 ? "" : "s"} that agents saved or changed ${pendingItems === 1 ? "is" : "are"} added to Items when you unlock.`}</DockNotice> : null}
      <label>Master password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <DockButton type="submit" icon={Unlock} tone="primary" busy={busy} disabled={busy || !password || !brokerAvailable}>Unlock</DockButton>
      {hasRecovery ? <DockButton onClick={() => setRecovering(true)} disabled={busy}>Forgot it? Use the recovery key</DockButton> : null}
    </form>
  );
}

type Runner = (work: () => Promise<void>) => Promise<void>;
type Confirm = ReturnType<typeof useDockConfirm>["confirm"];

function ItemsView({ version, keys, run, confirm, defaults, vaultState, onVaultChanged }: {
  version: number; keys: { current: UnlockedVault | null }; run: Runner; confirm: Confirm; defaults: VaultDefaults; vaultState: VaultStateResponse; onVaultChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<VaultItemMetadata[] | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [records, setRecords] = useState<Record<string, VaultItemRecord>>({});
  const [stats, setStats] = useState<Record<string, VaultItemStats>>({});
  const reload = useCallback(async () => {
    const { items: listed, stats: listedStats } = await api.vaultItems();
    setItems(listed);
    setStats(listedStats ?? {});
    // Records hold only ciphertext; they tell which items carry an unconfirmed password change.
    // shortcut: one request per item; return a history count with the list once vaults hold more than ~100 items.
    setRecords(Object.fromEntries(await Promise.all(listed.map(async (item) => [item.id, (await api.vaultItem(item.id)).item] as const))));
  }, []);
  useEffect(() => { void run(reload); }, [reload, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (items ?? []).filter((item) => `${item.label} ${item.origins.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())), [items, search]);
  // Every change reaches agents and Nous at once while agent access is on.
  const changed = async () => { await reload(); await handOverToAgents(keys.current!); await onVaultChanged(); };
  const save = (record: Parameters<typeof api.vaultSaveItem>[0]) => run(async () => { await api.vaultSaveItem(record); await changed(); });
  const remove = (id: string) => run(async () => { await api.vaultDeleteItem(id); await changed(); });

  if (draft) {
    return <ItemEditor draft={draft} generator={defaults.generator} onCancel={() => setDraft(null)} onSave={(next) => run(async () => {
      const origins = next.origins.split(/\s+/).filter(Boolean).map((origin) => canonicalVaultOrigin(origin)?.origin ?? origin);
      const policy = { ...(next.previous?.metadata.policy ?? VAULT_AGENT_POLICY), agentUse: next.agentUse, acceptedOriginRisks: next.acceptedRisks.filter((origin) => origins.includes(origin)) };
      await api.vaultSaveItem(await encryptVaultItem(keys.current!, { id: next.id, label: next.label.trim(), origins, secrets: next.secrets, status: "ACTIVE", policy }, next.previous));
      setDraft(null); await changed();
    })} />;
  }
  if (!items) return <DockState kind="loading" title="Opening your items" />;
  return (
    <div className="vault-items">
      <AgentAccess vaultState={vaultState} run={run} onChange={async (enabled) => {
        await api.vaultSetAgentAccess(enabled);
        if (enabled) await handOverToAgents(keys.current!);
        await onVaultChanged();
      }} />
      <div className="vault-items-bar">
        <DockSearch value={search} onChange={setSearch} label="Search the Vault" placeholder="Search by name or address" />
        <DockButton icon={Plus} tone="primary" onClick={() => setDraft(emptyDraft())}>Add item</DockButton>
      </div>
      {shown.length === 0 ? <DockState kind="empty" icon={Vault} title={items.length ? "No item matches" : "No items yet"} detail={items.length ? undefined : "Add a login to keep it encrypted here."} /> : null}
      <ul className="vault-list">
        {shown.map((item) => {
          const record = records[item.id];
          const changed = (record?.history.length ?? 0) > 0;
          return (
            <li key={item.id} className="vault-row" data-status={item.status}>
              <div className="vault-row-main">
                <strong>{item.label}</strong>
                <span className="vault-origins">{item.origins.join(", ")}</span>
                {stats[item.id] ? <span className="vault-meta">{itemStatsLine(stats[item.id]!)}</span> : null}
                <span className="vault-tags">
                  {item.status === "PENDING" ? <span className="vault-tag is-pending">Pending</span> : null}
                  {changed ? <span className="vault-tag is-changed">New password not confirmed</span> : null}
                  {!item.policy.agentUse ? <span className="vault-tag">Hidden from agents</span> : null}
                </span>
              </div>
              <div className="vault-row-actions">
                <DockButton icon={Pencil} aria-label={`Edit ${item.label}`} onClick={() => void run(async () => {
                  const full = (await api.vaultItem(item.id)).item;
                  const secrets = await decryptVaultItem(keys.current!, full);
                  setDraft({ id: item.id, label: item.label, origins: item.origins.join("\n"), acceptedRisks: item.policy.acceptedOriginRisks, secrets, agentUse: item.policy.agentUse, previous: full });
                })} />
                <DockButton icon={Trash2} tone="danger" aria-label={`Delete ${item.label}`} onClick={() => void (async () => {
                  if (await confirm({ title: `Delete ${item.label}?`, message: "Its encrypted fields are deleted for good.", confirmLabel: "Delete" })) await remove(item.id);
                })()} />
              </div>
              {record && (item.status === "PENDING" || changed) ? <div className="vault-row-review">
                <DockButton tone="primary" onClick={() => void save(confirmVaultItem(record))}>{changed ? "Confirm new password" : "Keep"}</DockButton>
                <DockButton onClick={() => void (async () => {
                  const previous = restorePreviousVaultItem(record);
                  if (previous) return save(previous);
                  if (await confirm({ title: `Discard ${item.label}?`, message: "The item and its generated password are deleted.", confirmLabel: "Discard" })) await remove(item.id);
                })()}>{changed ? "Restore previous" : "Discard"}</DockButton>
              </div> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The one switch (operator decision 2026-10-18): on, agents and Nous fill and save logins with no further approval. */
function AgentAccess({ vaultState, run, onChange }: { vaultState: VaultStateResponse; run: Runner; onChange: (enabled: boolean) => Promise<void> }) {
  return (
    <div className="vault-card" role="region" aria-label="Agent access">
      <SpaceToggle compact checked={vaultState.agentAccess} label="Agents and Nous can use my Vault"
        detail="They fill and save logins without asking. Space types each password at the login's own address; they never see it."
        onChange={(enabled) => void run(() => onChange(enabled))} />
    </div>
  );
}

function ItemEditor({ draft: initial, generator, onCancel, onSave }: { draft: Draft; generator: VaultPasswordPolicy; onCancel: () => void; onSave: (draft: Draft) => void }) {
  const [draft, setDraft] = useState(initial);
  const [reveal, setReveal] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setSecret = (role: keyof VaultItemSecrets, value: string) => set({ secrets: { ...draft.secrets, [role]: value || undefined } });
  const origins = draft.origins.split(/\s+/).filter(Boolean).map((raw) => ({ raw, parsed: canonicalVaultOrigin(raw) }));
  const invalid = origins.some((origin) => !origin.parsed);
  const unaccepted = origins.some((origin) => origin.parsed && origin.parsed.warnings.length > 0 && !draft.acceptedRisks.includes(origin.parsed.origin));
  const canSave = draft.label.trim() && origins.length > 0 && !invalid && !unaccepted && Object.values(draft.secrets).some(Boolean);
  const submit = (event: FormEvent) => { event.preventDefault(); if (canSave) onSave(draft); };
  return (
    <form className="vault-card vault-form vault-editor" onSubmit={submit}>
      <h3>{draft.id ? "Edit item" : "Add item"}</h3>
      <label>Name<input value={draft.label} maxLength={80} onChange={(event) => set({ label: event.target.value })} /></label>
      <label>Website address<input value={draft.origins} placeholder="https://accounts.example.com" onChange={(event) => set({ origins: event.target.value })} /></label>
      {origins.map(({ raw, parsed }) => !parsed ? <p key={raw} className="vault-hint is-error">{raw} is not a web address (wildcards and passwords in addresses are not allowed).</p>
        : parsed.warnings.length ? <SpaceToggle key={raw} checked={draft.acceptedRisks.includes(parsed.origin)} label={`Allow ${parsed.origin}`}
          detail={`This address is ${parsed.warnings.map((warning) => warningText[warning]).join(" and ")}.`}
          onChange={(checked) => set({ acceptedRisks: checked ? [...draft.acceptedRisks, parsed.origin] : draft.acceptedRisks.filter((origin) => origin !== parsed.origin) })} />
        : parsed.origin !== raw ? <p key={raw} className="vault-hint">Saved as {parsed.origin}</p> : null)}
      <label>Username<input autoComplete="off" value={draft.secrets.USERNAME ?? ""} onChange={(event) => setSecret("USERNAME", event.target.value)} /></label>
      <div className="vault-password-row">
        <label>Password<input type={reveal ? "text" : "password"} autoComplete="new-password" value={draft.secrets.PASSWORD ?? ""} onChange={(event) => setSecret("PASSWORD", event.target.value)} /></label>
        <DockButton icon={reveal ? EyeOff : Eye} aria-label={reveal ? "Hide password" : "Show password"} onClick={() => setReveal(!reveal)} />
        <DockButton icon={RefreshCw} onClick={() => {
          try { setSecret("PASSWORD", generateVaultPassword({}, generator)); setGenerateError(null); } catch { setGenerateError("The generator rules in Settings allow no password."); }
        }}>Generate</DockButton>
      </div>
      {generateError ? <p className="vault-hint is-error">{generateError}</p> : null}
      <SpaceToggle checked={draft.agentUse} label="Agents and Nous can use this login" detail="When agent access is on. They never see it; Space fills it only at this address." onChange={(agentUse) => set({ agentUse })} />
      <details className="vault-more">
        <summary>More options</summary>
        <label>Authenticator key<input type="password" autoComplete="off" value={draft.secrets.OTP ?? ""} onChange={(event) => setSecret("OTP", event.target.value.replace(/\s+/g, ""))} /></label>
      </details>
      <div className="vault-form-actions">
        <DockButton type="submit" tone="primary" disabled={!canSave}>Save</DockButton>
        <DockButton onClick={onCancel}>Cancel</DockButton>
      </div>
    </form>
  );
}

/** "Added 19 Oct 08:31 · changed … · used 3 times, last …": which login is older, and how often it was filled. */
function itemStatsLine(stats: VaultItemStats): string {
  const changed = Date.parse(stats.changedAt) - Date.parse(stats.addedAt) > 60_000 ? ` · changed ${formatUserTime(stats.changedAt, { withDate: true })}` : "";
  const used = stats.uses ? `used ${stats.uses} time${stats.uses === 1 ? "" : "s"}, last ${formatUserTime(stats.lastUsedAt, { withDate: true })}` : "never used";
  return `Added ${formatUserTime(stats.addedAt, { withDate: true })}${changed} · ${used}`;
}

function AuditView() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.vaultAudit>>["entries"]>([]);
  // Which login each line is about; two logins with one name are told apart by when they were added.
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void api.vaultItems().then(({ items, stats }) => setNames(Object.fromEntries(items.map((item) => {
      const twin = items.some((other) => other.id !== item.id && other.label === item.label) && stats?.[item.id];
      return [item.id, twin ? `${item.label} (added ${formatUserTime(stats![item.id]!.addedAt, { withDate: true })})` : item.label];
    }))), () => undefined);
  }, []);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const more = useCallback(async (before?: number) => {
    const page = await api.vaultAudit(before);
    setEntries((current) => before ? [...current, ...page.entries] : page.entries);
    setNext(page.nextBeforeSeq);
  }, []);
  useEffect(() => { void more(); }, [more]);
  // Back-to-back identical events (an agent listing the Vault six times) show as one line with a count.
  const lines = useMemo(() => entries.reduce<Array<{ id: string; at: string; text: string; count: number }>>((all, { id, createdAt, event }) => {
    const words = (value: string) => value.toLowerCase().replace(/_/g, " ");
    const text = `${words(event.actor)} · ${words(event.action)} · ${words(event.result)}${event.reason ? ` (${words(event.reason)})` : ""}${event.itemId ? ` · ${names[event.itemId] ?? "deleted login"}` : ""}`;
    const last = all.at(-1);
    if (last?.text === text) last.count += 1; else all.push({ id, at: createdAt, text, count: 1 });
    return all;
  }, []), [entries, names]);
  if (next === undefined) return <DockState kind="loading" title="Loading activity" />;
  return (
    <div className="vault-audit">
      <ul className="vault-list">
        {lines.map((line) => (
          <li key={line.id} className="vault-row vault-audit-row">
            <span className="vault-audit-time">{formatUserTime(line.at, { withDate: true })}</span>
            <span>{line.count > 1 ? `${line.text} ×${line.count}` : line.text}</span>
          </li>
        ))}
      </ul>
      {next ? <DockButton onClick={() => void more(next)}>Load more</DockButton> : null}
    </div>
  );
}

function SettingsView({ run, confirm, busy, defaults, onDefaultsChange, autoLock, onAutoLockChange, onChangePassword }: {
  run: Runner; confirm: Confirm; defaults: VaultDefaults; onDefaultsChange: (next: VaultDefaults) => void;
  busy: boolean; autoLock: VaultAutoLockSettings; onAutoLockChange: (next: VaultAutoLockSettings) => void; onChangePassword: (password: string) => void;
}) {
  const generator = (patch: Partial<VaultPasswordPolicy>) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, ...patch } });
  return (
    <div className="vault-settings">
      <div className="vault-card vault-form">
        <h3>Auto-lock</h3>
        <label>Lock after inactivity
          <select value={autoLock.idleMinutes} onChange={(event) => onAutoLockChange({ ...autoLock, idleMinutes: Number(event.target.value) })}>
            {VAULT_IDLE_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} minute${minutes === 1 ? "" : "s"}`}</option>)}
          </select>
        </label>
        <SpaceToggle compact checked={autoLock.lockOnHide} label="Lock when this tab is hidden or the computer sleeps" onChange={(lockOnHide) => onAutoLockChange({ ...autoLock, lockOnHide })} />
      </div>
      <div className="vault-card vault-form" role="region" aria-label="Password generator">
        <h3>Password generator</h3>
        <label>Length<input type="number" min={8} max={128} value={defaults.generator.length}
          onChange={(event) => generator({ length: Math.min(128, Math.max(8, Number(event.target.value) || 24)) })} /></label>
        <div className="vault-generator">
          <SpaceToggle compact checked={defaults.generator.lower} label="Lower case" onChange={(lower) => generator({ lower })} />
          <SpaceToggle compact checked={defaults.generator.upper} label="Upper case" onChange={(upper) => generator({ upper })} />
          <SpaceToggle compact checked={defaults.generator.digits} label="Digits" onChange={(digits) => generator({ digits })} />
          <SpaceToggle compact checked={defaults.generator.symbols.length > 0} label="Symbols" onChange={(on) => generator({ symbols: on ? VAULT_PASSWORD_SYMBOLS : "" })} />
        </div>
      </div>
      <details className="vault-card">
        <summary>Change master password</summary>
        <p>Your items stay as they are; the recovery key keeps working.</p>
        <PasswordPair busy={busy} submitLabel="Change master password" onSubmit={onChangePassword} />
      </details>
      <SignupGrants run={run} confirm={confirm} busy={busy} />
    </div>
  );
}

/**
 * Sign-up grants signed in the dock before the broker minted a one-use grant per sign-up under agent access (2026-10-18,
 * signup.ts): no longer signed here, only listed while one is active so it can be revoked.
 */
function SignupGrants({ run, confirm, busy }: { run: Runner; confirm: Confirm; busy: boolean }) {
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.vaultSignupGrants>>["grants"]>([]);
  const reload = useCallback(async () => setGrants((await api.vaultSignupGrants()).grants), []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  if (!grants.length) return null;
  return (
    <div className="vault-card" role="region" aria-label="Sign-up grants">
      <h3>Sign-up grants</h3>
      <p>Older permissions to create accounts on these sites. Agent access already covers sign-ups, so you can revoke them.</p>
      <ul className="vault-list">
        {grants.map((grant) => (
          <li key={grant.id} className="vault-row">
            <div className="vault-row-main">
              <strong>{grant.sites.join(", ")}</strong>
              <span className="vault-meta">Up to {grant.dailyCap} new account{grant.dailyCap === 1 ? "" : "s"} a day, until {formatUserTime(grant.expiresAt, { withDate: true })}</span>
            </div>
            <div className="vault-row-actions">
              <DockButton icon={ShieldOff} tone="danger" disabled={busy} aria-label={`Revoke the grant for ${grant.sites.join(", ")}`} onClick={() => void (async () => {
                if (await confirm({ title: "Revoke this sign-up grant?", message: "Agents can no longer create accounts on these sites under it. Accounts already created stay.", confirmLabel: "Revoke grant" })) {
                  await run(async () => { await api.vaultRevokeSignupGrant(grant.id); await reload(); });
                }
              })()}>Revoke</DockButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
