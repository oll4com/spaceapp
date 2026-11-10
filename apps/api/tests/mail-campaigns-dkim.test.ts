// Space's own DKIM signature on SMTP campaign mail (Nous 2/11, plan clipboard:IJ2ovfLg1Lbw step 11): public-host's Plesk signer covers only
// From:To:Subject, so the one-click headers (RFC 8058 §4), Message-ID, Date and the MIME headers were unsigned. The verifier below is the
// test's own reading of RFC 6376 (relaxed/relaxed), so a change to the signer that a receiver would reject fails here.
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mailSenderCreateSchema } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { DKIM_SIGNED_HEADERS, dkimSign } from "../src/mail-campaigns/dkim.js";
import { buildCampaignMime } from "../src/mail-campaigns/mime.js";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { createMailTransports, type MailTransports } from "../src/mail-campaigns/transports.js";
import { stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// As kept in the Vault: one line, the PKCS#8 DER in base64.
const vaultValue = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

function verify(raw: Buffer): { ok: boolean; tags: Record<string, string> } {
  const text = raw.toString("utf8");
  const gap = /\r\n\r\n/.exec(text)!;
  const fields = text.slice(0, gap.index).split(/\r\n(?![ \t])/).map((field) => ({ name: field.slice(0, field.indexOf(":")), value: field.slice(field.indexOf(":") + 1) }));
  const canon = (name: string, value: string) => `${name.trim().toLowerCase()}:${value.replace(/\r\n([ \t])/g, "$1").replace(/[ \t]+/g, " ").trim()}`;
  const signature = fields.find((field) => field.name.toLowerCase() === "dkim-signature")!;
  const tags = Object.fromEntries(signature.value.split(";").map((tag) => tag.trim().split(/=(.*)/s).slice(0, 2).map((part) => part!.replace(/\s+/g, ""))));
  const lines = text.slice(gap.index + 4).split("\r\n").map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.at(-1) === "") lines.pop();
  if (createHash("sha256").update(lines.length ? `${lines.join("\r\n")}\r\n` : "").digest("base64") !== tags.bh) return { ok: false, tags };
  const used = new Map<string, number>();
  const headers = tags.h!.split(":").map((name) => {
    const all = fields.filter((field) => field.name.trim().toLowerCase() === name && field !== signature);
    const index = all.length - 1 - (used.get(name) ?? 0); used.set(name, (used.get(name) ?? 0) + 1);
    return index >= 0 ? `${canon(all[index]!.name, all[index]!.value)}\r\n` : "";
  }).join("");
  const unsigned = canon("DKIM-Signature", signature.value.replace(/b=[^;]*$/, "b="));
  return { ok: createVerify("RSA-SHA256").update(headers + unsigned).verify(publicKey, Buffer.from(tags.b!, "base64")), tags };
}

const mime = () => buildCampaignMime({ from: "ntheo@example.invalid", fromName: "oll4", to: "buyer@example.gr", replyTo: null, subject: "Νέα προϊόντα", preheader: "",
  html: "<p>Γεια σας</p>", text: "Γεια σας", language: "el", campaignId: "mcamp:abcdefghijkl", contactId: "mcontact:abcdefghijkl", senderDomain: "oll4.com",
  footerAddress: "oll4, Athens", unsubscribeUrl: "https://oll4.com/u/?t=abc", test: false }).raw;

describe("DKIM signature of SMTP campaign mail", () => {
  it("signs the one-click, Message-ID, Date and MIME headers with d= the sender's domain, and breaks when they change", () => {
    const signed = dkimSign(mime(), { domain: "oll4.com", selector: "space", privateKey: vaultValue, now: 1_800_000_000_000 });
    const { ok, tags } = verify(signed);
    expect(ok).toBe(true);
    expect(tags).toMatchObject({ v: "1", a: "rsa-sha256", c: "relaxed/relaxed", d: "oll4.com", s: "space", t: "1800000000" });
    expect(tags.h!.split(":")).toEqual(expect.arrayContaining(["from", "to", "subject", "date", "message-id", "list-unsubscribe", "list-unsubscribe-post", "list-id",
      "mime-version", "content-type"]));
    expect(tags.h!.split(":").every((name) => (DKIM_SIGNED_HEADERS as readonly string[]).includes(name))).toBe(true);
    const text = signed.toString("utf8");
    expect(verify(Buffer.from(text.replace("https://oll4.com/u/?t=abc", "https://evil.example/u/?t=abc"))).ok).toBe(false);
    expect(verify(Buffer.from(text.replace(/\r\n--mc-[^\r]*--\r\n$/, "\r\nadded\r\n"))).ok).toBe(false);
  });

  it("signs an SMTP sender's mail only when it names a DKIM key, read from the Vault at send time", async () => {
    const submitted: Buffer[] = []; const asked: string[] = [];
    const transports = createMailTransports({ google: () => null, heloName: "example.invalid",
      keptKey: async (_owner, id) => { asked.push(id); return id === "vault_key:dkimkey01" ? vaultValue : "smtp-password"; },
      smtp: { check: async () => "ok", submit: async (_options, _envelope, raw) => { submitted.push(raw); return { providerId: "Q1" }; } } });
    const sender = (dkim?: { selector: string; vaultKeyId: string }) => ({ domain: "oll4.com", address: "ntheo@example.invalid",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "ntheo@example.invalid", vaultKeyId: "vault_key:smtppass1", ...(dkim ? { dkim } : {}) } }) as Parameters<MailTransports["for"]>[1];
    await transports.for("user:o", sender()).send(mime(), { from: "ntheo@example.invalid", to: "buyer@example.gr" });
    expect(submitted[0]!.toString().startsWith("DKIM-Signature")).toBe(false);
    await transports.for("user:o", sender({ selector: "space", vaultKeyId: "vault_key:dkimkey01" })).send(mime(), { from: "ntheo@example.invalid", to: "buyer@example.gr" });
    expect(verify(submitted[1]!)).toMatchObject({ ok: true, tags: { d: "oll4.com", s: "space" } });
    expect(asked).toContain("vault_key:dkimkey01");
  });

  it("sets and clears an SMTP sender's DKIM key; Gmail senders sign their own", async () => {
    const service = createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports: { for: () => ({}) } as unknown as MailTransports });
    const base = { displayName: "oll4", footerAddress: "oll4, Athens" };
    const smtp = await service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "news@brand.example",
      config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "news@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "test");
    const dkim = { selector: "space", vaultKeyId: "vault_key:dkimkey01" };
    expect((await service.updateSender("user:o", smtp.id, { dkim }))!.config).toMatchObject({ route: "SMTP", vaultKeyId: "vault_key:abcdef12", dkim });
    expect((await service.updateSender("user:o", smtp.id, { dkim: null }))!.config).not.toHaveProperty("dkim");
    const gmail = await service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "someone@gmail.com", config: { route: "GMAIL_CONNECTOR", account: "someone@gmail.com" } }), "test");
    await expect(service.updateSender("user:o", gmail.id, { dkim })).rejects.toThrow(/Gmail signs its own/);
  });
});
