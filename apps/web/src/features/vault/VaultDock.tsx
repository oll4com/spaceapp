import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  VAULT_PASSWORD_SYMBOLS, VAULT_SIGNUP_GRANT_LIMITS, VaultCryptoError, canonicalVaultOrigin, generateVaultPassword, vaultSignupSite,
  type VaultItemMetadata, type VaultItemRecord, type VaultPasswordPolicy
} from "@space/contracts";
import { api } from "../../api.js";
import type { VaultStateResponse } from "../../live-api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockNotice, DockSearch, DockState, DockToolbar, useDockConfirm } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Eye, EyeOff, Lock, Pencil, Plus, RefreshCw, ShieldOff, Trash2, Unlock, Vault } from "../ui-theme/app-icons.js";
import {
  VAULT_AGENT_POLICY, changeMasterPassword, confirmVaultItem, decryptVaultItem, encryptVaultItem, importVaultPending, lockVaultKeys, restorePreviousVaultItem, setUpVault,
  signVaultSignupGrant, delegateVaultItems, unlockVault, vaultInboxKey, type UnlockedVault, type VaultItemSecrets
} from "./vault-client.js";
import { useVaultDefaults, type VaultDefaults } from "./vault-defaults.js";
import { VAULT_IDLE_CHOICES, useVaultAutoLock, useVaultAutoLockSettings, type VaultAutoLockReason, type VaultAutoLockSettings } from "./vault-auto-lock.js";
import "./vault.css";

// The Vault dock (plan clipboard:vEYtT6-bEN0J step 5). Everything secret is decrypted here, in this tab's memory, and
// dropped on Lock or when the dock closes; the server sees ciphertext only. One switch lets agents and Nous use the Vault
// (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac): while it is on, the dock hands every login to the broker after
// each unlock and item change, and the logins agents saved are added on unlock.

type View = "items" | "audit" | "settings";
interface Draft { id?: string; label: string; origins: string; acceptedRisks: string[]; secrets: VaultItemSecrets; agentUse: boolean; previous?: VaultItemRecord }
const MIN_MASTER = 12;
const emptyDraft = (): Draft => ({ label: "", origins: "", acceptedRisks: [], secrets: {}, agentUse: true });
const warningText = { INSECURE_HTTP: "not encrypted (http)", IP_LITERAL: "an IP address", PUNYCODE: "an international (punycode) name that can imitate another site" } as const;
const errorText = (error: unknown) => error instanceof VaultCryptoError ? "The master password is not correct." : error instanceof Error ? error.message : "Something went wrong.";

/**
 * While agent access is on, hands every login not hidden from agents to the broker again (a new delegation replaces the last),
 * so items added, changed or saved by agents become fillable. Nothing to hand over leaves the last delegation; the fill path
 * ignores items deleted or hidden since.
 */
async function handOverToAgents(keys: UnlockedVault): Promise<void> {
  const state = await api.vaultState();
  if (!state.agentAccess) return;
  const records = await Promise.all((await api.vaultItems()).items.map(async (item) => (await api.vaultItem(item.id)).item));
  await delegateVaultItems(api, keys, { records, delegationGeneration: state.vault?.delegationGeneration ?? 0, epoch: state.vault?.epoch });
}

