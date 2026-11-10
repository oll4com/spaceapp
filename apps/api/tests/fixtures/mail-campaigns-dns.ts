import { vi } from "vitest";

// Mail Campaigns tests: our own SMTP server and egress address (an instance's SPACE_MAIL_* settings, mail-campaigns/site.ts).
export const MAIL_SITE = { egressIp: "192.0.2.25", smtpHost: "smtp.brand.example" };
/** Call at the top of a test file that adds SMTP senders or checks them. */
export function stubMailSite() {
  vi.stubEnv("SPACE_MAIL_EGRESS_IP", MAIL_SITE.egressIp);
  vi.stubEnv("SPACE_MAIL_SMTP_HOSTS", MAIL_SITE.smtpHost);
}

// DNS where brand.example is authenticated for the SMTP route and nothing is listed.
export const passingDns = {
  txt: async (name: string) => ({ "brand.example": [`v=spf1 mx a ip4:${MAIL_SITE.egressIp} include:_spf.mx.cloudflare.net ~all`], "default._domainkey.brand.example": ["v=DKIM1; k=rsa; p=MIIBIjAN"],
    "_dmarc.brand.example": ["v=DMARC1; p=quarantine; rua=mailto:dmarc@brand.example"] } as Record<string, string[]>)[name] ?? [],
  mx: async (name: string) => name === "brand.example" ? ["route1.mx.cloudflare.net"] : [],
  a: async (name: string) => name === MAIL_SITE.smtpHost ? [MAIL_SITE.egressIp] : [],
  ptr: async () => [MAIL_SITE.smtpHost]
};
