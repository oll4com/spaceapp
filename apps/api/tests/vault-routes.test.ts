import { describe, expect, it } from "vitest";
import { generateVaultTransportKey, newVaultHandle, vaultBase64url } from "@space/contracts";
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
      expect(listed.body).not.toContain(SENTINEL);
      expect((await app.inject({ method: "GET", url, headers: bob.headers })).json().error.code).toBe("VAULT_ITEM_NOT_FOUND");
      expect((await app.inject({ method: "DELETE", url, headers: bob.headers })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/revoke", headers: alice.headers, payload: {} })).json()).toEqual({ generation: 1, epoch: 2 });
      expect((await app.inject({ method: "POST", url: "/api/space-vault/revoke", headers: bob.headers, payload: {} })).json().error.code).toBe("VAULT_NOT_ENROLLED");
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
      expect((await call("list", {})).json()).toEqual({ status: "BLOCKED", auditId: null });
      const { body } = await enrollment(brokerKey.publicKey, (await store.getRoom(room.id)).ownerUserId!);
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      const handle = newVaultHandle("vault_item");
      for (const [path, payload] of [["list", {}], ["fill", { handle, fields: ["USERNAME", "PASSWORD"] }], ["totp-fill", { handle }],
        ["generate-fill", { purpose: "NEW_ACCOUNT", label: "Synthetic shop", username: "synthetic@example.com", roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"] }],
        ["generate-fill", { purpose: "CHANGE_PASSWORD", handle }], ["save", { site: "https://shop.example", username: "synthetic@example.com", password: SENTINEL, label: "Shop" }]] as const) {
        const answer = await call(path, payload);
        expect(answer.statusCode, path).toBe(200);
        expect(answer.json(), path).toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/) });
        expect(answer.body, path).not.toContain(SENTINEL);
      }
      expect((await call("status", {})).json()).toEqual({ status: "LISTED", auditId: expect.stringMatching(/^vault_audit:/), agentAccess: false, delegatedItems: 0 });
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