export function VaultDock() {
  const [state, setState] = useState<VaultStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unlockedRef = useRef<UnlockedVault | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [view, setView] = useState<View>("items");
  const { confirm, confirmDialog } = useDockConfirm();
  const [autoLock, setAutoLock] = useVaultAutoLockSettings();
  const [defaults, setDefaults] = useVaultDefaults();

  const load = useCallback(async () => {
    try { setState(await api.vaultState()); setError(null); } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Keys never outlive the dock.
  useEffect(() => () => { lockVaultKeys(unlockedRef.current); unlockedRef.current = null; }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setNotice(null);
    try { await work(); } catch (cause) { setNotice(errorText(cause)); } finally { setBusy(false); }
  };
  const holdKeys = (keys: UnlockedVault) => { lockVaultKeys(unlockedRef.current); unlockedRef.current = keys; setUnlocked(true); };
  // After every unlock: the inbox key exists, logins agents saved meanwhile are added, and agents get the current items.
  const openInbox = async (keys: UnlockedVault) => {
    const count = await importVaultPending(api, keys, await vaultInboxKey(api, keys));
    if (count) setInfo(`Added ${count} login${count === 1 ? "" : "s"} that agents saved or changed.`);
    await handOverToAgents(keys);
    await load();
  };
  const dropKeys = () => { lockVaultKeys(unlockedRef.current); unlockedRef.current = null; setUnlocked(false); };
  const lock = () => run(async () => { dropKeys(); await api.vaultLock(); await load(); });
  // Keys go at once; telling the server (a new epoch) is best effort, as the tab may be leaving.
  useVaultAutoLock(unlocked, autoLock, (reason: VaultAutoLockReason) => {
    dropKeys();
    setNotice(reason === "IDLE" ? `The Vault locked after ${autoLock.idleMinutes} minute${autoLock.idleMinutes === 1 ? "" : "s"} without activity.`
      : reason === "SLEEP" ? "The Vault locked because the computer slept." : "The Vault locked because the tab was hidden.");
    void api.vaultLock().then(load, () => undefined);
  });
  const revoke = async () => {
    if (!await confirm({ title: "Revoke agent access?", message: "Agents and Nous stop using the Vault at once, until you turn agent access on again. No password is needed.", confirmLabel: "Revoke access" })) return;
    await run(async () => { const result = await api.vaultRevoke(); setNotice(`Agent access revoked (generation ${result.generation}).`); await load(); });
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
        {state.enrolled ? <DockButton icon={ShieldOff} tone="danger" onClick={() => void revoke()} disabled={busy}>Revoke agent access</DockButton> : null}
        {unlocked ? <DockButton icon={Lock} onClick={() => void lock()} disabled={busy}>Lock</DockButton> : null}
      </DockToolbar>
      {notice ? <DockNotice tone="error" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
      {info ? <DockNotice tone="info" onDismiss={() => setInfo(null)}>{info}</DockNotice> : null}
      {recoveryKey ? <RecoveryKey value={recoveryKey} onDone={() => setRecoveryKey(null)} />
        : !state.enrolled ? <SetupForm busy={busy} onSubmit={(password) => run(async () => {
          const created = await setUpVault(api, state.ownerUserId, password);
          holdKeys(created.unlocked); setRecoveryKey(created.recoveryKey); await openInbox(created.unlocked); await load();
        })} />
        : !unlocked ? <UnlockForm busy={busy} brokerAvailable={state.brokerAvailable} onSubmit={(password) => run(async () => { const keys = await unlockVault(api, state.ownerUserId, password); holdKeys(keys); await openInbox(keys); })} />
        : (
          <>
            <DockChips label="Vault view" value={view} onChange={setView} options={[{ id: "items", label: "Items" }, { id: "audit", label: "Activity" }, { id: "settings", label: "Settings" }]} />
            {view === "items" ? <ItemsView keys={unlockedRef} run={run} confirm={confirm} defaults={defaults} vaultState={state} onVaultChanged={load} />
              : view === "audit" ? <AuditView />
              : <SettingsView keys={unlockedRef} run={run} confirm={confirm} busy={busy} defaults={defaults} onDefaultsChange={setDefaults} autoLock={autoLock} onAutoLockChange={setAutoLock} onChangePassword={(password) => run(async () => { holdKeys(await changeMasterPassword(api, unlockedRef.current!, password)); setNotice(null); await load(); })} />}
          </>
        )}
      <p className="vault-risk">
        Agents never see your passwords: Space fills them into the page itself, only at the item's exact address. A site you
        trust can still read what you give it, and anyone with control of this device can see what you reveal here.
      </p>
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

function UnlockForm({ busy, brokerAvailable, onSubmit }: { busy: boolean; brokerAvailable: boolean; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  return (
    <form className="vault-card vault-form" onSubmit={(event) => { event.preventDefault(); if (password) onSubmit(password); }}>
      <h3>Unlock the Vault</h3>
      {!brokerAvailable ? <DockNotice tone="warning">The server's Vault key broker is not running, so the Vault cannot open right now.</DockNotice> : null}
      <label>Master password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <DockButton type="submit" icon={Unlock} tone="primary" busy={busy} disabled={busy || !password || !brokerAvailable}>Unlock</DockButton>
    </form>
  );
}

type Runner = (work: () => Promise<void>) => Promise<void>;
type Confirm = ReturnType<typeof useDockConfirm>["confirm"];

function ItemsView({ keys, run, confirm, defaults, vaultState, onVaultChanged }: {
  keys: { current: UnlockedVault | null }; run: Runner; confirm: Confirm; defaults: VaultDefaults; vaultState: VaultStateResponse; onVaultChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<VaultItemMetadata[] | null>(null);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [records, setRecords] = useState<Record<string, VaultItemRecord>>({});
  const reload = useCallback(async () => {
    const listed = (await api.vaultItems()).items;
    setItems(listed);
    // Records hold only ciphertext; they tell which items carry an unconfirmed password change.
    // shortcut: one request per item; return a history count with the list once vaults hold more than ~100 items.
    setRecords(Object.fromEntries(await Promise.all(listed.map(async (item) => [item.id, (await api.vaultItem(item.id)).item] as const))));
  }, []);
  useEffect(() => { void run(reload); }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
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
                <span className="vault-tags">
                  {item.status === "PENDING" ? <span className="vault-tag is-pending">Pending</span> : null}
                  {changed ? <span className="vault-tag is-changed">New password not confirmed</span> : null}
                  {!item.policy.agentUse ? <span className="vault-tag">Hidden from agents</span> : null}
                </span>
              </div>
              <div className="vault-row-actions">
                {record && (item.status === "PENDING" || changed) ? <>
                  <DockButton tone="primary" onClick={() => void save(confirmVaultItem(record))}>{changed ? "Confirm new password" : "Keep"}</DockButton>
                  <DockButton onClick={() => void (async () => {
                    const previous = restorePreviousVaultItem(record);
                    if (previous) return save(previous);
                    if (await confirm({ title: `Discard ${item.label}?`, message: "The item and its generated password are deleted.", confirmLabel: "Discard" })) await remove(item.id);
                  })()}>{changed ? "Restore previous" : "Discard"}</DockButton>
                </> : null}
                <DockButton icon={Pencil} aria-label={`Edit ${item.label}`} onClick={() => void run(async () => {
                  const full = (await api.vaultItem(item.id)).item;
                  const secrets = await decryptVaultItem(keys.current!, full);
                  setDraft({ id: item.id, label: item.label, origins: item.origins.join("\n"), acceptedRisks: item.policy.acceptedOriginRisks, secrets, agentUse: item.policy.agentUse, previous: full });
                })} />
                <DockButton icon={Trash2} tone="danger" aria-label={`Delete ${item.label}`} onClick={() => void (async () => {
                  if (await confirm({ title: `Delete ${item.label}?`, message: "Its encrypted fields are deleted for good.", confirmLabel: "Delete" })) await remove(item.id);
                })()} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The one switch (operator decision 2026-10-18): on, agents and Nous fill and save logins with no further approval. */
function AgentAccess({ vaultState, run, onChange }: { vaultState: VaultStateResponse; run: Runner; onChange: (enabled: boolean) => Promise<void> }) {
  const count = vaultState.delegatedItems;
  return (
    <div className="vault-card" role="region" aria-label="Agent access">
      <SpaceToggle checked={vaultState.agentAccess} label="Agents and Nous can use my Vault"
        detail="They fill your logins into the page and save the accounts they create, without asking each time. Space types every password itself, only at the login's own address; they never see it."
        onChange={(enabled) => void run(() => onChange(enabled))} />
      {vaultState.agentAccess ? <p className="vault-hint" role="status">{count} login{count === 1 ? " is" : "s are"} ready for them. This keeps working while the Vault is locked; new logins become usable after your next unlock.</p> : null}
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

function AuditView() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.vaultAudit>>["entries"]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const more = useCallback(async (before?: number) => {
    const page = await api.vaultAudit(before);
    setEntries((current) => before ? [...current, ...page.entries] : page.entries);
    setNext(page.nextBeforeSeq);
  }, []);
  useEffect(() => { void more(); }, [more]);
  if (next === undefined) return <DockState kind="loading" title="Loading activity" />;
  return (
    <div className="vault-audit">
      <ul className="vault-list">
        {entries.map((entry) => (
          <li key={entry.id} className="vault-row">
            <span className="vault-audit-time">{formatUserTime(entry.createdAt, { withDate: true })}</span>
            <span>{entry.event.actor.toLowerCase()} · {entry.event.action.toLowerCase().replace(/_/g, " ")} · {entry.event.result.toLowerCase().replace(/_/g, " ")}{entry.event.reason ? ` (${entry.event.reason.toLowerCase().replace(/_/g, " ")})` : ""}</span>
          </li>
        ))}
      </ul>
      {next ? <DockButton onClick={() => void more(next)}>Load more</DockButton> : null}
    </div>
  );
}

function SettingsView({ keys, run, confirm, busy, defaults, onDefaultsChange, autoLock, onAutoLockChange, onChangePassword }: {
  keys: { current: UnlockedVault | null }; run: Runner; confirm: Confirm; defaults: VaultDefaults; onDefaultsChange: (next: VaultDefaults) => void;
  busy: boolean; autoLock: VaultAutoLockSettings; onAutoLockChange: (next: VaultAutoLockSettings) => void; onChangePassword: (password: string) => void;
}) {
  return (
    <div className="vault-settings">
      <div className="vault-card vault-form">
        <h3>Auto-lock</h3>
        <label>Lock after inactivity
          <select value={autoLock.idleMinutes} onChange={(event) => onAutoLockChange({ ...autoLock, idleMinutes: Number(event.target.value) })}>
            {VAULT_IDLE_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Never" : `${minutes} minute${minutes === 1 ? "" : "s"}`}</option>)}
          </select>
        </label>
        <SpaceToggle checked={autoLock.lockOnHide} label="Lock when this tab is hidden or the computer sleeps" onChange={(lockOnHide) => onAutoLockChange({ ...autoLock, lockOnHide })} />
      </div>
      <div className="vault-card vault-form" role="region" aria-label="Password generator">
        <h3>Password generator</h3>
        <p>What Generate makes when you add or edit an item.</p>
        <label>Length<input type="number" min={8} max={128} value={defaults.generator.length}
          onChange={(event) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, length: Math.min(128, Math.max(8, Number(event.target.value) || 24)) } })} /></label>
        <SpaceToggle compact checked={defaults.generator.lower} label="Lower-case letters (a-z)" onChange={(lower) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, lower } })} />
        <SpaceToggle compact checked={defaults.generator.upper} label="Capital letters (A-Z)" onChange={(upper) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, upper } })} />
        <SpaceToggle compact checked={defaults.generator.digits} label="Digits (0-9)" onChange={(digits) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, digits } })} />
        <SpaceToggle compact checked={defaults.generator.symbols.length > 0} label="Symbols" onChange={(on) => onDefaultsChange({ ...defaults, generator: { ...defaults.generator, symbols: on ? VAULT_PASSWORD_SYMBOLS : "" } })} />
      </div>
      <div className="vault-card">
        <h3>Change master password</h3>
        <p>Your items stay as they are; only the lock around them changes. The recovery key keeps working.</p>
        <PasswordPair busy={busy} submitLabel="Change master password" onSubmit={onChangePassword} />
      </div>
      <SignupGrants keys={keys} run={run} confirm={confirm} busy={busy} />
    </div>
  );
}

