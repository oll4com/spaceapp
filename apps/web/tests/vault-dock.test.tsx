import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultItemRecord } from "@space/contracts";

const mocks = vi.hoisted(() => ({
  vaultState: vi.fn(), vaultItems: vi.fn(), vaultItem: vi.fn(), vaultSaveItem: vi.fn(), vaultDeleteItem: vi.fn(), vaultRevoke: vi.fn(),
  vaultLock: vi.fn(), vaultAudit: vi.fn(), setUpVault: vi.fn(), unlockVault: vi.fn(), encryptVaultItem: vi.fn(), decryptVaultItem: vi.fn(),
  vaultSetAgentAccess: vi.fn(), vaultInboxKey: vi.fn(), importVaultPending: vi.fn(),
  vaultSignupGrants: vi.fn(), vaultCreateSignupGrant: vi.fn(), vaultRevokeSignupGrant: vi.fn(), signVaultSignupGrant: vi.fn(), delegateVaultItems: vi.fn(),
  gatewayAnthropicAdmin: vi.fn(), saveGatewayAnthropicAdminKey: vi.fn(), removeGatewayAnthropicAdminKey: vi.fn(), syncGatewayAnthropicBilling: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: mocks }));
vi.mock("../src/features/vault/vault-client.js", async (original) => ({
  ...await original<typeof import("../src/features/vault/vault-client.js")>(),
  setUpVault: mocks.setUpVault, unlockVault: mocks.unlockVault, encryptVaultItem: mocks.encryptVaultItem, decryptVaultItem: mocks.decryptVaultItem,
  vaultInboxKey: mocks.vaultInboxKey, importVaultPending: mocks.importVaultPending, signVaultSignupGrant: mocks.signVaultSignupGrant, delegateVaultItems: mocks.delegateVaultItems
}));

import { VaultDock } from "../src/features/vault/VaultDock.js";

// Synthetic values only; crypto is covered by vault-client.test.ts, this file covers the dock's states and actions.
const envelope = { v: 1, alg: "A256GCM", purpose: "ITEM_FIELD", keyVersion: 1, nonce: "A".repeat(16), ct: "B".repeat(40) } as const;
const policy = { agentUse: true, approvalMode: "ASSIST" as const, submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] };
const record = (id: string, label: string, status: "ACTIVE" | "PENDING", history: VaultItemRecord["history"] = []): VaultItemRecord => ({
  metadata: { id, label, origins: ["https://shop.example"], fieldRoles: ["PASSWORD"], policy, status },
  keyVersion: 1, dekEnvelope: { ...envelope, purpose: "ITEM_KEY" }, fields: { PASSWORD: envelope }, history
});
const pending = record("vault_item:AAAAAAAAAAAAAAAAAAAAAA", "New shop account", "PENDING");
const changed = record("vault_item:BBBBBBBBBBBBBBBBBBBBBB", "Mail", "ACTIVE", [{ fields: { PASSWORD: envelope }, replacedAt: "2026-10-17T12:00:00.000Z" }]);
const state = (patch: Record<string, unknown> = {}) => ({ ownerUserId: "user:alice", enrolled: true, brokerAvailable: true, agentAccess: false, delegatedItems: 0,
  vault: { vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, delegationGeneration: 0, hasRecovery: true, auditSeq: 3 }, ...patch });

