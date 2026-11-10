import { describe, expect, it } from "vitest";
import { healthSendable, mailCampaignCreateSchema, mailCampaignFingerprintInput, mailCampaignScheduleSchema, mailSenderCreateSchema, mailSuppressed,
  mailSuppressionInputSchema, mailTemplateContentSchema, mailTemplateFingerprintInput, mailTemplateVariablesUsed, normalizeMailAddress,
  normalizeSuppressionPattern, renderMailTemplate } from "../src/mail-campaigns.js";

describe("mail campaign addresses", () => {
  it("normalizes one address per mailbox and refuses what is not local@domain.tld", () => {
    expect(normalizeMailAddress("  Info@Example.GR ")).toBe("info@example.gr");
    expect(normalizeMailAddress("mailto:<sales@shop.example.>")).toBe("sales@shop.example");
    expect(normalizeMailAddress("first.last+tag@gmail.com")).toBe("first.last+tag@gmail.com");
    expect(normalizeMailAddress("user@ελλάδα.gr")).toBe("user@xn--hxakic4aa.gr");
    for (const bad of ["", "nope", "@example.gr", "a@b", "a@-b.gr", "a b@example.gr", "a@olla..gr", `${"x".repeat(65)}@example.gr`, "a@1.2.3.4"])
      expect(normalizeMailAddress(bad), bad).toBeNull();
  });
  it("suppresses an exact address or a whole domain", () => {
    expect(normalizeSuppressionPattern("@ShopFlix.GR")).toBe("@shopflix.gr");
    expect(normalizeSuppressionPattern("@")).toBeNull();
    const patterns = new Set(["@shopflix.gr", "no@example.gr"]);
    expect(mailSuppressed(patterns, "anyone@shopflix.gr")).toBe(true);
    expect(mailSuppressed(patterns, "no@example.gr")).toBe(true);
    expect(mailSuppressed(patterns, "yes@example.gr")).toBe(false);
    expect(mailSuppressionInputSchema.parse({ pattern: " NO@example.gr", reason: "UNSUBSCRIBE", source: "test" })).toMatchObject({ pattern: "no@example.gr", note: "" });
    expect(mailSuppressionInputSchema.safeParse({ pattern: "not-mail", reason: "UNSUBSCRIBE", source: "test" }).success).toBe(false);
  });
  it("sends only to healthy addresses", () => {
    expect(["VALID", "RISKY", "UNKNOWN"].every((health) => healthSendable(health as never))).toBe(true);
    expect(["INVALID", "BOUNCED", "COMPLAINED", "UNSUBSCRIBED"].some((health) => healthSendable(health as never))).toBe(false);
  });
});

describe("mail templates", () => {
  const content = mailTemplateContentSchema.parse({ subject: "Γεια {{ firstName }}", html: "<p>Hi {{firstName}}, {{offer}}</p>", text: "Hi {{firstName}}, {{offer}}",
    variables: [{ name: "firstName", default: "φίλε" }, { name: "offer", required: true }] });
  it("escapes values in HTML only and fills defaults", () => {
    const out = renderMailTemplate(content, { offer: "<b>-20%</b> & more" });
    expect(out.subject).toBe("Γεια φίλε");
    expect(out.html).toBe("<p>Hi φίλε, &lt;b&gt;-20%&lt;/b&gt; &amp; more</p>");
    expect(out.text).toBe("Hi φίλε, <b>-20%</b> & more");
    expect(renderMailTemplate(content, { offer: "x", firstName: "Line\r\nBcc: x" }).subject).toBe("Γεια Line Bcc: x");
  });
  it("refuses a missing required value or an undeclared variable", () => {
    expect(() => renderMailTemplate(content, {})).toThrow(/offer/);
    expect(() => renderMailTemplate({ ...content, text: "{{unknown}}" }, { offer: "x" })).toThrow(/declare/);
    expect(mailTemplateVariablesUsed(content).sort()).toEqual(["firstName", "offer"]);
  });
  it("fingerprints every field a recipient sees", () => {
    const base = mailTemplateFingerprintInput(content);
    expect(mailTemplateFingerprintInput({ ...content })).toBe(base);
    for (const change of [{ subject: "x" }, { preheader: "x" }, { html: "<p>x</p>" }, { text: "x" }, { variables: [] }])
      expect(mailTemplateFingerprintInput({ ...content, ...change })).not.toBe(base);
  });
  it("takes a plain-text mail without HTML", () => {
    expect(mailTemplateContentSchema.parse({ subject: "s", text: "Hello" }).html).toBe("");
  });
  it("requires a plain-text part and keeps HTML under Gmail's clip", () => {
    expect(mailTemplateContentSchema.safeParse({ subject: "s", html: "<p>x</p>", text: " " }).success).toBe(false);
    expect(mailTemplateContentSchema.safeParse({ subject: "s", html: "x".repeat(90_001), text: "x" }).success).toBe(false);
  });
});

