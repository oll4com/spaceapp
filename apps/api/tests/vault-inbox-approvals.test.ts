import { describe, expect, it } from "vitest";
import { generateVaultTransportKey, newVaultHandle, sealToVaultPublicKey, sealVaultEnvelope, vaultRandomBytes } from "@space/contracts";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { SENTINEL, enrollment, fixture, itemRecord } from "./support/vault-fakes.js";

// Plan clipboard:vEYtT6-bEN0J steps 3-4: the inbox for generated passwords and saved logins (agents' list, fills and saves:
// vault-protection.test.ts). Synthetic values only.
async function setup() {
  const harness = await fixture();
  const alice = await harness.session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
  const { body } = await enrollment(harness.brokerKey.publicKey, "user:alice");
  await harness.app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
  const room = (await harness.app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Vault inbox", initialPaneCount: 0 } })).json();
  const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
  const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
  const agent = (path: string, payload: unknown) => harness.app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload: payload as never });
  const as = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
  // One agent-allowed item, delegated through the route (the fake broker signs exactly what it is asked).
  const base = await itemRecord("user:alice", body.vaultId);
  const item = base;
  await as("PUT", `/api/space-vault/items/${encodeURIComponent(item.metadata.id)}`, item);
  const handle = item.metadata.id;
  const fillEnvelopes = { [handle]: { PASSWORD: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1, purpose: "FILL_FIELD", itemId: handle, field: "PASSWORD", generation: 1 }) } };
  const sealedFillKey = await sealToVaultPublicKey(harness.brokerKey.publicKey, vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1 });
  await as("POST", "/api/space-vault/delegations", { items: [{ handle, origins: ["https://example.com"], fields: ["PASSWORD"], approvalMode: "FULL", submit: true }], fillEnvelopes, sealedFillKey,
    operatorSignature: "s".repeat(86), generation: 1, unlockEpoch: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  return { ...harness, vaultId: body.vaultId, pane, handle, agent, as };
}

describe("Vault inbox for generated passwords", () => {
  it("keeps the inbox key as ciphertext and lets the operator take or drop waiting passwords", async () => {
    const vault = await setup();
    try {
      const inbox = await generateVaultTransportKey();
      const privateKeyEnvelope = await sealVaultEnvelope(vaultRandomBytes(32), inbox.privateKey, { ownerUserId: "user:alice", vaultId: vault.vaultId, keyVersion: 1, purpose: "INBOX_KEY" });
      const publicKey = Buffer.from(inbox.publicKey).toString("base64url");
      expect((await vault.as("PUT", "/api/space-vault/inbox", { publicKey, privateKeyEnvelope: { plaintext: SENTINEL } })).statusCode).toBe(422);
      expect((await vault.as("PUT", "/api/space-vault/inbox", { publicKey, privateKeyEnvelope })).json()).toEqual({ inbox: true });
      expect((await vault.as("GET", "/api/space-vault/inbox")).json().inbox).toEqual({ publicKey, privateKeyEnvelope });

      // A fill (phase 3) seals the generated password to the inbox key; here one is stored the same way.
      const sealedPassword = await sealToVaultPublicKey(inbox.publicKey, new TextEncoder().encode(SENTINEL), { ownerUserId: "user:alice", vaultId: vault.vaultId, keyVersion: 1 });
      const pending = { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT" as const, handle: newVaultHandle("vault_item"), label: "Synthetic shop", origin: "https://shop.example",
        sealedUsername: null, sealedPassword, paneId: vault.pane.id, createdAt: new Date().toISOString() };
      await vault.repository.addPending("user:alice", pending);
      const listed = await vault.as("GET", "/api/space-vault/pending");
      expect(listed.json().pending).toEqual([pending]);
      expect(listed.body).not.toContain(SENTINEL);
      expect((await vault.as("DELETE", `/api/space-vault/pending/${encodeURIComponent(newVaultHandle("vault_pending"))}`)).statusCode).toBe(404);
      expect((await vault.as("DELETE", `/api/space-vault/pending/${encodeURIComponent(pending.id)}`)).json()).toEqual({ deleted: true });
      expect((await vault.as("GET", "/api/space-vault/pending")).json().pending).toEqual([]);
    } finally {
      await vault.app.close();
    }
  });
});
