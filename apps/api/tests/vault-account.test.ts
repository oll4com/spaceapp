import { describe, expect, it, vi } from "vitest";
import { generateVaultTransportKey, sealVaultEnvelope, vaultRandomBytes, type Pane, type VaultItemRecord } from "@space/contracts";
import { createVaultAgent } from "../src/vault/agent.js";
import { fakeRepository, enrollment, itemRecord } from "./support/vault-fakes.js";

// Chrome imports (plan clipboard:SMcT__jALB6R): logins carry the Google account they came from. Agents and Nous see the account
// per handle, and a fill into a pane browser on account X prefers X's login of the same site and username. Synthetic values only.
const LOGIN = "https://login.example";
const WORK = "google_account:work-1";
const HOME = "google_account:home-1";
const KEY = "A".repeat(22);
const BROWSER = { id: "pane:browser0001", roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false } as Pane;

async function harness(paneAccount: string | null, undelegated: Array<"home" | "work" | "plain"> = []) {
  const repository = fakeRepository();
  const { body } = await enrollment((await generateVaultTransportKey()).publicKey, "user:alice");
  const { sealedServerShare: _sealed, ...rest } = body;
  await repository.enroll("user:alice", { ...rest, serverShareEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1, purpose: "SERVER_SHARE" }) });
  await repository.enableAgentAccess("user:alice");
  const add = async (googleAccountId: string | null, loginKey: string | null) => {
    const record = await itemRecord("user:alice", body.vaultId);
    const item: VaultItemRecord = { ...record, metadata: { ...record.metadata, origins: [LOGIN], googleAccountId, loginKey } };
    await repository.saveItem("user:alice", item);
    return item.metadata.id;
  };
  const items = { home: await add(HOME, KEY), work: await add(WORK, KEY), plain: await add(null, null) };
  await repository.createDelegation("user:alice", { keyEnvelope: { sealed: "key" }, fillEnvelopes: {}, certificate: { claims: { generation: 1, vaultId: body.vaultId,
    items: Object.entries(items).filter(([name]) => !undelegated.includes(name as never)).map(([, handle]) => ({ handle, origins: [LOGIN], fields: ["USERNAME", "PASSWORD", "OTP"], approvalMode: "FULL", submit: true })) } } } as never);
  const issueUse = vi.fn(async (_input: { handle: string }) => ({ capability: { claims: "signed by the broker" } }));
  const vaultFill = vi.fn(async () => ({ status: "FILLED" as const, reason: null, sealedGenerated: null }));
  const protection = { ownerOf: async () => null, protect: async () => true, unprotect: async () => true };
  const agent = createVaultAgent({ repository, broker: { issueUse } as never, protection: protection as never, listPanes: async () => [BROWSER], paneOwner: async () => "user:alice",
    browser: { vaultTarget: async () => ({ eligible: true, reason: null, targetId: "t", frameId: "f", origin: LOGIN, document: "d" }), vaultFill },
    googleAccounts: async () => [{ id: WORK, email: "work@example.com" }, { id: HOME, email: "home@example.com" }], paneAccount: async () => paneAccount });
  const call = (path: "list" | "fill" | "totp-fill", body: Record<string, unknown>) =>
    agent.call({ owner: "user:alice", paneId: "pane:cliterminal1", roomId: BROWSER.roomId, path, body, traceId: "trace" });
  const audits = async () => (await repository.listAudit("user:alice", { limit: 1 })).map((entry) => entry.event);
  return { items, call, issueUse, audits };
}

describe("Vault logins mapped to a Google account", () => {
  it("lists the account's address per handle, and none for a login without one", async () => {
    const { items, call } = await harness(null);
    const listed = (await call("list", {})) as { items: Array<{ handle: string; account?: string }> };
    expect(Object.fromEntries(listed.items.map((item) => [item.handle, item.account ?? null]))).toEqual({ [items.home]: "home@example.com", [items.work]: "work@example.com", [items.plain]: null });
  });

  it("filters the list by site (its subdomains too) and by account, so a large Vault answers short", async () => {
    const { items, call } = await harness(null);
    const handles = async (body: Record<string, unknown>) => ((await call("list", body)) as { items: Array<{ handle: string }> }).items.map((item) => item.handle).sort();
    expect(await handles({ site: "sub.login.example" })).toEqual([]);
    expect(await handles({ site: "login.example" })).toEqual(Object.values(items).sort());
    expect(await handles({ site: "https://login.example/signin?x=1" })).toEqual(Object.values(items).sort());
    expect(await handles({ site: "other.example" })).toEqual([]);
    expect(await handles({ account: "WORK@example.com" })).toEqual([items.work]);
    expect(await handles({ site: "login.example", account: "home@example.com" })).toEqual([items.home]);
  });

  it("fills the pane account's login of the same site and username, and audits that login", async () => {
    const { items, call, issueUse, audits } = await harness(WORK);
    expect(await call("fill", { handle: items.home, fields: ["PASSWORD"] })).toMatchObject({ status: "FILLED" });
    expect(issueUse).toHaveBeenLastCalledWith(expect.objectContaining({ handle: items.work }));
    expect((await audits())[0]).toMatchObject({ action: "FILL", result: "FILLED", itemId: items.work });
    await call("totp-fill", { handle: items.home });
    expect(issueUse).toHaveBeenLastCalledWith(expect.objectContaining({ handle: items.work }));
  });

  it("keeps the asked login when the twin is not handed to agents", async () => {
    const { items, call, issueUse } = await harness(WORK, ["work"]);
    expect(await call("fill", { handle: items.home, fields: ["PASSWORD"] })).toMatchObject({ status: "FILLED" });
    expect(issueUse).toHaveBeenLastCalledWith(expect.objectContaining({ handle: items.home }));
  });

  it("keeps the asked login when the pane has no account, the same account, or no twin", async () => {
    for (const [paneAccount, handle] of [[null, "home"], [HOME, "home"], [WORK, "plain"]] as const) {
      const { items, call, issueUse } = await harness(paneAccount);
      await call("fill", { handle: items[handle], fields: ["PASSWORD"] });
      expect(issueUse).toHaveBeenLastCalledWith(expect.objectContaining({ handle: items[handle] }));
    }
  });
});
