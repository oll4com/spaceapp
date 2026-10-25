import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  VAULT_PASSWORD_SYMBOLS, VaultCryptoError, canonicalVaultOrigin, generateVaultPassword,
  type VaultHandoffKey, type VaultItemMetadata, type VaultItemRecord, type VaultPasswordPolicy
} from "@space/contracts";
import { api } from "../../api.js";
import type { GoogleAccountSummary, VaultItemStats, VaultStateResponse } from "../../live-api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockNotice, DockSearch, DockState, DockToolbar, useDockConfirm } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Eye, EyeOff, FileUp, Lock, Pencil, Plus, RefreshCw, ShieldOff, Trash2, Unlink, Unlock, Vault } from "../ui-theme/app-icons.js";
import {
  VAULT_AGENT_POLICY, changeMasterPassword, confirmVaultItem, decryptVaultItem, deleteVaultItems, encryptVaultItem, planDuplicateRemoval, setUpVault,
  recoverVault, unlockVault, type UnlockedVault, type VaultItemSecrets
} from "./vault-client.js";
import { ChromeImportError, parseChromePasswords, planChromeImport, runChromeImport, type ChromeExport, type ChromeImportPlan } from "./chrome-import.js";
import { handOverToAgents, holdVaultKeys, lockVaultSession, openVaultInbox, subscribeVaultSession, vaultSessionKeys } from "./vault-session.js";
import { useVaultDefaults, type VaultDefaults } from "./vault-defaults.js";
import { VAULT_IDLE_CHOICES, useVaultAutoLockSettings, type VaultAutoLockSettings } from "./vault-auto-lock.js";
import "./vault.css";

// The Vault dock (plan clipboard:vEYtT6-bEN0J step 5). Everything secret is decrypted in this tab's memory (vault-session.ts)
// and dropped on Lock, Revoke, sign-out, a reload or the operator's auto-lock rules, not when the dock closes (operator
// decision 2026-10-19); the server sees ciphertext only. One switch lets agents and Nous use the Vault
// (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac): while it is on, the dock hands every login to the broker after
// each unlock and item change, and the logins agents saved are added on unlock.

