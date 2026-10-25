import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultKeyFromSeed, type VaultItemRecord } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  vaultState: vi.fn(), vaultItems: vi.fn(), vaultItem: vi.fn(), vaultSaveItem: vi.fn(), vaultRevoke: vi.fn(),
  vaultLock: vi.fn(), vaultAudit: vi.fn(), setUpVault: vi.fn(), unlockVault: vi.fn(), recoverVault: vi.fn(), encryptVaultItem: vi.fn(), decryptVaultItem: vi.fn(),
  vaultSetAgentAccess: vi.fn(), vaultInboxKey: vi.fn(), importVaultPending: vi.fn(), listGoogleAccounts: vi.fn(), vaultItemRecords: vi.fn(), vaultSaveItems: vi.fn(), vaultDeleteItems: vi.fn(), vaultSiteCheck: vi.fn(),
  vaultSignupGrants: vi.fn(), vaultCreateSignupGrant: vi.fn(), vaultRevokeSignupGrant: vi.fn(), signVaultSignupGrant: vi.fn(), delegateVaultItems: vi.fn(),
  vaultHandoffKeys: vi.fn(), vaultCreateHandoffKey: vi.fn(), vaultDeleteHandoffKey: vi.fn(), planDuplicateRemoval: vi.fn(),
  gatewayAnthropicAdmin: vi.fn(), saveGatewayAnthropicAdminKey: vi.fn(), removeGatewayAnthropicAdminKey: vi.fn(), syncGatewayAnthropicBilling: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: mocks }));
vi.mock("../src/features/vault/vault-client.js", async (original) => ({
  ...await original<typeof import("../src/features/vault/vault-client.js")>(),
  setUpVault: mocks.setUpVault, unlockVault: mocks.unlockVault, recoverVault: mocks.recoverVault, encryptVaultItem: mocks.encryptVaultItem, decryptVaultItem: mocks.decryptVaultItem,
  vaultInboxKey: mocks.vaultInboxKey, importVaultPending: mocks.importVaultPending, signVaultSignupGrant: mocks.signVaultSignupGrant, delegateVaultItems: mocks.delegateVaultItems,
  planDuplicateRemoval: mocks.planDuplicateRemoval
}));

import { VaultDock } from "../src/features/vault/VaultDock.js";
import { VaultInboxError } from "../src/features/vault/vault-client.js";
import { lockVaultSession, vaultSessionKeys } from "../src/features/vault/vault-session.js";
import { VAULT_AUTO_LOCK_KEY } from "../src/features/vault/vault-auto-lock.js";

// Synthetic values only; crypto is covered by vault-client.test.ts, this file covers the dock's states and actions.
const envelope = { v: 1, alg: "A256GCM", purpose: "ITEM_FIELD", keyVersion: 1, nonce: "A".repeat(16), ct: "B".repeat(40) } as const;
const policy = { agentUse: true, approvalMode: "ASSIST" as const, submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] };
const record = (id: string, label: string, status: "ACTIVE" | "PENDING", history: VaultItemRecord["history"] = [], googleAccountId: string | null = null): VaultItemRecord => ({
  metadata: { id, label, origins: ["https://shop.example"], fieldRoles: ["PASSWORD"], policy, status, googleAccountId, loginKey: null },
  keyVersion: 1, dekEnvelope: { ...envelope, purpose: "ITEM_KEY" }, fields: { PASSWORD: envelope }, history
});
// A real (synthetic-seed) unlock key: deletes and key changes are signed with it (Vault review 2026-10-22).
const signingKey = (await vaultKeyFromSeed("Ed25519", new Uint8Array(32))).privateKey;
const pending = record("vault_item:AAAAAAAAAAAAAAAAAAAAAA", "New shop account", "PENDING");
const changed = record("vault_item:BBBBBBBBBBBBBBBBBBBBBB", "Mail", "ACTIVE", [{ fields: { PASSWORD: envelope }, replacedAt: "2026-10-17T12:00:00.000Z" }]);
const state = (patch: Record<string, unknown> = {}) => ({ ownerUserId: "user:alice", enrolled: true, brokerAvailable: true, agentAccess: false, delegatedItems: 0,
  vault: { vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, delegationGeneration: 0, hasRecovery: true, auditSeq: 3 }, ...patch });

