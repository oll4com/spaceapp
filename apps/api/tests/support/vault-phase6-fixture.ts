import { newVaultHandle, openVaultEnvelope, sealVaultEnvelope, vaultRandomBytes, type VaultItemRecord } from "@space/contracts";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../../src/cli-browser-bridge.js";
import { enrollment, fixture, itemRecord } from "./vault-fakes.js";

// An enrolled Vault with one CLI pane, and items sealed like the dock does, shared by the vault-phase6 tests. Synthetic values only.
export async function enrolledFixture() {
  const harness = await fixture();
  const alice = await harness.session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
  const { body } = await enrollment(harness.brokerKey.publicKey, "user:alice");
  await harness.app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
  const room = (await harness.app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Vault proof", initialPaneCount: 0 } })).json();
  const pane = harness.store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
  const cli = harness.store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
  const token = issueCliBrowserBridgeToken(harness.config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!;
  const agent = (path: string, payload: unknown) => harness.app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" }, payload: payload as never });
  const as = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) => harness.app.inject({ method, url, headers: alice.headers, payload: payload as never });
  return { ...harness, alice, vaultId: body.vaultId, token, agent, as };
}

/** An item whose password is `password`, sealed like the dock does; `dek` lets the test open it again. */
export async function passwordItem(vaultId: string, password: string, previous?: { record: VaultItemRecord; dek: Uint8Array }) {
  const id = previous?.record.metadata.id ?? newVaultHandle("vault_item");
  const dek = previous?.dek ?? vaultRandomBytes(32);
  const scope = { ownerUserId: "user:alice", vaultId, keyVersion: 1, itemId: id };
  const base = await itemRecord("user:alice", vaultId, id);
  const record: VaultItemRecord = {
    ...base, metadata: { ...base.metadata, policy: { ...base.metadata.policy, agentUse: true } },
    dekEnvelope: previous?.record.dekEnvelope ?? await sealVaultEnvelope(vaultRandomBytes(32), dek, { ...scope, purpose: "ITEM_KEY" }),
    fields: { PASSWORD: await sealVaultEnvelope(dek, new TextEncoder().encode(password), { ...scope, purpose: "ITEM_FIELD", field: "PASSWORD" }) },
    history: previous ? [...previous.record.history, { fields: previous.record.fields, replacedAt: new Date().toISOString() }] : []
  };
  return { record, dek, open: async (fields = record.fields) => new TextDecoder().decode(await openVaultEnvelope(dek, fields.PASSWORD, { ...scope, purpose: "ITEM_FIELD", field: "PASSWORD" })) };
}
