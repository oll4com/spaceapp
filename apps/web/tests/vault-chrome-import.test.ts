/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import { newVaultHandle, vaultItemRecordSchema, vaultRandomBytes, type VaultItemRecordInput } from "@space/contracts";
import { ChromeImportError, parseChromePasswords, parseCsv, planChromeImport, runChromeImport } from "../src/features/vault/chrome-import.js";
import { decryptVaultItem, encryptVaultItem, vaultLoginKey, VAULT_AGENT_POLICY, type UnlockedVault } from "../src/features/vault/vault-client.js";

// Synthetic logins only; nothing here is a real credential.
const SENTINEL = "SYNTHETIC-chrome-sentinel-5c1e";
const HEADER = "name,url,username,password,note";

describe("Chrome passwords CSV", () => {
  it("parses quotes, escaped quotes, multi-line notes, CRLF and a BOM", () => {
    expect(parseCsv("\uFEFFa,b\r\n\"x, y\",\"say \"\"hi\"\"\"\r\n\"line 1\nline 2\",z\n\n")).toEqual([["a", "b"], ["x, y", "say \"hi\""], ["line 1\nline 2", "z"]]);
  });

  it("maps rows to logins: origin, label, username; skips android, rows without a site or password; the last duplicate wins", () => {
    const csv = [HEADER,
      `shop.example,https://shop.example/login?next=/,ana@example.com,${SENTINEL}-old,`,
      `,https://Shop.Example:443/account,ANA@example.com,${SENTINEL}-new,"two\nlines"`,
      `app,android://hash@com.example.app/,ana,${SENTINEL},`,
      `nosite,,ana,${SENTINEL},`,
      `bad,not a url,ana,${SENTINEL},`,
      "nopass,https://nopass.example/,ana,,",
      `router,http://192.168.1.1/,admin,${SENTINEL}-r,`].join("\r\n");
    const parsed = parseChromePasswords(csv);
    expect(parsed.logins).toEqual([
      { label: "shop.example", origin: "https://shop.example", risky: false, username: "ANA@example.com", password: `${SENTINEL}-new` },
      { label: "router", origin: "http://192.168.1.1", risky: true, username: "admin", password: `${SENTINEL}-r` }
    ]);
    expect(parsed.skipped).toEqual({ ANDROID_APP: 1, NO_SITE: 2, NO_PASSWORD: 1 });
    expect(parsed.duplicates).toBe(1);
    expect(parsed.notes).toBe(1);
  });

  it("reads older exports without a note column and refuses files that are not a Chrome export", () => {
    expect(parseChromePasswords(`name,url,username,password\nx,https://a.example/,,${SENTINEL}\n`).logins).toEqual([
      { label: "x", origin: "https://a.example", risky: false, username: "", password: SENTINEL }]);
    expect(() => parseChromePasswords("title,login\nx,y\n")).toThrow(ChromeImportError);
    expect(() => parseChromePasswords("")).toThrow(ChromeImportError);
  });
});

function vault() {
  const unlocked: UnlockedVault = { ownerUserId: "user:alice", vaultId: newVaultHandle("vault"), epoch: 1, vrk: vaultRandomBytes(32), passwordShare: vaultRandomBytes(32), signingKey: vaultRandomBytes(32) };
  const stored: Record<string, VaultItemRecordInput> = {};
  const sent: string[] = [];
  const api = {
    vaultItemRecords: async () => ({ items: Object.values(stored).map((record) => vaultItemRecordSchema.parse(record)) }),
    vaultItem: async (id: string) => ({ item: vaultItemRecordSchema.parse(stored[id]) }),
    vaultSaveItem: async (item: VaultItemRecordInput) => { sent.push(JSON.stringify(item)); stored[item.metadata.id] = item; return { item: vaultItemRecordSchema.parse(item) }; },
    vaultSaveItems: async (items: VaultItemRecordInput[]) => { sent.push(JSON.stringify(items)); for (const item of items) stored[item.metadata.id] = item; return { saved: items.length }; }
  };
  return { unlocked, stored, sent, api };
}

