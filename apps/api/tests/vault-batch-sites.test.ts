import { describe, expect, it } from "vitest";
import { newVaultHandle, signVaultMessage, vaultOperatorRequestMessage } from "@space/contracts";
import { checkVaultSite, checkVaultSites, type VaultSiteCheckDeps } from "../src/vault/site-check.js";
import { SENTINEL, enrollment, fixture, itemRecord } from "./support/vault-fakes.js";

// Operator request 2026-10-21 (plan clipboard:SMcT__jALB6R): a Chrome import of hundreds of logins saves in a few requests, and
// the dock finds login sites that no longer exist and deletes them, one by one or together. Synthetic values only.
const dnsError = (code: string) => Object.assign(new Error(code), { code });
const network = (dns: Record<string, string[] | string>, http: Record<string, number | string>): VaultSiteCheckDeps => ({
  resolve: async (host, family) => {
    const answer = dns[host];
    if (typeof answer === "string") throw dnsError(answer);
    const addresses = (answer ?? []).filter((address) => (family === 6) === address.includes(":"));
    if (!addresses.length) throw dnsError("ENODATA");
    return addresses;
  },
  head: async (origin) => { const answer = http[origin]; if (typeof answer === "string") throw Object.assign(new TypeError("fetch failed"), { cause: { code: answer } }); return answer ?? 200; }
});

describe("Vault login site check", () => {
  it("tells gone sites from live, unreachable and local ones without reading any page", async () => {
    const deps = network({ "live.example": ["93.184.216.34"], "gone.example": "ENOTFOUND", "down.example": ["93.184.216.35"], "slow-dns.example": "ETIMEOUT",
      "router.example": ["192.168.1.1"], "v6.example": ["2606:4700::1"] }, { "https://down.example": "ECONNREFUSED", "https://v6.example": 405 });
    expect(await checkVaultSites(["https://live.example", "https://gone.example", "https://down.example", "https://slow-dns.example", "https://router.example",
      "http://192.168.1.1", "https://nas.lan", "https://v6.example"], deps)).toEqual([
      { origin: "https://live.example", status: "OK", detail: "200" },
      { origin: "https://gone.example", status: "NO_DNS", detail: null },
      { origin: "https://down.example", status: "UNREACHABLE", detail: "ECONNREFUSED" },
      { origin: "https://slow-dns.example", status: "UNREACHABLE", detail: "ETIMEOUT" },
      { origin: "https://router.example", status: "LOCAL", detail: null },
      { origin: "http://192.168.1.1", status: "LOCAL", detail: null },
      { origin: "https://nas.lan", status: "LOCAL", detail: null },
      { origin: "https://v6.example", status: "OK", detail: "405" }
    ]);
    // A name with no address of either kind is gone too.
    expect((await checkVaultSite("https://empty.example", network({ "empty.example": [] }, {}))).status).toBe("NO_DNS");
  });
});

describe("Vault batch routes", () => {
  it("saves and deletes many items in one request each, per owner, and checks only the owner's own sites", async () => {
    const { app, brokerKey, session } = await fixture();
    try {
      const alice = await session({ id: "user:alice", email: "alice@space.local", role: "OPERATOR" });
      const bob = await session({ id: "user:bob", email: "bob@space.local", role: "USER" });
      const { body, signing } = await enrollment(brokerKey.publicKey, "user:alice");
      await app.inject({ method: "POST", url: "/api/space-vault/enroll", headers: alice.headers, payload: body });
      // Deletes carry the unlocked dock's signature (Vault review 2026-10-22).
      const deletion = async (ids: string[]) => ({ ids, epoch: 1, operatorSignature: await signVaultMessage(signing.privateKey, vaultOperatorRequestMessage("item-delete", { ownerUserId: "user:alice", vaultId: body.vaultId, ids, epoch: 1 })) });
      const items = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
        const item = await itemRecord("user:alice", body.vaultId);
        return { ...item, metadata: { ...item.metadata, label: `Site ${index}`, origins: [index === 0 ? "https://router.lan" : `https://site-${index}.example`] } };
      }));
      expect((await app.inject({ method: "PUT", url: "/api/space-vault/items", headers: alice.headers, payload: { items } })).json()).toEqual({ saved: 100, refused: 0 });
      expect((await app.inject({ method: "PUT", url: "/api/space-vault/items", headers: alice.headers, payload: { items: [...items, items[0]] } })).statusCode).toBe(422);
      expect((await app.inject({ method: "PUT", url: "/api/space-vault/items", headers: alice.headers, payload: { items: [{ ...items[0], fields: { PASSWORD: { plaintext: SENTINEL } } }] } })).statusCode).toBe(422);
      expect((await app.inject({ method: "GET", url: "/api/space-vault/items", headers: alice.headers })).json().items).toHaveLength(100);
      // Only the owner's own origins are looked up: a foreign address is dropped, a local one is never contacted.
      const checked = await app.inject({ method: "POST", url: "/api/space-vault/site-check", headers: alice.headers, payload: { origins: ["https://router.lan", "https://elsewhere.example"] } });
      expect(checked.json()).toEqual({ results: [{ origin: "https://router.lan", status: "LOCAL", detail: null }] });
      expect((await app.inject({ method: "POST", url: "/api/space-vault/site-check", headers: bob.headers, payload: { origins: ["https://router.lan"] } })).json()).toEqual({ results: [] });
      const ids = items.slice(0, 3).map((item) => item.metadata.id);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/items/delete", headers: bob.headers, payload: await deletion(ids) })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: "/api/space-vault/items/delete", headers: alice.headers, payload: await deletion([...ids, newVaultHandle("vault_item")]) })).json()).toEqual({ deleted: 3 });
      expect((await app.inject({ method: "GET", url: "/api/space-vault/items", headers: alice.headers })).json().items).toHaveLength(97);
    } finally {
      await app.close();
    }
  });
});
