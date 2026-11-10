import { afterEach, describe, expect, it, vi } from "vitest";
import { generateVaultSigningKey, sealToVaultPublicKey, sealVaultEnvelope, vaultRandomBytes, type VaultItemRecord } from "@space/contracts";
import { enrolledFixture, passwordItem } from "./support/vault-phase6-fixture.js";

// Plan clipboard:vEYtT6-bEN0J step 6, the checks that need no Browser Host. Synthetic values only.
afterEach(() => { vi.restoreAllMocks(); });

describe("Vault phase 6 checks without the Browser Host", () => {
  // Every sink including the Vault MCP server (scripts/space-vault-mcp.mjs, not in the public tree): vault-phase6-mcp.test.ts.

  it("refuses an agent write while the Vault is locked and leaves the items as they were", async () => {
    const harness = await enrolledFixture();
    try {
      expect((await harness.as("POST", "/api/space-vault/lock", {})).json().epoch).toBe(2);
      const before = (await harness.as("GET", "/api/space-vault/items")).json().items;
      const answer = await harness.agent("generate-fill", { purpose: "NEW_ACCOUNT", label: "Created while locked", username: "synthetic@example.com" });
      expect(answer.json()).toMatchObject({ status: "BLOCKED" });
      expect((await harness.as("GET", "/api/space-vault/items")).json().items).toEqual(before);
      expect((await harness.as("GET", "/api/space-vault/audit?limit=1")).json().entries[0].event).toMatchObject({ actor: "AGENT", action: "GENERATE", result: "BLOCKED" });
    } finally {
      await harness.app.close();
    }
  });

  it("moves a PENDING item to ACTIVE only on the operator's Keep, and rolls a changed password back", async () => {
    const harness = await enrolledFixture();
    try {
      const first = await passwordItem(harness.vaultId, "SYNTHETIC-old-password");
      const changed = await passwordItem(harness.vaultId, "SYNTHETIC-new-password", first);
      const url = `/api/space-vault/items/${encodeURIComponent(first.record.metadata.id)}`;
      await harness.as("PUT", url, { ...changed.record, metadata: { ...changed.record.metadata, status: "PENDING" } });
      expect((await harness.as("GET", "/api/space-vault/items")).json().items[0].status).toBe("PENDING");
      // Agents have no route that changes an item's status.
      expect((await harness.agent("approval", { handle: first.record.metadata.id, fields: ["PASSWORD"] })).statusCode).toBe(404);
      expect((await harness.as("GET", "/api/space-vault/items")).json().items[0].status).toBe("PENDING");
      // Rollback: the previous fields come back from the history, under the same item key.
      const stored: VaultItemRecord = (await harness.as("GET", url)).json().item;
      expect(stored.history).toHaveLength(1);
      expect(await changed.open(stored.history[0]!.fields)).toBe("SYNTHETIC-old-password");
      const restored = { ...stored, metadata: { ...stored.metadata, status: "ACTIVE" }, fields: stored.history[0]!.fields, history: [] };
      await harness.as("PUT", url, restored);
      const after: VaultItemRecord = (await harness.as("GET", url)).json().item;
      expect(after.metadata.status).toBe("ACTIVE");
      expect(after.history).toEqual([]);
      expect(await changed.open(after.fields)).toBe("SYNTHETIC-old-password");
    } finally {
      await harness.app.close();
    }
  });

  it("refuses a delegation whose certificate is forged, widened or for items hidden from agents", async () => {
    const forger = await generateVaultSigningKey();
    const harness = await enrolledFixture();
    try {
      const allowed = await passwordItem(harness.vaultId, "SYNTHETIC-delegated");
      await harness.as("PUT", `/api/space-vault/items/${encodeURIComponent(allowed.record.metadata.id)}`, allowed.record);
      const handle = allowed.record.metadata.id;
      const fillEnvelopes = { [handle]: { PASSWORD: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: harness.vaultId, keyVersion: 1, purpose: "FILL_FIELD", itemId: handle, field: "PASSWORD", generation: 1 }) } };
      const sealedFillKey = await sealToVaultPublicKey(harness.brokerKey.publicKey, vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: harness.vaultId, keyVersion: 1 });
      const request = { items: [{ handle, origins: ["https://example.com"], fields: ["PASSWORD"], approvalMode: "ASSIST", submit: false }], fillEnvelopes, sealedFillKey, operatorSignature: "s".repeat(86),
        // A standing delegation: no 30-day cap any more (operator decision 2026-10-18).
        generation: 1, unlockEpoch: 1, expiresAt: new Date(Date.now() + 3650 * 86_400_000).toISOString() };
      const delegate = () => harness.as("POST", "/api/space-vault/delegations", request);
      const reasons = async () => (await harness.as("GET", "/api/space-vault/audit?limit=50")).json().entries
        .filter((entry: { event: { action: string } }) => entry.event.action === "DELEGATE").map((entry: { event: { result: string; reason: string | null } }) => `${entry.event.result}:${entry.event.reason}`);
      // A certificate signed by anyone but the broker.
      harness.tamper.signWith = forger.privateKey;
      const forged = await delegate();
      expect(forged.statusCode).toBe(409);
      expect(forged.json().error.code).toBe("VAULT_DELEGATION_REFUSED");
      harness.tamper.signWith = undefined;

      // A real broker signature over wider claims than asked (submit, another origin) is refused too.
      harness.tamper.widen = (claims) => ({ ...claims, items: claims.items.map((item: { origins: string[] }) => ({ ...item, submit: true, origins: [...item.origins, "https://evil.example"] })) });
      expect((await delegate()).json().error.code).toBe("VAULT_DELEGATION_REFUSED");
      harness.tamper.widen = undefined;

      // An item agents may not use.
      const privateItem = await passwordItem(harness.vaultId, "SYNTHETIC-private");
      const privateRecord = { ...privateItem.record, metadata: { ...privateItem.record.metadata, policy: { ...privateItem.record.metadata.policy, agentUse: false } } };
      await harness.as("PUT", `/api/space-vault/items/${encodeURIComponent(privateRecord.metadata.id)}`, privateRecord);
      const notDelegable = await harness.as("POST", "/api/space-vault/delegations", { ...request, items: [{ ...request.items[0], handle: privateRecord.metadata.id }],
        fillEnvelopes: { [privateRecord.metadata.id]: fillEnvelopes[handle] } });
      expect(notDelegable.json().error.code).toBe("VAULT_DELEGATION_REFUSED");
      expect((await harness.as("GET", "/api/space-vault/state")).json().vault.delegationGeneration).toBe(0);

      // Review 2026-10-17 H1/M2: other origins than the item's, or a stale generation, epoch or expiry, never reach the broker.
      const refused = async (patch: Record<string, unknown>) => (await harness.as("POST", "/api/space-vault/delegations", { ...request, ...patch })).json().error.code;
      expect(await refused({ items: [{ ...request.items[0], origins: ["https://phish.example"] }] })).toBe("VAULT_DELEGATION_REFUSED");
      expect(await refused({ generation: 2 })).toBe("VAULT_DELEGATION_REFUSED");
      expect(await refused({ unlockEpoch: 2 })).toBe("VAULT_DELEGATION_REFUSED");
      expect(await refused({ expiresAt: new Date(Date.now() - 1_000).toISOString() })).toBe("VAULT_DELEGATION_REFUSED");

      // The broker's own signature over exactly the request is stored as generation 1.
      expect((await delegate()).json()).toEqual({ generation: 1 });
      expect(await reasons()).toEqual(["OK:null", "BLOCKED:DELEGATION_STALE", "BLOCKED:DELEGATION_STALE", "BLOCKED:DELEGATION_STALE", "BLOCKED:ORIGINS_MISMATCH",
        "BLOCKED:ITEM_NOT_DELEGABLE", "BLOCKED:CERTIFICATE_MISMATCH", "BLOCKED:CERTIFICATE_INVALID"]);
    } finally {
      await harness.app.close();
    }
  });
});
