import { describe, expect, it } from "vitest";
import {
  generateVaultSigningKey, generateVaultTransportKey, newVaultHandle, sealVaultEnvelope, signVaultMessage, vaultBase64url, vaultOperatorRequestMessage, vaultRandomBytes,
  type VaultOperatorSignedKind
} from "@space/contracts";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { VaultBrokerUnavailableError } from "../src/vault/broker-client.js";
import { SENTINEL, enrollment, fixture, itemRecord } from "./support/vault-fakes.js";

describe("Vault operator routes", () => {
  it("needs a session and CSRF, enrolls through the broker and unlocks once per challenge", async () => {
    const { app, brokerKey, brokerCalls, session } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/space-vault/state" })).statusCode).toBe(401);
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      expect((await app.inject({ method: "GET", url: "/api/space-vault/state", headers: alice.headers })).json()).toMatchObject({ ownerUserId: "user:alice", enrolled: false, brokerAvailable: true, agentAccess: false, delegatedItems: 0, vault: null });
      const { body, signing } = await enrollment(brokerKey.publicKey, "user:alice");
      expect((await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: { cookie: alice.cookie }, payload: body })).json().error.code).toBe("CSRF_INVALID");
      // The server share travels only sealed: a plaintext share field is refused before the broker is asked.
      expect((await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: { ...body, serverShare: SENTINEL } })).statusCode).toBe(422);
      const enrolled = await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      expect(enrolled.statusCode).toBe(201);
      expect(brokerCalls).toEqual(["seal:user:alice"]);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body })).json().error.code).toBe("VAULT_EXISTS");

      const challenge = (await app.inject({ method: "POST", url: "/api/space-vault/unlock/challenge", headers: alice.headers, payload: {} })).json();
      const reply = await generateVaultTransportKey();
      const unlockBody = { challenge: challenge.challenge, replyPublicKey: vaultBase64url.encode(reply.publicKey), signature: "s".repeat(86) };
      const unlocked = (await app.inject({ method: "POST", url: "/api/space-vault/unlock", headers: alice.headers, payload: unlockBody })).json();
      expect(unlocked.sealedServerShare).toMatchObject({ alg: "X25519-HKDF-A256GCM", purpose: "TRANSPORT" });
      expect(challenge).toMatchObject({ vaultId: body.vaultId, passwordEnvelope: body.passwordEnvelope, kdf: body.kdf, unlockKeyVersion: 1, epoch: 1 });
      expect(brokerCalls).toEqual(["seal:user:alice", "unlock:1"]);
      // A challenge works once; a reused one is refused and audited without asking the broker.
      expect((await app.inject({ method: "POST", url: "/api/space-vault/unlock", headers: alice.headers, payload: unlockBody })).json().error.code).toBe("VAULT_UNLOCK_REFUSED");
      expect(brokerCalls).toHaveLength(2);
      const audit = (await app.inject({ method: "GET", url: "/api/space-vault/audit?limit=10", headers: alice.headers })).json();
      expect(audit.entries.map((entry: { event: { action: string; result: string; reason: string | null } }) => `${entry.event.action}:${entry.event.result}:${entry.event.reason}`))
        .toEqual(["UNLOCK:BLOCKED:CHALLENGE_INVALID", "UNLOCK:OK:null", "ENROLL:OK:null"]);
      // A lock starts a new epoch, so an unused older challenge dies with it.
      const stale = (await app.inject({ method: "POST", url: "/api/space-vault/unlock/challenge", headers: alice.headers, payload: {} })).json();
      expect((await app.inject({ method: "POST", url: "/api/space-vault/lock", headers: alice.headers, payload: {} })).json().epoch).toBe(2);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/unlock", headers: alice.headers, payload: { ...unlockBody, challenge: stale.challenge } })).statusCode).toBe(409);
      void signing;
    } finally {
      await app.close();
    }
  });

  it("fails closed without the broker", async () => {
    const unavailable = () => Promise.reject(new VaultBrokerUnavailableError());
    const { app, session } = await fixture({ broker: { transportKey: unavailable, sealServerShare: unavailable, unlock: unavailable } });
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const { body } = await enrollment((await generateVaultTransportKey()).publicKey, "user:alice");
      const refused = await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error.code).toBe("VAULT_BROKER_UNAVAILABLE");
      expect((await app.inject({ method: "GET", url: "/api/space-vault/state", headers: alice.headers })).json()).toMatchObject({ enrolled: false, brokerAvailable: false });
    } finally {
      await app.close();
    }
  });

  it("keeps items ciphertext-only and per owner, and revokes agent access without a password", async () => {
    const { app, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const { body } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      const item = await itemRecord("user:alice", body.vaultId);
      const url = `/api/space-vault/items/${encodeURIComponent(item.metadata.id)}`;
      expect((await app.inject({ method: "PUT", url, headers: alice.headers, payload: { ...item, fields: { PASSWORD: { plaintext: SENTINEL } } } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PUT", url: `/api/space-vault/items/${encodeURIComponent(newVaultHandle("vault_item"))}`, headers: alice.headers, payload: item })).json().error.code).toBe("VAULT_ITEM_MISMATCH");
      expect((await app.inject({ method: "PUT", url, headers: alice.headers, payload: item })).statusCode).toBe(200);
      const listed = await app.inject({ method: "GET", url: "/api/space-vault/items", headers: alice.headers });
      expect(listed.json().items).toEqual([item.metadata]);
      expect(listed.json().stats).toEqual({ [item.metadata.id]: expect.objectContaining({ uses: 0, lastUsedAt: null }) });
      expect(listed.body).not.toContain(SENTINEL);
      expect((await app.inject({ method: "GET", url, headers: bob.headers })).json().error.code).toBe("VAULT_ITEM_NOT_FOUND");
      // The only delete is the signed batch route; a user without a vault has nothing to delete in.
      expect((await app.inject({ method: "DELETE", url, headers: alice.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/items/delete", headers: bob.headers, payload: { ids: [item.metadata.id], epoch: 1, operatorSignature: "s".repeat(86) } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/revoke", headers: alice.headers, payload: {} })).json()).toEqual({ generation: 1, epoch: 2 });
      expect((await app.inject({ method: "POST", url: "/api/space-vault/revoke", headers: bob.headers, payload: {} })).json().error.code).toBe("VAULT_NOT_ENROLLED");
    } finally {
      await app.close();
    }
  });

  it("needs the unlock key's signature at the current epoch to set the inbox key, rotate the password, set recovery and delete items (Vault review 2026-10-22)", async () => {
    const { app, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const { body, signing } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      const item = await itemRecord("user:alice", body.vaultId);
      await app.inject({ method: "PUT", url: `/api/space-vault/items/${encodeURIComponent(item.metadata.id)}`, headers: alice.headers, payload: item });
      const scope = { ownerUserId: "user:alice", vaultId: body.vaultId };
      const other = (await generateVaultSigningKey()).privateKey;
      const sign = async (kind: VaultOperatorSignedKind, request: Record<string, unknown>, key = signing.privateKey) =>
        ({ ...request, operatorSignature: await signVaultMessage(key, vaultOperatorRequestMessage(kind, { ...scope, ...request })) });
      const call = (method: "PUT" | "POST", url: string, payload: unknown) => app.inject({ method, url, headers: alice.headers, payload: payload as never });

      // The inbox key: unsigned, signed by another key, or signed for another epoch is refused and audited; nothing is stored.
      const inbox = await generateVaultTransportKey();
      const inboxBody = { publicKey: vaultBase64url.encode(inbox.publicKey), privateKeyEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), inbox.privateKey, { ...scope, keyVersion: 1, purpose: "INBOX_KEY" }), epoch: 1 };
      expect((await call("PUT", "/api/space-vault/inbox", inboxBody)).statusCode).toBe(422);
      expect((await call("PUT", "/api/space-vault/inbox", await sign("inbox", inboxBody, other))).json().error.code).toBe("VAULT_SIGNATURE_REFUSED");
      expect((await call("PUT", "/api/space-vault/inbox", await sign("inbox", { ...inboxBody, epoch: 2 }))).json().error.code).toBe("VAULT_EPOCH_STALE");
      expect((await app.inject({ url: "/api/space-vault/inbox", headers: alice.headers })).json().inbox).toBeNull();
      expect((await call("PUT", "/api/space-vault/inbox", await sign("inbox", inboxBody))).json()).toEqual({ inbox: true });
      // Deletes: the same signature over the ids.
      const deletion = { ids: [item.metadata.id], epoch: 1 };
      expect((await call("POST", "/api/space-vault/items/delete", deletion)).statusCode).toBe(422);
      expect((await call("POST", "/api/space-vault/items/delete", await sign("item-delete", deletion, other))).json().error.code).toBe("VAULT_SIGNATURE_REFUSED");
      expect((await app.inject({ url: "/api/space-vault/items", headers: alice.headers })).json().items).toHaveLength(1);
      expect((await call("POST", "/api/space-vault/items/delete", await sign("item-delete", deletion))).json()).toEqual({ deleted: 1 });
      // The recovery envelope and the password envelope: a swapped unlock key signed by itself does not pass, the stored key verifies.
      const recovery = { keyVersion: 1, envelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ...scope, keyVersion: 1, purpose: "RECOVERY_SHARE" }), createdAt: new Date().toISOString(), epoch: 1 };
      expect((await call("PUT", "/api/space-vault/recovery", await sign("recovery", recovery, other))).json().error.code).toBe("VAULT_SIGNATURE_REFUSED");
      expect((await call("PUT", "/api/space-vault/recovery", await sign("recovery", recovery))).json()).toEqual({ recovery: true });
      const rotation = { expectedEpoch: 1, kdf: body.kdf, passwordEnvelope: body.passwordEnvelope, unlockPublicKey: body.unlockPublicKey, unlockKeyVersion: 1 };
      const swapped = await generateVaultSigningKey();
      expect((await call("POST", "/api/space-vault/password", await sign("password", { ...rotation, unlockPublicKey: vaultBase64url.encode(swapped.publicKey) }, swapped.privateKey))).json().error.code).toBe("VAULT_SIGNATURE_REFUSED");
      expect((await call("POST", "/api/space-vault/password", await sign("password", rotation))).json()).toEqual({ epoch: 2 });
      // After the rotation the epoch moved: a signature for epoch 1 is stale now.
      expect((await call("PUT", "/api/space-vault/inbox", await sign("inbox", inboxBody))).json().error.code).toBe("VAULT_EPOCH_STALE");
      const audit = (await app.inject({ url: "/api/space-vault/audit?limit=30", headers: alice.headers })).json();
      const events = audit.entries.map((entry: { event: { action: string; result: string; reason: string | null } }) => `${entry.event.action}:${entry.event.result}:${entry.event.reason}`);
      expect(events).toEqual(expect.arrayContaining(["INBOX_SET:BLOCKED:SIGNATURE_REFUSED", "INBOX_SET:BLOCKED:EPOCH_STALE", "INBOX_SET:OK:null", "ITEM_DELETE:BLOCKED:SIGNATURE_REFUSED",
        "RECOVERY_SET:BLOCKED:SIGNATURE_REFUSED", "PASSWORD_ROTATE:BLOCKED:SIGNATURE_REFUSED", "PASSWORD_ROTATE:OK:null"]));
    } finally {
      await app.close();
    }
  });
});

