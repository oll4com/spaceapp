import { z } from "zod";
import { getDomain, parse } from "tldts";
import { webUrlWithoutCredentials } from "./link-rules.js";

/** Registrable domain, including private suffixes: tenant sites must not collapse into their hosting provider. */
export function siteSigninDomain(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!webUrlWithoutCredentials(url, true)) throw new Error("A public site domain is required");
  const domain = getDomain(url.hostname, { allowPrivateDomains: true });
  if (!domain) throw new Error("A public site domain is required");
  return domain.toLowerCase();
}
/** A host whose suffix is a real public suffix (ICANN or private list), lower-case without "www."; null for unit, file and local names. */
export function publicSiteHost(host: string): string | null {
  const parsed = parse(host.toLowerCase(), { allowPrivateDomains: true });
  return parsed.domain && !parsed.isIp && (parsed.isIcann || parsed.isPrivate) ? parsed.hostname!.replace(/^www\./, "") : null;
}
export const siteSigninKeySchema = z.object({
  site: z.string().trim().min(1).max(2000).transform((value, ctx) => {
    try { return siteSigninDomain(value); } catch { ctx.addIssue({ code: "custom", message: "Use a public site domain or http(s) URL without credentials" }); return z.NEVER; }
  }), accountLabel: z.string().trim().min(1).max(100).default("main")
}).strict();
const text = (max: number) => z.string().trim().max(max).nullable().optional();
export const siteSigninFieldsSchema = z.object({
  method: z.enum(["GOOGLE", "APPLE", "LINKEDIN", "GITHUB", "MICROSOFT", "VAULT_LOGIN", "EMAIL_CODE", "OTHER"]).optional(),
  googleAccountEmail: z.email().max(320).nullable().optional(), browserProfileId: text(200), siteAccountEmail: z.email().max(320).nullable().optional(),
  username: text(320), vaultHandle: z.string().regex(/^vault_(?:item|pending|key):[a-zA-Z0-9_-]+$/).max(200).nullable().optional(),
  mailbox: text(500), mfa: text(200), notes: text(500)
}).strict();
export const siteSigninRecordSchema = siteSigninKeySchema.extend(siteSigninFieldsSchema.shape).extend({
  outcome: z.enum(["SUCCESS", "FAILURE", "CHANGED", "PENDING"]), reason: text(500)
}).strict();
export type SiteSigninInput = z.infer<typeof siteSigninRecordSchema>;
export interface SiteSigninEvent { at: string; by: string; outcome: SiteSigninInput["outcome"]; changes: Partial<z.infer<typeof siteSigninFieldsSchema>>; reason: string | null }
export interface SiteSignin extends z.infer<typeof siteSigninFieldsSchema> {
  site: string; accountLabel: string; method: NonNullable<SiteSigninInput["method"]>;
  lastSuccessAt: string | null; lastSuccessBy: string | null; successCount: number;
  lastFailureAt: string | null; lastFailureReason: string | null;
  pendingAttempt: { at: string; by: string; method?: NonNullable<SiteSigninInput["method"]>; vaultHandle: string | null; browserProfileId: string | null; usernameLabel: string | null } | null;
  updatedAt: string; history: SiteSigninEvent[];
}