describe("VaultDock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.vaultItems.mockResolvedValue({ items: [pending.metadata, changed.metadata] });
    mocks.vaultItem.mockImplementation(async (id: string) => ({ item: id === pending.metadata.id ? pending : changed }));
    mocks.vaultSaveItem.mockResolvedValue({ item: pending });
    mocks.unlockVault.mockResolvedValue({ ownerUserId: "user:alice", vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", epoch: 1, vrk: new Uint8Array(32), passwordShare: new Uint8Array(32), signingKey: new Uint8Array(48) });
    mocks.vaultAudit.mockResolvedValue({ entries: [], nextBeforeSeq: null });
    mocks.delegateVaultItems.mockResolvedValue({ generation: 1, count: 1 });
    mocks.vaultSignupGrants.mockResolvedValue({ grants: [] });
    mocks.vaultInboxKey.mockResolvedValue({ privateKey: new Uint8Array(48), publicKey: new Uint8Array(32) });
    mocks.importVaultPending.mockResolvedValue(0);
    mocks.gatewayAnthropicAdmin.mockRejectedValue(new Error("Administrator permissions are required."));
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

  it("unlocks, keeps a pending item, confirms a changed password and revokes agent access", async () => {
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultRevoke.mockResolvedValue({ generation: 1, epoch: 2 });
    render(<VaultDock />);
    expect(await screen.findByText(/Locked · Agents and Nous: off/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    const pendingRow = (await screen.findByText("New shop account")).closest("li")!;
    expect(within(pendingRow).getByText("Pending")).toBeTruthy();
    fireEvent.click(within(pendingRow).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(mocks.vaultSaveItem).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ id: pending.metadata.id, status: "ACTIVE" }), history: [] })));
    const changedRow = screen.getByText("Mail").closest("li")!;
    expect(within(changedRow).getByText("New password not confirmed")).toBeTruthy();
    fireEvent.click(within(changedRow).getByRole("button", { name: "Restore previous" }));
    await waitFor(() => expect(mocks.vaultSaveItem).toHaveBeenLastCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ id: changed.metadata.id }), history: [] })));

    fireEvent.click(screen.getByRole("button", { name: "Revoke agent access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(mocks.vaultRevoke).toHaveBeenCalledTimes(1));
  });

  it("adds the logins agents saved on unlock and hands every login to agents while agent access is on", async () => {
    mocks.vaultState.mockResolvedValue(state({ agentAccess: true, delegatedItems: 2 }));
    mocks.importVaultPending.mockResolvedValue(2);
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("Added 2 logins that agents saved or changed.")).toBeTruthy();
    // No per-use approvals any more: the unlock alone re-delegates every item.
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA" }),
      { records: [pending, changed], delegationGeneration: 0, epoch: 1 }));
    expect(screen.queryByRole("region", { name: "Agent requests" })).toBeNull();
    expect(await screen.findByText(/Unlocked · Agents and Nous: on \(2 logins\)/)).toBeTruthy();
  });

  it("locks itself when the tab is hidden, dropping the keys like Lock", async () => {
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

  it("signs a sign-up grant for sites the operator types, lists it and revokes it", async () => {
    const grant = { id: "vault_grant:AAAAAAAAAAAAAAAAAAAAAA", sites: ["https://shop.example"], dailyCap: 3, createdAt: "2026-10-18T02:00:00.000Z", expiresAt: "2026-11-17T02:00:00.000Z", revokedAt: null };
    mocks.vaultState.mockResolvedValue(state());
    mocks.vaultSignupGrants.mockResolvedValueOnce({ grants: [] }).mockResolvedValueOnce({ grants: [grant] }).mockResolvedValue({ grants: [] });
    mocks.signVaultSignupGrant.mockResolvedValue({ grantId: grant.id, sites: grant.sites, dailyCap: 3, unlockEpoch: 1, expiresAt: grant.expiresAt, operatorSignature: "s".repeat(86) });
    mocks.vaultCreateSignupGrant.mockResolvedValue({ grant });
    mocks.vaultRevokeSignupGrant.mockResolvedValue({ revoked: true });
    render(<VaultDock />);
    fireEvent.change(await screen.findByLabelText("Master password"), { target: { value: "a synthetic master" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const card = await screen.findByRole("region", { name: "Sign-up grants" });
    expect(await within(card).findByText("No active grants.")).toBeTruthy();
    const sitesBox = within(card).getByLabelText(/Sites/) as HTMLTextAreaElement;
    expect(sitesBox.value).toBe("");
    const sign = within(card).getByRole("button", { name: "Sign grant" }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.change(sitesBox, { target: { value: "https://*.shop.example" } });
    expect(within(card).getByText(/is not an exact https site/)).toBeTruthy();
    expect(sign.disabled).toBe(true);
    fireEvent.change(sitesBox, { target: { value: "https://Shop.Example/signup" } });
    expect(within(card).getByText("Signed as https://shop.example")).toBeTruthy();
    expect((within(card).getByLabelText("New accounts per day") as HTMLInputElement).value).toBe("3");
    expect((within(card).getByLabelText("Valid for (days)") as HTMLInputElement).value).toBe("30");
    fireEvent.click(sign);
    await waitFor(() => expect(mocks.vaultCreateSignupGrant).toHaveBeenCalledWith(expect.objectContaining({ grantId: grant.id, operatorSignature: "s".repeat(86) })));
    expect(mocks.signVaultSignupGrant).toHaveBeenCalledWith(expect.objectContaining({ vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA" }), { sites: ["https://shop.example"], dailyCap: 3, days: 30 });
    expect(await within(card).findByText("https://shop.example")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Revoke the grant for https://shop.example" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant" }));
    await waitFor(() => expect(mocks.vaultRevokeSignupGrant).toHaveBeenCalledWith(grant.id));
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
    fireEvent.click(within(card).getByRole("switch", { name: "Agents and Nous can use my Vault" }));
    await waitFor(() => expect(mocks.vaultSetAgentAccess).toHaveBeenCalledWith(true));
    await waitFor(() => expect(mocks.delegateVaultItems).toHaveBeenCalledWith(expect.anything(), expect.anything(), { records: [pending, changed], delegationGeneration: 0, epoch: 1 }));
    expect(await within(card).findByText(/1 login is ready for them/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("switch", { name: "Agents and Nous can use my Vault" }));
    await waitFor(() => expect(mocks.vaultSetAgentAccess).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(within(card).queryByText(/ready for them/)).toBeNull());
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
});