describe("Vault agent routes", () => {
  it("answer BLOCKED with an audit id while agent access is off, report it in status, and refuse anything but handles", async () => {
    const { app, store, config, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Vault", initialPaneCount: 0 } })).json();
      const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cliSession = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const agent = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cliSession.sessionId })!, "content-type": "application/json" };
      const call = (path: string, payload: unknown, headers: Record<string, string> = agent) => app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers, payload: payload as never });

      expect((await call("fill", { handle: newVaultHandle("vault_item"), fields: ["PASSWORD"] }, { "content-type": "application/json" })).statusCode).toBe(401);
      // No vault yet: still the fixed result, with nothing to audit in.
      expect((await call("list", {})).json()).toEqual({ status: "BLOCKED", auditId: null, reason: "NOT_ENROLLED" });
      const { body } = await enrollment(brokerKey.publicKey, (await store.getRoom(room.id)).ownerUserId!);
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      const handle = newVaultHandle("vault_item");
      for (const [path, payload] of [["list", {}], ["fill", { handle, fields: ["USERNAME", "PASSWORD"] }], ["totp-fill", { handle }],
        ["generate-fill", { purpose: "NEW_ACCOUNT", label: "Synthetic shop", username: "synthetic@example.com", roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"] }],
        ["generate-fill", { purpose: "CHANGE_PASSWORD", handle }], ["save", { site: "https://shop.example", username: "synthetic@example.com", password: SENTINEL, label: "Shop" }]] as const) {
        const answer = await call(path, payload);
        expect(answer.statusCode, path).toBe(200);
        expect(answer.json(), path).toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "AGENT_ACCESS_OFF" });
        expect(answer.body, path).not.toContain(SENTINEL);
      }
      expect((await call("status", {})).json()).toEqual({ status: "LISTED", auditId: expect.stringMatching(/^vault_audit:/), agentAccess: false, delegatedItems: 0, pendingItems: 0 });
      const audited = (await call("audit", { limit: 3 })).json();
      expect(audited.entries).toHaveLength(3);
      expect(audited.entries[0]).toEqual({ at: expect.any(String), action: "AGENT_LIST", result: "LISTED", reason: null, itemId: null });
      expect(audited.entries[1]).toMatchObject({ action: "ITEM_SAVE", result: "BLOCKED", reason: "AGENT_ACCESS_OFF" });
      // Selectors, URLs, values and unknown keys never pass the schema; a save needs a plain web site.
      for (const [path, payload] of [["fill", { handle, fields: ["PASSWORD"], selector: "#password" }], ["fill", { handle, fields: ["PASSWORD"], origin: "https://evil.example" }],
        ["generate-fill", { purpose: "NEW_ACCOUNT" }], ["generate-fill", { purpose: "CHANGE_PASSWORD" }], ["fill", { handle: "vault_item:../x", fields: ["PASSWORD"] }],
        ["list", { paneId: "pane:other" }], ["approval", { handle, fields: ["PASSWORD"] }], ["fill", { handle, fields: ["PASSWORD"], targetPaneId: "../x" }],
        ["save", { site: "http://10.0.0.1", username: "a", label: "A" }], ["save", { site: "https://shop.example", username: "a", label: "A", fields: { PASSWORD: "x" } }]] as const) {
        expect([404, 422], JSON.stringify(payload)).toContain((await call(path, payload)).statusCode);
      }
      const audit = (await app.inject({ method: "GET", url: "/api/space-vault/audit?limit=3", headers: alice.headers })).json();
      expect(audit.entries[0].event).toMatchObject({ actor: "AGENT", paneId: pane.id });
    } finally {
      await app.close();
    }
  });
});