describe("VaultDock", () => {
  // The keys live for the tab (vault-session.ts): every test starts locked.
  afterEach(() => { lockVaultSession("LOCK"); });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.vaultItems.mockResolvedValue({ items: [pending.metadata, changed.metadata] });
    mocks.vaultItem.mockImplementation(async (id: string) => ({ item: id === pending.metadata.id ? pending : changed }));
    mocks.vaultSaveItem.mockResolvedValue({ item: pending });
    mocks.unlockVault.mockResolvedValue({ ownerUserId: "user:alice", vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, vrk: new Uint8Array(32), passwordShare: new Uint8Array(32), signingKey: new Uint8Array(signingKey) });
    mocks.vaultAudit.mockResolvedValue({ entries: [], nextBeforeSeq: null });
    mocks.delegateVaultItems.mockResolvedValue({ generation: 1, count: 1 });
    mocks.vaultSignupGrants.mockResolvedValue({ grants: [] });
    mocks.vaultHandoffKeys.mockResolvedValue({ keys: [] });
    mocks.vaultInboxKey.mockResolvedValue({ privateKey: new Uint8Array(48), publicKey: new Uint8Array(32) });
    mocks.importVaultPending.mockResolvedValue({ imported: 0, unreadable: [] });
    mocks.gatewayAnthropicAdmin.mockRejectedValue(new Error("Administrator permissions are required."));
    mocks.listGoogleAccounts.mockResolvedValue({ accounts: [] });
    mocks.vaultSaveItems.mockImplementation(async (items: unknown[]) => ({ saved: items.length, refused: 0 }));
    // The bulk read returns what the per-item reads of each test return.
    mocks.vaultItemRecords.mockImplementation(async () => ({ items: await Promise.all((await mocks.vaultItems()).items.map(async (item: { id: string }) => (await mocks.vaultItem(item.id)).item)) }));
  });

  it("says the Vault is not ready while the server has no broker", async () => {
    mocks.vaultState.mockResolvedValue(state({ enrolled: false, brokerAvailable: false, vault: null }));
    render(<VaultDock />);
    expect(await screen.findByText("The Vault is not ready on this server")).toBeTruthy();
  });

  it("shows no service keys: the Anthropic admin key lives in Space Gateway only (operator request 2026-10-18)", async () => {
    mocks.vaultState.mockResolvedValue(state({ enrolled: false, brokerAvailable: false, vault: null }));
    mocks.gatewayAnthropicAdmin.mockResolvedValue({ configured: true, keyHint: "…aaaa", savedAt: null, lastSyncAt: null, lastError: null, upstream: [] });
    render(<VaultDock />);
    expect(await screen.findByText("The Vault is not ready on this server")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Keys for Space services" })).toBeNull();
    expect(mocks.gatewayAnthropicAdmin).not.toHaveBeenCalled();
  });

  it("sets up with a long enough master password and shows the recovery key once", async () => {
    mocks.vaultState.mockResolvedValue(state({ enrolled: false, vault: null }));
    mocks.setUpVault.mockResolvedValue({ unlocked: await mocks.unlockVault(), recoveryKey: "SYNTHETIC-recovery-key" });
    render(<VaultDock />);
    const create = await screen.findByRole("button", { name: "Create Vault" });
    const [password, again] = screen.getAllByLabelText(/Master password|Repeat it/);
    fireEvent.change(password!, { target: { value: "short" } });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(password!, { target: { value: "a synthetic master" } });
    fireEvent.change(again!, { target: { value: "a synthetic master" } });
    fireEvent.click(create);
    expect(await screen.findByText("SYNTHETIC-recovery-key")).toBeTruthy();
    expect(mocks.setUpVault).toHaveBeenCalledWith(expect.anything(), "user:alice", "a synthetic master");
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    await waitFor(() => expect(screen.queryByText("SYNTHETIC-recovery-key")).toBeNull());
  });

  it("recovers with the recovery key and a new master password, then opens like an unlock (hardening step 14)", async () => {
    mocks.vaultState.mockResolvedValue(state());
    mocks.recoverVault.mockImplementation(async () => mocks.unlockVault());
    render(<VaultDock />);
    fireEvent.click(await screen.findByRole("button", { name: "Forgot it? Use the recovery key" }));
    fireEvent.change(screen.getByLabelText("Recovery key"), { target: { value: "SYNTHETIC-recovery-key" } });
    const [password, again] = screen.getAllByLabelText(/Master password|Repeat it/);
    fireEvent.change(password!, { target: { value: "a new synthetic master" } });
    fireEvent.change(again!, { target: { value: "a new synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Recover and set the new password" }));
    await waitFor(() => expect(mocks.recoverVault).toHaveBeenCalledWith(expect.anything(), "user:alice", "SYNTHETIC-recovery-key", "a new synthetic master"));
    expect(await screen.findByText(/old one no longer opens the Vault/)).toBeTruthy();
    expect(await screen.findByText("New shop account")).toBeTruthy();
  });

  it("stays unlocked when the dock closes; the background import and hand-over keep running (operator decision 2026-10-19)", async () => {
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = render(<VaultDock />);
      fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByText("New shop account");
      await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(1));
      view.unmount();
      expect(vaultSessionKeys()).not.toBeNull();
      // A tab hidden for a while no longer locks by default.
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      try { fireEvent(document, new Event("visibilitychange")); } finally {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      }
      mocks.importVaultPending.mockResolvedValue({ imported: 1, unreadable: [] });
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(2));
      expect(mocks.vaultLock).not.toHaveBeenCalled();
      // Opening the dock again shows it unlocked, without the master password.
      render(<VaultDock />);
      expect(await screen.findByText("New shop account")).toBeTruthy();
      expect(screen.queryByLabelText("Master password")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the keys only in the tab's memory: nothing in storage, a reload starts locked, Revoke locks", async () => {
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    mocks.vaultRevoke.mockResolvedValue({ generation: 1, epoch: 2 });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("New shop account");
    expect(sessionStorage.length).toBe(0);
    expect(Object.keys(localStorage).filter((key) => /vault/i.test(key) && key !== VAULT_AUTO_LOCK_KEY && !/defaults/i.test(key))).toEqual([]);
    // A reload is a fresh module: no keys.
    vi.resetModules();
    expect((await import("../src/features/vault/vault-session.js")).vaultSessionKeys()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke agent access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeTruthy();
    expect(vaultSessionKeys()).toBeNull();
  });

  it("says how many saved or changed logins the next unlock adds to Items (2026-10-19)", async () => {
    mocks.vaultState.mockResolvedValue(state({ pendingItems: 2 }));
    render(<VaultDock />);
    expect(await screen.findByText("2 logins that agents saved or changed are added to Items when you unlock.")).toBeTruthy();
  });

  it("shows an unusable inbox instead of swallowing it: a waiting login sealed to another key, or a stored key that does not open (Vault review 2026-10-22)", async () => {
    mocks.vaultState.mockResolvedValue(state());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<VaultDock />);
      fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByText("New shop account");
      // The 30 s import finds a waiting login this inbox cannot open: the dock says so, and keeps the login waiting.
      mocks.importVaultPending.mockResolvedValue({ imported: 0, unreadable: [{ kind: "CHANGE_PASSWORD", label: "Mail", origin: "https://mail.example" }] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await screen.findByText(/1 waiting login \(Mail\) cannot be opened with your inbox key and stay waiting/)).toBeTruthy();
      // A stored inbox key that does not open with the Vault's keys is reported the same way, every import.
      mocks.vaultInboxKey.mockRejectedValue(new VaultInboxError("INBOX_KEY_UNREADABLE", "The inbox key stored for your Vault does not open with your keys, so logins agents save or change cannot be added."));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await screen.findByText(/The inbox key stored for your Vault does not open with your keys/)).toBeTruthy();
      expect(mocks.delegateVaultItems).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no recovery when the Vault has no recovery key", async () => {
    mocks.vaultState.mockResolvedValue(state({ vault: { vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, delegationGeneration: 0, hasRecovery: false, auditSeq: 3 } }));
    render(<VaultDock />);
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forgot it? Use the recovery key" })).toBeNull();
  });

  it("unlocks, keeps a pending item, asks nothing about a changed password and revokes agent access", async () => {
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    mocks.vaultRevoke.mockResolvedValue({ generation: 1, epoch: 2 });
    render(<VaultDock />);
    expect(await screen.findByText(/Locked · Agents and Nous: on \(2 logins\)/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const pendingRow = (await screen.findByText("New shop account")).closest("li")!;
    expect(within(pendingRow).getByText("Pending")).toBeTruthy();
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(mocks.vaultSaveItem).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ id: pending.metadata.id, status: "ACTIVE" }), history: [] })));
    const changedRow = screen.getByText("Mail").closest("li")!;
    // Operator 2026-10-21: a changed password is simply the current one, with no confirm or restore step.
    expect(within(changedRow).queryByText("New password not confirmed")).toBeNull();
    expect(within(changedRow).queryByRole("button", { name: "Restore previous" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke agent access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(mocks.vaultRevoke).toHaveBeenCalledTimes(1));
  });

  it("adds the logins agents saved on unlock and hands every login to agents while agent access is on", async () => {
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    mocks.importVaultPending.mockResolvedValue({ imported: 2, unreadable: [] });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Added 2 logins that agents saved or changed.")).toBeTruthy();
    // No per-use approvals any more: the unlock alone re-delegates every item.
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA" }),
      { records: [changed], delegationGeneration: 0, epoch: 1, inbox: expect.objectContaining({ privateKey: expect.any(Uint8Array) }) }));
    expect(screen.queryByRole("region", { name: "Agent requests" })).toBeNull();
    expect(await screen.findByText(/Unlocked · Agents and Nous: on \(2 logins\)/)).toBeTruthy();
  });

  it("shows when each login was added and how often it was used, names it in Activity, and adds logins saved while unlocked", async () => {
    // Two logins with one name (operator request 2026-10-19): the added time tells the older one apart.
    const twin = record("vault_item:CCCCCCCCCCCCCCCCCCCCCC", "Mail", "ACTIVE");
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    mocks.vaultItems.mockResolvedValue({ items: [pending.metadata, changed.metadata, twin.metadata], stats: {
      [changed.metadata.id]: { addedAt: "2026-10-18T19:29:39.000Z", changedAt: "2026-10-18T19:29:39.000Z", uses: 2, lastUsedAt: "2026-10-19T04:30:00.000Z" },
      [twin.metadata.id]: { addedAt: "2026-10-19T05:31:51.000Z", changedAt: "2026-10-19T05:31:51.000Z", uses: 0, lastUsedAt: null } } });
    const listed = (seq: number) => ({ id: `vault_audit:LISTED${seq}AAAAAAAAAAAAAAA`, seq, createdAt: "2026-10-19T04:31:00.000Z",
      event: { actor: "AGENT", action: "AGENT_LIST", result: "LISTED", reason: null, itemId: null, origin: null, fields: [], paneId: null } });
    mocks.vaultAudit.mockResolvedValue({ entries: [listed(7), listed(6), listed(5), { id: "vault_audit:AAAAAAAAAAAAAAAAAAAAAA", seq: 4, createdAt: "2026-10-19T04:30:00.000Z",
      event: { actor: "AGENT", action: "FILL", result: "SUBMITTED", reason: null, itemId: twin.metadata.id, origin: null, fields: [], paneId: null } }], nextBeforeSeq: null });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<VaultDock />);
      fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      expect(await screen.findByText(/^Added .+ · used 2 times, last .+/)).toBeTruthy();
      expect(screen.getByText(/^Added .+ · never used$/)).toBeTruthy();
      // A password the Vault generates while the dock stays unlocked is added within 30 s and handed to agents.
      await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(1));
      mocks.importVaultPending.mockResolvedValue({ imported: 1, unreadable: [] });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await screen.findByText("Added 1 login that agents saved or changed.")).toBeTruthy();
      await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole("button", { name: "Activity" }));
      expect(await screen.findByText(/^agent · fill · submitted · Mail \(added .+\)$/)).toBeTruthy();
      // Back-to-back identical events read as one line.
      expect(screen.getByText("agent · agent list · listed ×3")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("locks itself when the tab is hidden, dropping the keys like Lock, when the operator turned that on", async () => {
    localStorage.setItem(VAULT_AUTO_LOCK_KEY, JSON.stringify({ idleMinutes: 0, lockOnHide: true }));
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultLock.mockResolvedValue({ epoch: 2 });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("New shop account");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      fireEvent(document, new Event("visibilitychange"));
      expect(await screen.findByText("The Vault locked because the tab was hidden.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Unlock" })).toBeTruthy();
      expect(screen.queryByText("New shop account")).toBeNull();
      await waitFor(() => expect(mocks.vaultLock).toHaveBeenCalledTimes(1));
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    }
  });

  it("removes duplicate logins, keeping the most recently changed copy of each (operator request 2026-10-22)", async () => {
    const older = record("vault_item:DDDDDDDDDDDDDDDDDDDDD1", "Shop", "ACTIVE");
    const newer = record("vault_item:DDDDDDDDDDDDDDDDDDDDD2", "Shop again", "ACTIVE");
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultItems.mockResolvedValue({ items: [older.metadata, newer.metadata], stats: {
      [older.metadata.id]: { addedAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-05T00:00:00.000Z", uses: 0, lastUsedAt: null },
      [newer.metadata.id]: { addedAt: "2026-10-02T00:00:00.000Z", changedAt: "2026-10-20T00:00:00.000Z", uses: 0, lastUsedAt: null } } });
    mocks.vaultItem.mockImplementation(async (id: string) => ({ item: id === older.metadata.id ? older : newer }));
    // The planning itself (decrypted usernames, newest copy kept) is covered in vault-client.test.ts; here the dock's flow around it.
    mocks.planDuplicateRemoval.mockResolvedValue({ groups: 1, remove: [older.metadata.id] });
    mocks.vaultDeleteItems.mockImplementation(async (body: { ids: string[] }) => ({ deleted: body.ids.length }));
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove duplicates" }));
    await waitFor(() => expect(mocks.planDuplicateRemoval).toHaveBeenCalledWith(expect.objectContaining({ vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA" }), [older, newer],
      expect.objectContaining({ [older.metadata.id]: expect.objectContaining({ changedAt: "2026-10-05T00:00:00.000Z" }) })));
    expect(await screen.findByText(/1 login appears more than once/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete duplicates" }));
    await waitFor(() => expect(mocks.vaultDeleteItems).toHaveBeenCalledWith(expect.objectContaining({ ids: [older.metadata.id] })));
    // Nothing to remove: one dialog says so, nothing is deleted.
    mocks.vaultDeleteItems.mockClear();
    mocks.planDuplicateRemoval.mockResolvedValue({ groups: 0, remove: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Remove duplicates" }));
    expect(await screen.findByText("No duplicate logins")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(mocks.vaultDeleteItems).not.toHaveBeenCalled();
  });

  it("hands an API key to agents: the id shows once, the list shows states and never the key, a receipt can be deleted (operator request 2026-10-22)", async () => {
    const key = { id: "vault_key:AAAAAAAAAAAAAAAAAAAAAA", label: "Synthetic service", createdAt: "2026-10-22T05:00:00.000Z", expiresAt: "2026-10-29T05:00:00.000Z",
      takenAt: null, takenByPaneId: null, usedAt: null, usedByPaneId: null, hasValue: true };
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 1 }));
    mocks.vaultHandoffKeys.mockResolvedValueOnce({ keys: [] }).mockResolvedValue({ keys: [{ ...key, takenAt: "2026-10-22T05:05:00.000Z", takenByPaneId: "pane:agent1", usedAt: "2026-10-22T05:10:00.000Z", usedByPaneId: "pane:agent1", hasValue: false }] });
    mocks.vaultCreateHandoffKey.mockResolvedValue({ key });
    mocks.vaultDeleteHandoffKey.mockResolvedValue({ deleted: true });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "API keys" }));
    const form = await screen.findByRole("form", { name: "New API key for an agent" });
    fireEvent.change(within(form).getByLabelText("Label"), { target: { value: "Synthetic service" } });
    fireEvent.change(within(form).getByLabelText("Key"), { target: { value: "SYNTHETIC-api-key-value" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(mocks.vaultCreateHandoffKey).toHaveBeenCalledWith({ label: "Synthetic service", value: "SYNTHETIC-api-key-value", expiresInHours: 168 }));
    const issued = await screen.findByRole("status", { name: "Key id for the agent" });
    expect(within(issued).getByText("vault_key:AAAAAAAAAAAAAAAAAAAAAA")).toBeTruthy();
    expect((within(form).getByLabelText("Key") as HTMLInputElement).value).toBe("");
    // The list names the state, never the value; a used key's receipt can go.
    expect(await screen.findByText(/Written by pane:agent1/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SYNTHETIC-api-key-value");
    fireEvent.click(screen.getByRole("button", { name: "Delete the key Synthetic service" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.vaultDeleteHandoffKey).toHaveBeenCalledWith(key.id));
  });

  it("signs no new sign-up grants; an active one is listed only to revoke it (operator request 2026-10-20)", async () => {
    const grant = { id: "vault_grant:AAAAAAAAAAAAAAAAAAAAAA", sites: ["https://shop.example"], dailyCap: 3, createdAt: "2026-10-18T02:00:00.000Z", expiresAt: "2026-11-17T02:00:00.000Z", revokedAt: null };
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultSignupGrants.mockResolvedValueOnce({ grants: [grant] }).mockResolvedValue({ grants: [] });
    mocks.vaultRevokeSignupGrant.mockResolvedValue({ revoked: true });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const card = await screen.findByRole("region", { name: "Sign-up grants" });
    expect(within(card).getByText("https://shop.example")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Sign grant" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Revoke the grant for https://shop.example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant" }));
    await waitFor(() => expect(mocks.vaultRevokeSignupGrant).toHaveBeenCalledWith(grant.id));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Sign-up grants" })).toBeNull());
  });

  it("keeps Add item simple: generator rules live in Settings, with no approval or protected-browser steps", async () => {
    localStorage.clear();
    mocks.vaultState.mockResolvedValue(state());
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe("true");
    const generator = await screen.findByRole("region", { name: "Password generator" });
    fireEvent.change(within(generator).getByLabelText("Length"), { target: { value: "12" } });
    expect(screen.queryByRole("region", { name: "Agent defaults" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Protected browsers" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Items" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    // The form shows only the basics; no generator rules in it.
    expect(screen.queryByLabelText("Length")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toHaveLength(12);
    // A new login is usable by agents unless the operator hides it; no approval mode to pick.
    expect((screen.getByRole("switch", { name: "Agents and Nous can use this login" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Without asking" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("space:vault-defaults:v1")!)).toMatchObject({ generator: { length: 12 } });
  });

  it("turns agent access on with one switch, handing every login over, and off again", async () => {
    let access = false;
    mocks.vaultState.mockImplementation(async () => state({ agentAccess: access, delegatedItems: access ? 1 : 0 }));
    mocks.vaultSetAgentAccess.mockImplementation(async (enabled: boolean) => { access = enabled; return { agentAccess: enabled }; });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const card = await screen.findByRole("region", { name: "Agent access" });
    expect(mocks.delegateVaultItems).not.toHaveBeenCalled();
    // Nothing to revoke while access is off.
    expect(screen.queryByRole("button", { name: "Revoke agent access" })).toBeNull();
    fireEvent.click(within(card).getByRole("switch", { name: "Agents and Nous can use my Vault" }));
    await waitFor(() => expect(mocks.vaultSetAgentAccess).toHaveBeenCalledWith(true));
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledWith(expect.anything(), expect.anything(), { records: [changed], delegationGeneration: 0, epoch: 1, inbox: expect.objectContaining({ privateKey: expect.any(Uint8Array) }) }));
    expect(await screen.findByText(/Agents and Nous: on \(1 login\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke agent access" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("switch", { name: "Agents and Nous can use my Vault" }));
    await waitFor(() => expect(mocks.vaultSetAgentAccess).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(screen.getByText(/Agents and Nous: off/)).toBeTruthy());
    expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(1);
  });

  it("generates a password in the editor and needs explicit acceptance of a risky address", async () => {
    mocks.vaultState.mockResolvedValue(state());
    mocks.encryptVaultItem.mockImplementation(async (_keys: unknown, draft: { label: string }) => ({ ...pending, metadata: { ...pending.metadata, label: draft.label, status: "ACTIVE" } }));
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic forum" } });
    fireEvent.change(screen.getByLabelText("Website address"), { target: { value: "http://forum.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.value).toHaveLength(24);
    expect(password.type).toBe("password");
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Allow http://forum.example" }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(mocks.encryptVaultItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      label: "Synthetic forum", origins: ["http://forum.example"], secrets: { PASSWORD: password.value },
      policy: expect.objectContaining({ acceptedOriginRisks: ["http://forum.example"], agentUse: true, approvalMode: "FULL", submitAllowed: true })
    }), undefined));
    expect(mocks.vaultSaveItem).toHaveBeenCalled();
  });
  // Chrome import (plan clipboard:SMcT__jALB6R): read and parsed in the tab, every login encrypted before it is saved.
  it("imports a Chrome passwords export for the chosen Google account, with one summary and a delete-the-file reminder", async () => {
    const CHROME_SECRET = "SYNTHETIC-chrome-dock-9f2b";
    mocks.vaultState.mockResolvedValue(state());
    mocks.listGoogleAccounts.mockResolvedValue({ accounts: [{ id: "google_account:work-1", email: "work@example.com", displayName: null, avatarUrl: null, isPrimary: true, browserStatus: "CONNECTED" }] });
    mocks.encryptVaultItem.mockImplementation(async (_keys: unknown, draft: { label: string; googleAccountId?: string | null }) =>
      ({ ...pending, metadata: { ...pending.metadata, label: draft.label, status: "ACTIVE", googleAccountId: draft.googleAccountId ?? null } }));
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import from Chrome" }));
    const csv = ["name,url,username,password,note", `shop,https://new-shop.example/login,ana@example.com,${CHROME_SECRET}-1,`,
      `mail,https://mail.example/,ana,${CHROME_SECRET}-2,"a note"`, `app,android://hash@com.example.app/,ana,${CHROME_SECRET}-3,`].join("\r\n");
    fireEvent.change(screen.getByLabelText("Chrome passwords file"), { target: { files: [Object.assign(new File([csv], "Google Passwords.csv", { type: "text/csv" }), { text: async () => csv })] } });
    fireEvent.change(screen.getByLabelText("Exported from which Google account?"), { target: { value: "google_account:work-1" } });
    fireEvent.click(await screen.findByRole("button", { name: "Check 2 logins" }));
    const summary = await screen.findByRole("status", { name: "Import summary" });
    expect(summary.textContent).toContain("2 new, 0 updated, 0 unchanged · for work@example.com");
    expect(summary.textContent).toContain("Skipped: 1 Android app.");
    expect(summary.textContent).toContain("1 note not imported");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/Delete the CSV file from your computer now/)).toBeTruthy();
    expect(screen.getByText("2 logins saved for work@example.com: 2 new, 0 updated, 0 unchanged.")).toBeTruthy();
    expect(mocks.encryptVaultItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ label: "shop", origins: ["https://new-shop.example"], googleAccountId: "google_account:work-1",
      secrets: { USERNAME: "ana@example.com", PASSWORD: `${CHROME_SECRET}-1` } }));
    // Both logins in one batch request.
    expect(mocks.vaultSaveItems).toHaveBeenCalledTimes(1);
    expect(mocks.vaultSaveItems.mock.calls[0]![0]).toHaveLength(2);
    // Only the (mocked) item crypto saw the passwords: no request, and no browser storage, carries one.
    for (const [name, mock] of Object.entries(mocks)) if (name !== "encryptVaultItem") expect(JSON.stringify(mock.mock.calls), name).not.toContain(CHROME_SECRET);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CHROME_SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CHROME_SECRET);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: "Import from Chrome" })).toBeTruthy();
  });

  it("shows each login's Google account and filters by account", async () => {
    const work = record("vault_item:DDDDDDDDDDDDDDDDDDDDDD", "Work shop", "ACTIVE", [], "google_account:work-1");
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultItems.mockResolvedValue({ items: [changed.metadata, work.metadata] });
    mocks.listGoogleAccounts.mockResolvedValue({ accounts: [{ id: "google_account:work-1", email: "work@example.com", displayName: null, avatarUrl: null, isPrimary: true, browserStatus: "CONNECTED" }] });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const row = (await screen.findByText("Work shop")).closest("li")!;
    expect(await within(row).findByText("work@example.com")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Google account"), { target: { value: "google_account:work-1" } });
    expect(screen.queryByText("Mail")).toBeNull();
    fireEvent.change(screen.getByLabelText("Google account"), { target: { value: "none" } });
    expect(screen.getByText("Mail")).toBeTruthy();
    expect(screen.queryByText("Work shop")).toBeNull();
  });
  it("offers every login to agents and, when an older broker refuses more than 200, hands over the 200 most recent instead of none", async () => {
    const many = Array.from({ length: 201 }, (_, index) => record(`vault_item:${String(index).padStart(22, "0")}`, `Login ${index}`, "ACTIVE"));
    const byId = new Map(many.map((item) => [item.metadata.id, item]));
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 200 }));
    mocks.vaultItems.mockResolvedValue({ items: many.map((item) => item.metadata), stats: { [many[200]!.metadata.id]: { addedAt: "2026-10-01T00:00:00.000Z", changedAt: "2026-10-21T00:00:00.000Z", uses: 0, lastUsedAt: null } } });
    mocks.vaultItemRecords.mockResolvedValue({ items: [...byId.values()] });
    mocks.delegateVaultItems.mockRejectedValueOnce(new Error("The delegation was refused; nothing changed.")).mockResolvedValue({ generation: 1, count: 200 });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(2));
    const [all, fallback] = mocks.delegateVaultItems.mock.calls.map((call) => (call[2] as { records: VaultItemRecord[] }).records);
    expect(all).toHaveLength(201);
    expect(fallback).toHaveLength(200);
    // The most recently changed login is kept.
    expect(fallback![0]!.metadata.id).toBe(many[200]!.metadata.id);
    expect(await screen.findByText("200 of 201 logins handed to agents; the rest after the next Vault broker update.")).toBeTruthy();
    // One bulk read for every login's envelopes, not one request per login.
    expect(mocks.vaultItemRecords).toHaveBeenCalled();
    expect(mocks.vaultItem).not.toHaveBeenCalled();
  });
  it("checks every login's site and deletes the gone ones one by one or together (operator request 2026-10-21)", async () => {
    const gone = record("vault_item:EEEEEEEEEEEEEEEEEEEEEE", "Gone shop", "ACTIVE");
    const down = record("vault_item:FFFFFFFFFFFFFFFFFFFFFF", "Down forum", "ACTIVE");
    const live = record("vault_item:GGGGGGGGGGGGGGGGGGGGGG", "Live mail", "ACTIVE");
    const router = record("vault_item:HHHHHHHHHHHHHHHHHHHHHH", "Router", "ACTIVE");
    const at = (item: VaultItemRecord, origin: string) => ({ ...item, metadata: { ...item.metadata, origins: [origin] } });
    const items = [at(gone, "https://gone.example"), at(down, "https://down.example"), at(live, "https://live.example"), at(router, "http://192.168.1.1")];
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultItems.mockResolvedValue({ items: items.map((item) => item.metadata) });
    mocks.vaultSiteCheck.mockResolvedValue({ results: [
      { origin: "https://gone.example", status: "NO_DNS", detail: null }, { origin: "https://down.example", status: "UNREACHABLE", detail: "ECONNREFUSED" },
      { origin: "https://live.example", status: "OK", detail: "200" }, { origin: "http://192.168.1.1", status: "LOCAL", detail: null }] });
    mocks.vaultDeleteItems.mockImplementation(async (body: { ids: string[] }) => ({ deleted: body.ids.length }));
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Check sites" }));
    const region = await screen.findByRole("region", { name: "Check sites" });
    expect(await within(region).findByText(/2 logins point to sites that are gone or do not answer\. 1 site is on a local network/)).toBeTruthy();
    expect(mocks.vaultSiteCheck).toHaveBeenCalledWith(["https://gone.example", "https://down.example", "https://live.example", "http://192.168.1.1"]);
    expect(within(region).getByText("The address no longer exists (no DNS name).")).toBeTruthy();
    expect(within(region).getByText("The site does not answer (ECONNREFUSED).")).toBeTruthy();
    expect(within(region).queryByText("Live mail")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Delete Down forum" }));
    // Signed by the unlocked dock (Vault review 2026-10-22).
    await waitFor(() => expect(mocks.vaultDeleteItems).toHaveBeenLastCalledWith({ ids: [down.metadata.id], epoch: 1, operatorSignature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) }));
    await waitFor(() => expect(within(region).queryByText("Down forum")).toBeNull());
    fireEvent.click(within(region).getByLabelText("Select all"));
    fireEvent.click(within(region).getByRole("button", { name: "Delete selected (1)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.vaultDeleteItems).toHaveBeenLastCalledWith(expect.objectContaining({ ids: [gone.metadata.id] })));
    expect(await within(region).findByText(/Every site answers\./)).toBeTruthy();
  });

  it("hands an older broker's 200 the logins agents used first, then ones made here or by agents, then imported ones", async () => {
    const imported = Array.from({ length: 200 }, (_, index) => record(`vault_item:I${String(index).padStart(21, "0")}`, `Imported ${index}`, "ACTIVE", [], "google_account:work-1"));
    const used = record("vault_item:UUUUUUUUUUUUUUUUUUUUUU", "Used", "ACTIVE");
    const made = record("vault_item:MMMMMMMMMMMMMMMMMMMMMM", "Made here", "ACTIVE");
    const all = [...imported, used, made];
    const stats = Object.fromEntries(all.map((item) => [item.metadata.id, { addedAt: "2026-10-01T00:00:00.000Z", changedAt: item === used ? "2026-10-02T00:00:00.000Z" : "2026-10-21T00:00:00.000Z", uses: item === used ? 3 : 0,
      lastUsedAt: item === used ? "2026-10-10T00:00:00.000Z" : null }]));
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 200 }));
    mocks.vaultItems.mockResolvedValue({ items: all.map((item) => item.metadata), stats });
    mocks.vaultItemRecords.mockResolvedValue({ items: all });
    mocks.delegateVaultItems.mockRejectedValueOnce(new Error("refused")).mockResolvedValue({ generation: 1, count: 200 });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledTimes(2));
    const fallback = (mocks.delegateVaultItems.mock.calls[1]![2] as { records: VaultItemRecord[] }).records.map((item) => item.metadata.id);
    expect(fallback.slice(0, 2)).toEqual([used.metadata.id, made.metadata.id]);
    expect(fallback).toHaveLength(200);
  });
});