/**
 * Sign-up grants (NEW_ACCOUNT option B): the exact sites where agents may create new accounts. The unlocked dock signs each
 * grant with the Vault unlock key; no site is filled in for the operator.
 */
function SignupGrants({ keys, run, confirm, busy }: { keys: { current: UnlockedVault | null }; run: Runner; confirm: Confirm; busy: boolean }) {
  const limits = VAULT_SIGNUP_GRANT_LIMITS;
  const [grants, setGrants] = useState<Awaited<ReturnType<typeof api.vaultSignupGrants>>["grants"] | null>(null);
  const [sites, setSites] = useState("");
  const [dailyCap, setDailyCap] = useState<number>(limits.defaultDailyCap);
  const [days, setDays] = useState<number>(limits.defaultDays);
  const reload = useCallback(async () => setGrants((await api.vaultSignupGrants()).grants), []);
  useEffect(() => { void reload().catch(() => setGrants([])); }, [reload]);
  const parsed = sites.split(/\s+/).filter(Boolean).map((raw) => ({ raw, site: vaultSignupSite(raw) }));
  const unique = [...new Set(parsed.map((entry) => entry.site).filter((site): site is string => Boolean(site)))];
  const problem = parsed.length === 0 ? "Add at least one site." : parsed.some((entry) => !entry.site) ? null
    : unique.length > limits.maxSites ? `At most ${limits.maxSites} sites.` : null;
  const canSign = !problem && parsed.every((entry) => entry.site) && dailyCap >= 1 && dailyCap <= limits.maxDailyCap && days >= 1 && days <= limits.maxDays;
  const sign = (event: FormEvent) => {
    event.preventDefault();
    if (!canSign) return;
    void run(async () => {
      await api.vaultCreateSignupGrant(await signVaultSignupGrant(keys.current!, { sites: unique, dailyCap, days }));
      setSites(""); setDailyCap(limits.defaultDailyCap); setDays(limits.defaultDays);
      await reload();
    });
  };
  return (
    <div className="vault-card" role="region" aria-label="Sign-up grants">
      <h3>Sign-up grants</h3>
      <p>Optional: on the exact sites you sign here, agents can create new accounts with a fresh random password that Space
        generates and types itself, so not even the agent knows it. It is added to Items on your next unlock. Agent access must
        also be on. Elsewhere, agents save the accounts they create with their own password.</p>
      {grants === null ? <DockState kind="loading" title="Loading grants" /> : grants.length === 0 ? <p className="vault-hint">No active grants.</p> : (
        <ul className="vault-list">
          {grants.map((grant) => (
            <li key={grant.id} className="vault-row">
              <div className="vault-row-main">
                <strong>{grant.sites.join(", ")}</strong>
                <span className="vault-origins">Up to {grant.dailyCap} new account{grant.dailyCap === 1 ? "" : "s"} a day, until {formatUserTime(grant.expiresAt, { withDate: true })}</span>
              </div>
              <div className="vault-row-actions">
                <DockButton icon={ShieldOff} tone="danger" disabled={busy} aria-label={`Revoke the grant for ${grant.sites.join(", ")}`} onClick={() => void (async () => {
                  if (await confirm({ title: "Revoke this sign-up grant?", message: "Agents can no longer create accounts on these sites. Accounts already created stay.", confirmLabel: "Revoke grant" })) {
                    await run(async () => { await api.vaultRevokeSignupGrant(grant.id); await reload(); });
                  }
                })()}>Revoke</DockButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="vault-form" onSubmit={sign}>
        <label>Sites (exact https addresses, one per line)<textarea rows={3} value={sites} placeholder="https://www.example.com" onChange={(event) => setSites(event.target.value)} /></label>
        {parsed.map(({ raw, site }) => !site ? <p key={raw} className="vault-hint is-error">{raw} is not an exact https site (no wildcards, ports, IP addresses or international look-alike names).</p>
          : site !== raw ? <p key={raw} className="vault-hint">Signed as {site}</p> : null)}
        <label>New accounts per day<input type="number" min={1} max={limits.maxDailyCap} value={dailyCap} onChange={(event) => setDailyCap(Math.trunc(Number(event.target.value)))} /></label>
        <label>Valid for (days)<input type="number" min={1} max={limits.maxDays} value={days} onChange={(event) => setDays(Math.trunc(Number(event.target.value)))} /></label>
        {sites.trim() && problem ? <p className="vault-hint">{problem}</p> : null}
        <DockButton type="submit" tone="primary" busy={busy} disabled={busy || !canSign}>Sign grant</DockButton>
      </form>
    </div>
  );
}