describe("Vault API key handoff", () => {
  it("hands a pasted key to one of the owner's panes once, deletes its value once written, and lists ids and states only (operator request 2026-10-22)", async () => {
    const { app, store, config, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const { body } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Keys", initialPaneCount: 0 } })).json();
      const pane = store.createPane({ roomId: room.id, title: "Claude", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
      const cli = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
      const agent = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!, "content-type": "application/json" };
      const call = (path: string, payload: unknown) => app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers: agent, payload: payload as never });
      // The operator pastes a key: an id comes back, never the value; the list shows ids and states, per owner.
      const created = await app.inject({ method: "POST", url: "/api/space-vault/keys", headers: alice.headers, payload: { label: "Synthetic service", value: SENTINEL, expiresInHours: 24 } });
      expect(created.statusCode).toBe(201);
      const key = created.json().key;
      expect(key).toMatchObject({ id: expect.stringMatching(/^vault_key:/), label: "Synthetic service", hasValue: true, takenAt: null, usedAt: null });
      expect(created.body).not.toContain(SENTINEL);
      const listed = await app.inject({ url: "/api/space-vault/keys", headers: alice.headers });
      expect(listed.json().keys.map((entry: { id: string }) => entry.id)).toEqual([key.id]);
      expect(listed.body).not.toContain(SENTINEL);
      expect((await app.inject({ url: "/api/space-vault/keys", headers: bob.headers })).json().keys).toEqual([]);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/keys", headers: alice.headers, payload: { label: "Two lines", value: "a\nb" } })).statusCode).toBe(422);
      // Agents need the switch on; then the owner's pane takes the value once and confirms the write, which deletes the value.
      expect((await call("key-take", { id: key.id })).json()).toMatchObject({ status: "BLOCKED", reason: "AGENT_ACCESS_OFF" });
      await app.inject({ method: "PUT", url: "/api/space-vault/agent-access", headers: alice.headers, payload: { enabled: true } });
      expect((await call("key-take", { id: newVaultHandle("vault_key") })).json()).toMatchObject({ status: "BLOCKED", reason: "KEY_UNAVAILABLE" });
      expect((await call("key-used", { id: key.id })).json()).toMatchObject({ status: "BLOCKED", reason: "KEY_NOT_TAKEN" });
      expect((await call("key-take", { id: key.id })).json()).toEqual({ status: "TAKEN", auditId: expect.stringMatching(/^vault_audit:/), reason: null, value: SENTINEL });
      // The same pane may take it again (a failed write), another pane may not.
      expect((await call("key-take", { id: key.id })).json().status).toBe("TAKEN");
      expect((await call("key-used", { id: key.id })).json()).toMatchObject({ status: "USED" });
      expect((await call("key-take", { id: key.id })).json()).toMatchObject({ status: "BLOCKED", reason: "KEY_UNAVAILABLE" });
      const after = (await app.inject({ url: "/api/space-vault/keys", headers: alice.headers })).json().keys[0];
      expect(after).toMatchObject({ id: key.id, hasValue: false, usedByPaneId: pane.id });
      expect(after.usedAt).toBeTruthy();
      // The receipt goes only on the owner's delete; everything is audited as KEY_HANDOFF.
      expect((await app.inject({ method: "DELETE", url: `/api/space-vault/keys/${encodeURIComponent(key.id)}`, headers: bob.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/space-vault/keys/${encodeURIComponent(key.id)}`, headers: alice.headers })).json()).toEqual({ deleted: true });
      const audit = (await app.inject({ url: "/api/space-vault/audit?limit=20", headers: alice.headers })).json();
      expect(audit.entries.map((entry: { event: { action: string; result: string } }) => `${entry.event.action}:${entry.event.result}`))
        .toEqual(expect.arrayContaining(["KEY_HANDOFF:OK", "KEY_HANDOFF:TAKEN", "KEY_HANDOFF:USED", "KEY_HANDOFF:BLOCKED"]));
      expect(JSON.stringify(audit)).not.toContain(SENTINEL);
    } finally {
      await app.close();
    }
  });

  it("keeps a password for every agent: never expires, any pane writes it again, agents find it by label and save the ones that reach them (operator request 2026-10-26)", async () => {
    const { app, store, config, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const { body } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      await app.inject({ method: "PUT", url: "/api/space-vault/agent-access", headers: alice.headers, payload: { enabled: true } });
      const room = (await app.inject({ method: "POST", url: "/api/rooms", headers: alice.headers, payload: { name: "Kept", initialPaneCount: 0 } })).json();
      const agentOf = (title: string) => {
        const pane = store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
        const cli = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING", purpose: "NORMAL" });
        const headers = { [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: pane.id, cliSessionId: cli.sessionId })!, "content-type": "application/json" };
        return { pane, call: (path: string, payload: unknown) => app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, headers, payload: payload as never }) };
      };
      const one = agentOf("One");
      const two = agentOf("Two");
      const created = await app.inject({ method: "POST", url: "/api/space-vault/keys", headers: alice.headers, payload: { label: "lab mac admin password", value: SENTINEL, expiresInHours: null, kept: true } });
      const key = created.json().key;
      expect(key).toMatchObject({ kept: true, expiresAt: null, savedBy: null, hasValue: true });
      // A one-time key is not listed: only kept ones are the agents' to find.
      await app.inject({ method: "POST", url: "/api/space-vault/keys", headers: alice.headers, payload: { label: "lab one-time", value: "x" } });
      expect((await one.call("key-list", { q: "LAB admin" })).json()).toEqual({ status: "LISTED", auditId: expect.stringMatching(/^vault_audit:/), keys: [{ id: key.id, label: "lab mac admin password", savedBy: null }] });
      expect((await one.call("key-list", { q: "other-host" })).json().keys).toEqual([]);
      for (const agent of [one, two, one]) {
        expect((await agent.call("key-take", { id: key.id })).json()).toMatchObject({ status: "TAKEN", value: SENTINEL });
        expect((await agent.call("key-used", { id: key.id })).json()).toMatchObject({ status: "USED" });
      }
      expect((await app.inject({ url: "/api/space-vault/keys", headers: alice.headers })).json().keys.find((entry: { id: string }) => entry.id === key.id)).toMatchObject({ hasValue: true, usedByPaneId: one.pane.id });
      // A password that reached an agent (a mail): kept at once, listed for every agent, named by the pane that saved it.
      const saved = (await two.call("key-save", { label: "Mailed DB password", value: "SYNTHETIC-mailed" })).json();
      expect(saved).toEqual({ status: "SAVED", auditId: expect.stringMatching(/^vault_audit:/), reason: null, id: expect.stringMatching(/^vault_key:/) });
      expect((await one.call("key-list", { q: "mailed" })).json().keys).toEqual([{ id: saved.id, label: "Mailed DB password", savedBy: two.pane.id }]);
      expect((await one.call("key-take", { id: saved.id })).json()).toMatchObject({ status: "TAKEN", value: "SYNTHETIC-mailed" });
      expect((await app.inject({ method: "POST", url: "/api/space-vault/keys", headers: alice.headers, payload: { label: "x", value: "y", expiresInHours: 0 } })).statusCode).toBe(422);
      // Agent access off: nothing is listed, saved or taken.
      await app.inject({ method: "PUT", url: "/api/space-vault/agent-access", headers: alice.headers, payload: { enabled: false } });
      for (const [path, payload] of [["key-list", {}], ["key-save", { label: "x", value: "y" }], ["key-take", { id: key.id }]] as const) {
        expect((await one.call(path, payload)).json()).toMatchObject({ status: "BLOCKED", reason: "AGENT_ACCESS_OFF" });
      }
    } finally {
      await app.close();
    }
  });
});

describe("Vault agent access switch", () => {
  it("turns on with the operator's session only, shows in the state, and goes off with revoke", async () => {
    const { app, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const url = "/api/space-vault/agent-access";
      expect((await app.inject({ method: "PUT", url, headers: alice.headers, payload: { enabled: true } })).json().error.code).toBe("VAULT_NOT_ENROLLED");
      const { body } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      expect((await app.inject({ method: "PUT", url, headers: { cookie: alice.cookie }, payload: { enabled: true } })).json().error.code).toBe("CSRF_INVALID");
      expect((await app.inject({ method: "PUT", url, headers: alice.headers, payload: { enabled: true } })).json()).toEqual({ agentAccess: true });
      expect((await app.inject({ url: "/api/space-vault/state", headers: alice.headers })).json()).toMatchObject({ agentAccess: true, delegatedItems: 0 });
      expect((await app.inject({ method: "PUT", url, headers: alice.headers, payload: { enabled: false } })).json()).toEqual({ agentAccess: false, generation: 1, epoch: 2 });
      expect((await app.inject({ url: "/api/space-vault/state", headers: alice.headers })).json().agentAccess).toBe(false);
      await app.inject({ method: "PUT", url, headers: alice.headers, payload: { enabled: true } });
      await app.inject({ method: "POST", url: "/api/space-vault/revoke", headers: alice.headers, payload: {} });
      expect((await app.inject({ url: "/api/space-vault/state", headers: alice.headers })).json().agentAccess).toBe(false);
      // The operator's protected-pane step and per-use approvals are gone.
      expect((await app.inject({ url: "/api/space-vault/protected-panes", headers: alice.headers })).statusCode).toBe(404);
      expect((await app.inject({ url: "/api/space-vault/approvals", headers: alice.headers })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