describe("Chrome import into the Vault", () => {
  it("adds, updates and leaves unchanged by account + site + username; a re-run changes nothing; nothing leaves in plain text", async () => {
    const { unlocked, stored, sent, api } = vault();
    const work = "google_account:work-1";
    // The same login without an account, and under another account: both stay separate from the work account's.
    for (const googleAccountId of [null, "google_account:home-1"]) {
      await api.vaultSaveItem(await encryptVaultItem(unlocked, { label: "Shop", origins: ["https://shop.example"], googleAccountId, policy: { ...VAULT_AGENT_POLICY, acceptedOriginRisks: [] },
        secrets: { USERNAME: "ana@example.com", PASSWORD: `${SENTINEL}-other` } }));
    }
    const first = parseChromePasswords([HEADER, `shop,https://shop.example/,ana@example.com,${SENTINEL}-1,`, `mail,https://mail.example/,ana,${SENTINEL}-m,`].join("\n"));
    const plan = await planChromeImport(api, unlocked, first, work);
    expect([plan.add.length, plan.update.length, plan.unchanged]).toEqual([2, 0, 0]);
    expect(await runChromeImport(api, unlocked, plan)).toBe(2);
    const workItems = Object.values(stored).map((record) => vaultItemRecordSchema.parse(record)).filter((record) => record.metadata.googleAccountId === work);
    expect(workItems.map((record) => record.metadata.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(workItems[0]!.metadata.policy.agentUse).toBe(true);
    // The same login under two accounts shares its login key; the key is not the username.
    const shop = Object.values(stored).map((record) => vaultItemRecordSchema.parse(record).metadata).filter((metadata) => metadata.origins[0] === "https://shop.example");
    expect(new Set(shop.map((metadata) => metadata.loginKey)).size).toBe(1);
    expect(shop[0]!.loginKey).toBe(vaultLoginKey(unlocked, "https://shop.example", "ANA@example.com"));
    expect(shop[0]!.loginKey).not.toContain("ana");

    const again = await planChromeImport(api, unlocked, first, work);
    expect([again.add.length, again.update.length, again.unchanged]).toEqual([0, 0, 2]);

    const changed = parseChromePasswords([HEADER, `shop,https://shop.example/,ANA@example.com,${SENTINEL}-2,`].join("\n"));
    const update = await planChromeImport(api, unlocked, changed, work);
    expect([update.add.length, update.update.length, update.unchanged]).toEqual([0, 1, 0]);
    const progress: number[] = [];
    await runChromeImport(api, unlocked, update, (done, total) => progress.push(done, total));
    expect(progress).toEqual([1, 1]);
    // Hundreds of logins go in batches of 100 (one request and one transaction each), not one request per login.
    const many = parseChromePasswords([HEADER, ...Array.from({ length: 250 }, (_, index) => `s${index},https://s${index}.example/,u${index},${SENTINEL}-${index},`)].join("\n"));
    const before = sent.length;
    const steps: number[] = [];
    expect(await runChromeImport(api, unlocked, await planChromeImport(api, unlocked, many, work), (done) => steps.push(done))).toBe(250);
    expect(sent.length - before).toBe(3);
    expect(steps).toEqual([100, 200, 250]);
    const updated = vaultItemRecordSchema.parse(stored[update.update[0]!.previous.metadata.id]);
    expect(updated.metadata.googleAccountId).toBe(work);
    expect((await decryptVaultItem(unlocked, updated)).PASSWORD).toBe(`${SENTINEL}-2`);
    // The old password stays in the silent history, with no confirm step.
    expect((await decryptVaultItem(unlocked, updated, updated.history[0]!.fields)).PASSWORD).toBe(`${SENTINEL}-1`);
    expect(updated.metadata.status).toBe("ACTIVE");
    for (const body of sent) expect(body).not.toContain(SENTINEL);
  });

  it("accepts the http or IP site of an imported login and imports under no account", async () => {
    const { unlocked, stored, api } = vault();
    const plan = await planChromeImport(api, unlocked, parseChromePasswords(`${HEADER}\nrouter,http://192.168.1.1/,admin,${SENTINEL},`), null);
    await runChromeImport(api, unlocked, plan);
    const [record] = Object.values(stored).map((item) => vaultItemRecordSchema.parse(item));
    expect(record!.metadata).toMatchObject({ origins: ["http://192.168.1.1"], googleAccountId: null, policy: { acceptedOriginRisks: ["http://192.168.1.1"] } });
  });
});
