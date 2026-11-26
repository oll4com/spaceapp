import { describe, expect, it } from "vitest";
import {
  generateVaultTransportKey, openWithVaultPrivateKey, sealVaultEnvelope, vaultAad, vaultBase64url, vaultRandomBytes,
  type VaultItemRecord, type VaultPendingSecret
} from "@space/contracts";
import { queueWipedKeyItems } from "../src/vault/handover.js";

// Synthetic values only.
const owner = "user:alice";
const vaultId = "vault:AAAAAAAAAAAAAAAAAAAAAA";
const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };

async function item(id: string, dekKey: Uint8Array | "zero", secrets: Record<string, string>): Promise<VaultItemRecord> {
  const dek = vaultRandomBytes(32);
  const context = { ...scope, itemId: id, purpose: "ITEM_KEY" as const };
  let dekEnvelope: unknown;
  if (dekKey === "zero") {
    // What a save racing a lock wrote on 14/11: the item key under 32 zero bytes (sealVaultEnvelope refuses that key now).
    const nonce = vaultRandomBytes(12);
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(vaultAad(context)) }, key, dek));
    dekEnvelope = { v: 1, alg: "A256GCM", purpose: "ITEM_KEY", keyVersion: 1, nonce: vaultBase64url.encode(nonce), ct: vaultBase64url.encode(ct) };
  } else dekEnvelope = await sealVaultEnvelope(dekKey, dek, context);
  const fields: Record<string, unknown> = {};
  for (const [role, value] of Object.entries(secrets)) fields[role] = await sealVaultEnvelope(dek, new TextEncoder().encode(value), { ...scope, itemId: id, purpose: "ITEM_FIELD", field: role as never });
  return { metadata: { id, label: id, origins: ["https://lw.example"], fieldRoles: Object.keys(secrets), policy: { agentUse: true }, status: "ACTIVE", loginPage: null, card: null },
    keyVersion: 1, dekEnvelope, fields, history: [] } as unknown as VaultItemRecord;
}

describe("queueWipedKeyItems", () => {
  it("queues a login sealed under the wiped VRK as a waiting login on its handle, sealed to the inbox key; leaves every other item alone (14/11, 33 skipped on 23/11)", async () => {
    const inbox = await generateVaultTransportKey();
    const broken = await item("vault_item:BROKENBROKENBROKEN11", "zero", { USERNAME: "lw@example.com", PASSWORD: "SYNTHETIC-lw" });
    const fine = await item("vault_item:FINEFINEFINEFINEFI11", vaultRandomBytes(32), { USERNAME: "a@example.com", PASSWORD: "SYNTHETIC-a" });
    const held = await item("vault_item:HELDHELDHELDHELDHE11", "zero", { PASSWORD: "SYNTHETIC-held" });
    const items = [broken, fine, held];
    const pending: VaultPendingSecret[] = [];
    const repository = {
      getVault: async () => ({ vaultId }), getInbox: async () => ({ publicKey: vaultBase64url.encode(inbox.publicKey), privateKeyEnvelope: {} }),
      listItems: async () => items.map((record) => record.metadata), getItem: async (_owner: string, id: string) => items.find((record) => record.metadata.id === id) ?? null,
      listPending: async () => pending, addPending: async (_owner: string, entry: VaultPendingSecret) => { pending.push(entry); return true; }
    } as never;
    const checked = new Set<string>();
    expect(await queueWipedKeyItems(repository, owner, new Set([held.metadata.id]), checked)).toBe(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "NEW_ACCOUNT", handle: broken.metadata.id, origin: "https://lw.example", sealedOtp: null });
    const open = async (sealed: unknown) => new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, sealed, scope));
    expect(await open(pending[0]!.sealedUsername)).toBe("lw@example.com");
    expect(await open(pending[0]!.sealedPassword)).toBe("SYNTHETIC-lw");
    // Tried once: a second call (the row now waits, or was filed) queues nothing again.
    pending.length = 0;
    expect(await queueWipedKeyItems(repository, owner, new Set(), checked)).toBe(1); // only the held one, now no longer held
    expect(pending.map((entry) => entry.handle)).toEqual([held.metadata.id]);
    expect(await queueWipedKeyItems(repository, owner, new Set(), checked)).toBe(0);
  });
});