type View = "items" | "keys" | "audit" | "settings";
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
    if (event.kind === "inbox-error") setNotice(event.message);
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
            <DockChips label="Vault view" value={view} onChange={setView} options={[{ id: "items", label: "Items" }, { id: "keys", label: "API keys" }, { id: "audit", label: "Activity" }, { id: "settings", label: "Settings" }]} />
            {view === "items" ? <ItemsView version={itemsVersion} keys={unlockedRef} run={run} confirm={confirm} defaults={defaults} vaultState={state} onVaultChanged={load} />
              : view === "keys" ? <KeysView run={run} confirm={confirm} busy={busy} agentAccess={state.agentAccess} />
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
  const [stats, setStats] = useState<Record<string, VaultItemStats>>({});
  const [importing, setImporting] = useState(false);
  const [checkingSites, setCheckingSites] = useState(false);
  // The Google accounts browser panes open (one shared profile each): a Chrome import's source, and the list's filter.
  const [accounts, setAccounts] = useState<GoogleAccountSummary[]>([]);
  const [accountFilter, setAccountFilter] = useState("");
  useEffect(() => { void Promise.resolve().then(() => api.listGoogleAccounts()).then((result) => setAccounts(result.accounts), () => undefined); }, []);
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.email ?? "Another Google account";
  const reload = useCallback(async () => {
    const { items: listed, stats: listedStats } = await api.vaultItems();
    setItems(listed);
    setStats(listedStats ?? {});
  }, []);
  useEffect(() => { void run(reload); }, [reload, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (items ?? []).filter((item) => `${item.label} ${item.origins.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase())
    && (!accountFilter || (accountFilter === "none" ? !item.googleAccountId : item.googleAccountId === accountFilter))), [items, search, accountFilter]);
  // Every change reaches agents and Nous at once while agent access is on.
  const changed = async () => { await reload(); await handOverToAgents(keys.current!); await onVaultChanged(); };
  const remove = (id: string) => run(async () => { await deleteVaultItems(api, keys.current!, [id]); await changed(); });
  // Duplicates (operator request 2026-10-22): the same site, username and account more than once; the most recent copy stays.
  const removeDuplicates = () => run(async () => {
    const records = (await api.vaultItemRecords()).items;
    const plan = await planDuplicateRemoval(keys.current!, records, stats);
    if (!plan.remove.length) { await confirm({ title: "No duplicate logins", message: "Every login (site, username and account) appears once.", confirmLabel: "OK" }); return; }
    const copies = plan.remove.length === 1 ? "1 older copy" : `${plan.remove.length} older copies`;
    if (!await confirm({ title: `Delete ${copies}?`, message: `${plan.groups} login${plan.groups === 1 ? " appears" : "s appear"} more than once with the same site, username and account. The most recently changed copy of each stays; ${copies} will be deleted.`, confirmLabel: "Delete duplicates" })) return;
    await deleteVaultItems(api, keys.current!, plan.remove);
    await changed();
  });

  if (draft) {
    return <ItemEditor draft={draft} generator={defaults.generator} onCancel={() => setDraft(null)} onSave={(next) => run(async () => {
      const origins = next.origins.split(/\s+/).filter(Boolean).map((origin) => canonicalVaultOrigin(origin)?.origin ?? origin);
      const policy = { ...(next.previous?.metadata.policy ?? VAULT_AGENT_POLICY), agentUse: next.agentUse, acceptedOriginRisks: next.acceptedRisks.filter((origin) => origins.includes(origin)) };
      await api.vaultSaveItem(await encryptVaultItem(keys.current!, { id: next.id, label: next.label.trim(), origins, secrets: next.secrets, status: "ACTIVE", policy }, next.previous));
      setDraft(null); await changed();
    })} />;
  }
  if (importing) return <ChromeImport keys={keys} accounts={accounts} run={run} onClose={() => setImporting(false)} onImported={changed} />;
  if (!items) return <DockState kind="loading" title="Opening your items" />;
  if (checkingSites) return <SiteCheck items={items} keys={keys} run={run} confirm={confirm} onClose={() => setCheckingSites(false)} onDeleted={changed} />;
  return (
    <div className="vault-items">
      <AgentAccess vaultState={vaultState} run={run} delegable={items.filter((item) => item.policy.agentUse && item.status === "ACTIVE").length} onChange={async (enabled) => {
        const result = await api.vaultSetAgentAccess(enabled);
        // Off revokes, which starts a new epoch: the signed requests of this tab follow it.
        if (typeof result.epoch === "number" && keys.current) holdVaultKeys({ ...keys.current, epoch: result.epoch });
        if (enabled) await handOverToAgents(keys.current!);
        await onVaultChanged();
      }} />
      <div className="vault-items-bar">
        <DockSearch value={search} onChange={setSearch} label="Search the Vault" placeholder="Search by name or address" />
        <DockButton icon={Plus} tone="primary" onClick={() => setDraft(emptyDraft())}>Add item</DockButton>
        <DockButton icon={FileUp} onClick={() => setImporting(true)}>Import from Chrome</DockButton>
        <DockButton icon={Unlink} disabled={!items.length} onClick={() => setCheckingSites(true)}>Check sites</DockButton>
        <DockButton icon={Trash2} disabled={items.length < 2} onClick={() => void removeDuplicates()}>Remove duplicates</DockButton>
      </div>
      {accounts.length ? <label className="vault-filter">Google account
        <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
          <option value="">All accounts</option>
          <option value="none">No account</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
        </select>
      </label> : null}
      {shown.length === 0 ? <DockState kind="empty" icon={Vault} title={items.length ? "No item matches" : "No items yet"} detail={items.length ? undefined : "Add a login to keep it encrypted here."} /> : null}
      <ul className="vault-list">
        {shown.map((item) => {
          return (
            <li key={item.id} className="vault-row" data-status={item.status}>
              <div className="vault-row-main">
                <strong>{item.label}</strong>
                <span className="vault-origins">{item.origins.join(", ")}</span>
                {stats[item.id] ? <span className="vault-meta">{itemStatsLine(stats[item.id]!)}</span> : null}
                <span className="vault-tags">
                  {item.googleAccountId ? <span className="vault-tag">{accountName(item.googleAccountId)}</span> : null}
                  {item.status === "PENDING" ? <span className="vault-tag is-pending">Pending</span> : null}
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
              {/* Only items saved before imports became ACTIVE (2026-10-19) are PENDING; a changed password needs no confirmation (operator 2026-10-21). */}
              {item.status === "PENDING" ? <div className="vault-row-review">
                <DockButton tone="primary" onClick={() => void run(async () => { await api.vaultSaveItem(confirmVaultItem((await api.vaultItem(item.id)).item)); await changed(); })}>Keep</DockButton>
                <DockButton onClick={() => void (async () => {
                  if (await confirm({ title: `Discard ${item.label}?`, message: "The item and its generated password are deleted.", confirmLabel: "Discard" })) await remove(item.id);
                })()}>Discard</DockButton>
              </div> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The one switch (operator decision 2026-10-18): on, agents and Nous fill and save logins with no further approval. */
function AgentAccess({ vaultState, run, delegable, onChange }: { vaultState: VaultStateResponse; run: Runner; delegable: number; onChange: (enabled: boolean) => Promise<void> }) {
  return (
    <div className="vault-card" role="region" aria-label="Agent access">
      <SpaceToggle compact checked={vaultState.agentAccess} label="Agents and Nous can use my Vault"
        detail="They fill and save logins without asking. Space types each password at the login's own address; they never see it."
        onChange={(enabled) => void run(() => onChange(enabled))} />
      {/* Only an older Vault broker hands over fewer: it takes the 200 logins used or changed most recently. */}
      {vaultState.agentAccess && vaultState.delegatedItems > 0 && delegable > vaultState.delegatedItems
        ? <p className="vault-hint">{`${vaultState.delegatedItems} of ${delegable} logins handed to agents; the rest after the next Vault broker update.`}</p> : null}
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

type SiteResult = Awaited<ReturnType<typeof api.vaultSiteCheck>>["results"][number];
const siteProblem = (result: SiteResult) => result.status === "NO_DNS" ? "The address no longer exists (no DNS name)." : `The site does not answer${result.detail ? ` (${result.detail})` : ""}.`;

/**
 * Check sites (operator request 2026-10-21): which logins' sites are gone. The API looks up only this Vault's own addresses,
 * in batches checked in parallel; a login is listed when none of its addresses answers. Delete one by one or the selected ones.
 */
function SiteCheck({ items, keys, run, confirm, onClose, onDeleted }: {
  items: VaultItemMetadata[]; keys: { current: UnlockedVault | null }; run: Runner; confirm: Confirm; onClose: () => void; onDeleted: () => Promise<void>;
}) {
  const [checked, setChecked] = useState(0);
  const [results, setResults] = useState<Map<string, SiteResult> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const origins = useMemo(() => [...new Set(items.flatMap((item) => item.origins))], [items]);
  useEffect(() => {
    let live = true;
    void run(async () => {
      const found = new Map<string, SiteResult>();
      const batches = Array.from({ length: Math.ceil(origins.length / 50) }, (_, index) => origins.slice(index * 50, index * 50 + 50));
      // Three batches at a time; the API checks each batch's sites in parallel too.
      for (let start = 0; start < batches.length; start += 3) {
        const answers = await Promise.all(batches.slice(start, start + 3).map((batch) => api.vaultSiteCheck(batch)));
        for (const result of answers.flatMap((answer) => answer.results)) found.set(result.origin, result);
        if (!live) return;
        setChecked(Math.min(origins.length, (start + 3) * 50));
      }
      if (live) setResults(found);
    });
    return () => { live = false; };
  }, [origins]); // eslint-disable-line react-hooks/exhaustive-deps
  const dead = useMemo(() => results ? items.filter((item) => !deleted.has(item.id) && item.origins.every((origin) => {
    const result = results.get(origin);
    return result && (result.status === "NO_DNS" || result.status === "UNREACHABLE");
  })) : [], [items, results, deleted]);
  const local = results ? [...results.values()].filter((result) => result.status === "LOCAL").length : 0;
  const remove = (ids: string[]) => run(async () => {
    const { deleted: count } = await deleteVaultItems(api, keys.current!, ids);
    setDeleted((current) => new Set([...current, ...ids]));
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
    if (count) await onDeleted();
  });
  const removeSelected = async () => {
    const ids = dead.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (ids.length && await confirm({ title: `Delete ${ids.length} login${ids.length === 1 ? "" : "s"}?`, message: "Their encrypted fields are deleted for good.", confirmLabel: "Delete" })) await remove(ids);
  };
  return (
    <div className="vault-card" role="region" aria-label="Check sites">
      <h3>Check sites</h3>
      {!results ? <p role="status">{`Checking ${origins.length} site${origins.length === 1 ? "" : "s"}… ${checked} done`}</p>
        : <p role="status">{dead.length ? `${dead.length} login${dead.length === 1 ? "" : "s"} point to sites that are gone or do not answer.` : "Every site answers."}
          {local ? ` ${local} site${local === 1 ? " is" : "s are"} on a local network and ${local === 1 ? "was" : "were"} not checked.` : ""}</p>}
      {dead.length ? <>
        <div className="vault-form-actions">
          <label className="vault-check"><input type="checkbox" checked={dead.every((item) => selected.has(item.id))}
            onChange={(event) => setSelected(event.target.checked ? new Set(dead.map((item) => item.id)) : new Set())} />Select all</label>
          <DockButton icon={Trash2} tone="danger" disabled={!dead.some((item) => selected.has(item.id))} onClick={() => void removeSelected()}>
            {`Delete selected (${dead.filter((item) => selected.has(item.id)).length})`}
          </DockButton>
        </div>
        <ul className="vault-list">
          {dead.map((item) => (
            <li key={item.id} className="vault-row">
              <input type="checkbox" aria-label={`Select ${item.label}`} checked={selected.has(item.id)}
                onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />
              <div className="vault-row-main">
                <strong>{item.label}</strong>
                <span className="vault-origins">{item.origins.join(", ")}</span>
                <span className="vault-meta">{siteProblem(results!.get(item.origins[0]!)!)}</span>
              </div>
              <div className="vault-row-actions">
                <DockButton icon={Trash2} tone="danger" aria-label={`Delete ${item.label}`} onClick={() => void remove([item.id])} />
              </div>
            </li>
          ))}
        </ul>
      </> : null}
      <DockButton onClick={onClose}>Done</DockButton>
    </div>
  );
}

const skipText = (parsed: ChromeExport) => [
  parsed.skipped.ANDROID_APP && `${parsed.skipped.ANDROID_APP} Android app${parsed.skipped.ANDROID_APP === 1 ? "" : "s"}`,
  parsed.skipped.NO_SITE && `${parsed.skipped.NO_SITE} without a web address`,
  parsed.skipped.NO_PASSWORD && `${parsed.skipped.NO_PASSWORD} without a password`
].filter(Boolean).join(", ");

/**
 * Import from Chrome (operator request 2026-10-21, plan clipboard:SMcT__jALB6R): the file is read and parsed only in this tab,
 * every login is encrypted here before it is saved, and the parsed rows are dropped when the import ends or is cancelled.
 */
function ChromeImport({ keys, accounts, run, onClose, onImported }: {
  keys: { current: UnlockedVault | null }; accounts: GoogleAccountSummary[]; run: Runner; onClose: () => void; onImported: () => Promise<void>;
}) {
  const [parsed, setParsed] = useState<ChromeExport | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [plan, setPlan] = useState<ChromeImportPlan | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const accountLabel = accounts.find((entry) => entry.id === account)?.email ?? "no Google account";
  const readFile = async (file: File | undefined) => {
    setParsed(null); setPlan(null); setFileError(null);
    if (!file) return;
    try { setParsed(parseChromePasswords(await file.text())); } catch (cause) { setFileError(cause instanceof ChromeImportError ? cause.message : "The file could not be read."); }
  };
  if (result) {
    return (
      <div className="vault-card" role="status">
        <h3>Import finished</h3>
        <p>{result}</p>
        <DockNotice tone="warning">Delete the CSV file from your computer now (and empty the trash): it holds every password in plain text.</DockNotice>
        <DockButton tone="primary" onClick={onClose}>Done</DockButton>
      </div>
    );
  }
  return (
    <div className="vault-card vault-form" role="region" aria-label="Import from Chrome">
      <h3>Import from Chrome</h3>
      <p>In Chrome, open Password Manager, Settings, Export passwords, then choose the file here. It is read only in this browser; each login is encrypted before it is saved.</p>
      <label>Chrome passwords file<input type="file" accept=".csv,text/csv" disabled={Boolean(progress)} onChange={(event) => void readFile(event.target.files?.[0])} /></label>
      {fileError ? <p className="vault-hint is-error">{fileError}</p> : null}
      <label>Exported from which Google account?
        <select value={account} disabled={Boolean(progress)} onChange={(event) => { setAccount(event.target.value); setPlan(null); }}>
          <option value="">No account</option>
          {accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.email}</option>)}
        </select>
      </label>
      {parsed && !plan ? <DockButton tone="primary" disabled={!parsed.logins.length} onClick={() => void run(async () => setPlan(await planChromeImport(api, keys.current!, parsed, account || null)))}>
        {parsed.logins.length ? `Check ${parsed.logins.length} login${parsed.logins.length === 1 ? "" : "s"}` : "No logins to import in this file"}
      </DockButton> : null}
      {parsed && plan ? <div role="status" aria-label="Import summary" className="vault-import-summary">
        <p><strong>{`${plan.add.length} new, ${plan.update.length} updated, ${plan.unchanged} unchanged`}</strong>{` · for ${accountLabel}`}</p>
        {skipText(parsed) ? <p>{`Skipped: ${skipText(parsed)}.`}</p> : null}
        {parsed.duplicates ? <p>{`${parsed.duplicates} repeated row${parsed.duplicates === 1 ? "" : "s"}: the last one is used.`}</p> : null}
        {parsed.notes ? <p>{`${parsed.notes} note${parsed.notes === 1 ? "" : "s"} not imported: Vault logins have no notes.`}</p> : null}
        {plan.update.length ? <p>An updated login keeps its old password in its history.</p> : null}
      </div> : null}
      {progress ? <p className="vault-hint" role="status">{progress}</p> : null}
      <div className="vault-form-actions">
        {plan && plan.add.length + plan.update.length > 0 ? <DockButton tone="primary" icon={FileUp} disabled={Boolean(progress)} onClick={() => void run(async () => {
          try {
            const saved = await runChromeImport(api, keys.current!, plan, (done, total) => setProgress(`Importing ${done} of ${total}…`));
            setProgress("Handing the logins to agents…");
            await onImported();
            setResult(`${saved} login${saved === 1 ? "" : "s"} saved for ${accountLabel}: ${plan.add.length} new, ${plan.update.length} updated, ${plan.unchanged} unchanged.`);
            setParsed(null); setPlan(null);
          } catch (error) {
            // Part of it may be saved: a new check compares again before anything else is imported.
            setPlan(null);
            throw error;
          } finally { setProgress(null); }
        })}>Import</DockButton> : null}
        {plan && plan.add.length + plan.update.length === 0 ? <p className="vault-hint">Everything in this file is already in the Vault.</p> : null}
        <DockButton disabled={Boolean(progress)} onClick={() => { setParsed(null); setPlan(null); onClose(); }}>Cancel</DockButton>
      </div>
    </div>
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

const KEY_HOURS = [[1, "1 hour"], [24, "1 day"], [168, "7 days"], [720, "30 days"]] as const;
const keyState = (key: VaultHandoffKey) => key.usedAt ? `Written by ${key.usedByPaneId ?? "an agent"} ${formatUserTime(key.usedAt, { withDate: true })}; the key is deleted`
  : !key.hasValue ? "Expired; the key is deleted"
  : key.takenAt ? `Taken by ${key.takenByPaneId ?? "an agent"} ${formatUserTime(key.takenAt, { withDate: true })}, not written yet`
  : `Waiting for an agent until ${formatUserTime(key.expiresAt, { withDate: true })}`;

/**
 * API keys for agents (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): paste a key, get an id, give it to an agent;
 * its space_vault_key_install writes the key into the file it belongs in without the key entering the agent's context, and the
 * key is deleted here once that succeeded. Space can read these keys (they are sealed with the API's key, not the Vault's):
 * they are for handing over, not for keeping; logins stay in Items.
 */
function KeysView({ run, confirm, busy, agentAccess }: { run: Runner; confirm: Confirm; busy: boolean; agentAccess: boolean }) {
  const [keys, setKeys] = useState<VaultHandoffKey[]>([]);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [hours, setHours] = useState<number>(168);
  const [issued, setIssued] = useState<VaultHandoffKey | null>(null);
  const [copied, setCopied] = useState(false);
  const reload = useCallback(async () => setKeys((await api.vaultHandoffKeys()).keys), []);
  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  const add = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { key } = await api.vaultCreateHandoffKey({ label: label.trim(), value, expiresInHours: hours });
      setIssued(key); setCopied(false); setLabel(""); setValue("");
      await reload();
    });
  };
  return (
    <div className="vault-items">
      <form className="vault-card" aria-label="New API key for an agent" onSubmit={add}>
        <h3>API keys for agents</h3>
        <p>Paste a key and give its id to an agent. The agent's <code>space_vault_key_install</code> writes the key into the file it belongs in; the key never enters the agent's conversation and is deleted here once it was written. Space can read these keys, so keep logins in Items.</p>
        {agentAccess ? null : <p className="vault-hint">Agents take keys only while "Agents and Nous can use my Vault" is on (Items).</p>}
        <label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} required placeholder="OpenAI key for the demo project" /></label>
        <label>Key<input type="password" value={value} onChange={(event) => setValue(event.target.value)} maxLength={4096} required autoComplete="off" spellCheck={false} /></label>
        <label>Expires in<select value={hours} onChange={(event) => setHours(Number(event.target.value))}>
          {KEY_HOURS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></label>
        <DockButton type="submit" icon={Plus} tone="primary" disabled={busy || !label.trim() || !value}>Add key</DockButton>
      </form>
      {issued ? (
        <div className="vault-card" role="status" aria-label="Key id for the agent">
          <p>Give this id to the agent for <strong>{issued.label}</strong>:</p>
          <p><code>{issued.id}</code></p>
          <DockButton onClick={() => { void navigator.clipboard?.writeText(issued.id).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy id"}</DockButton>
        </div>
      ) : null}
      {keys.length === 0 ? <DockState kind="empty" icon={Vault} title="No API keys waiting" detail="A key you add here is deleted as soon as an agent has written it where it belongs." /> : null}
      <ul className="vault-list">
        {keys.map((key) => (
          <li key={key.id} className="vault-row" data-status={key.usedAt || !key.hasValue ? "PENDING" : "ACTIVE"}>
            <div className="vault-row-main">
              <strong>{key.label}</strong>
              <span className="vault-meta"><code>{key.id}</code> · {keyState(key)}</span>
            </div>
            <div className="vault-row-actions">
              <DockButton icon={Trash2} tone="danger" disabled={busy} aria-label={`Delete the key ${key.label}`} onClick={() => void (async () => {
                if (await confirm({ title: key.hasValue ? "Delete this key?" : "Remove this receipt?", message: key.hasValue ? "An agent can no longer take it; paste it again if it is still needed." : "Only the record of its hand-over goes; the key itself is already deleted.", confirmLabel: "Delete" })) {
                  await run(async () => { await api.vaultDeleteHandoffKey(key.id); if (issued?.id === key.id) setIssued(null); await reload(); });
                }
              })()}>Delete</DockButton>
            </div>
          </li>
        ))}
      </ul>
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