describe("mail campaigns", () => {
  const sender = { id: "msender:abcdef", address: "info@example.gr", displayName: "example.gr", config: { route: "GMAIL_DELEGATED" as const, subject: "info@example.gr", vaultKeyId: "vault_key:delegation1" } };
  const schedule = mailCampaignScheduleSchema.parse({});
  const input = { templateFingerprint: "a".repeat(64), sender, listIds: ["mlist:bbbbbb", "mlist:aaaaaa"], eligible: 120, schedule, pacing: { perMinute: 1, perDay: 300 } };
  it("fingerprints the template, sender, lists in their priority order and count, schedule, pacing and every recipient's rendered mail", () => {
    const base = mailCampaignFingerprintInput(input);
    expect(mailCampaignFingerprintInput({ ...input })).toBe(base);
    expect(mailCampaignFingerprintInput({ ...input, listIds: ["mlist:aaaaaa", "mlist:bbbbbb"] })).not.toBe(base);
    expect(mailCampaignFingerprintInput({ ...input, contentHash: "c".repeat(64) })).not.toBe(base);
    expect(mailCampaignFingerprintInput({ ...input, pacing: { perMinute: 1, perDay: 300, intervalSeconds: 360 } })).not.toBe(base);
    for (const change of [{ templateFingerprint: "b".repeat(64) }, { eligible: 121 }, { pacing: { perMinute: 2, perDay: 300 } },
      { sender: { ...sender, displayName: "Olla" } }, { schedule: { ...schedule, toHour: 17 } }, { listIds: ["mlist:aaaaaa"] }])
      expect(mailCampaignFingerprintInput({ ...input, ...change })).not.toBe(base);
  });
  it("defaults to Greek business hours and one mail a minute", () => {
    const created = mailCampaignCreateSchema.parse({ name: "Kits", templateId: "mtpl:abcdef", senderId: "msender:abcdef", listIds: ["mlist:abcdef"] });
    expect(created.schedule).toMatchObject({ timeZone: "Europe/Athens", days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 18 });
    expect(created.pacing).toEqual({ perMinute: 1, perDay: 300 });
    expect(mailCampaignScheduleSchema.safeParse({ fromHour: 18, toHour: 9 }).success).toBe(false);
  });
  it("takes an SMTP password only as a Vault key id", () => {
    const base = { address: "News@example.invalid", displayName: "oll4", footerAddress: "oll4.com, Athens" };
    expect(mailSenderCreateSchema.parse({ ...base, config: { route: "SMTP", host: "example.invalid", port: 587, username: "news@example.invalid", vaultKeyId: "vault_key:abcdef12" } }).address).toBe("news@example.invalid");
    expect(mailSenderCreateSchema.safeParse({ ...base, config: { route: "SMTP", host: "example.invalid", port: 587, username: "u", vaultKeyId: "hunter2" } }).success).toBe(false);
    expect(mailSenderCreateSchema.safeParse({ ...base, config: { route: "SMTP", host: "example.invalid", port: 25, username: "u", vaultKeyId: "vault_key:abcdef12" } }).success).toBe(false);
  });
});
