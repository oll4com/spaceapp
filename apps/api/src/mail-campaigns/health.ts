import type { MailContact, MailHealth } from "@space/contracts";
import type { LabDns } from "./lab.js";

// Address health (plan clipboard:IJ2ovfLg1Lbw step 7) from what Space can know without touching anyone's mail server: the domain's MX
// (else A), disposable and role addresses, likely typos, and our own mail's signals (bounces, complaints, replies, unsubscribes, read by
// signals.ts). No SMTP RCPT probing: it burns our own reputation. Health lives on the contact, so every list shows the same answer.

/** Throwaway mailbox providers (a pinned list; a contact there is RISKY). */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set(["mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "yopmail.com", "trashmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "mintemail.com", "emailondeck.com", "mohmal.com", "tempr.email"]);
/** Addresses nobody reads, or that must never get bulk mail. */
const NEVER_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|postmaster|abuse|mailer-daemon|bounces?|hostmaster)$/;
/** Shared role mailboxes: fine for B2B outreach, RISKY for consent lists (the reason says so). */
const ROLE_LOCAL = /^(info|sales|admin|support|contact|office|hello|marketing|billing|accounts?|team|hr|jobs|orders|shop|eshop|service)$/;
/** Common misspellings of big providers (suggested in the reason, never fixed silently). */
export const DOMAIN_TYPOS: Readonly<Record<string, string>> = { "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmaill.com": "gmail.com",
  "gnail.com": "gmail.com", "hotmial.com": "hotmail.com", "hotmail.co": "hotmail.com", "hotmai.com": "hotmail.com", "yaho.com": "yahoo.com", "yahoo.co": "yahoo.com", "yahooo.com": "yahoo.com",
  "outlok.com": "outlook.com", "outlook.co": "outlook.com", "otenet.com": "otenet.gr", "hol.com": "hol.gr", "windowslive.gr": "windowslive.com" };

/** Whether a domain takes mail (an MX, else an A record); cached per domain for a day. */
export function createDomainCheck(dns: LabDns, now: () => number = Date.now) {
  const cache = new Map<string, { receives: boolean; until: number }>();
  return async (domain: string): Promise<boolean> => {
    const cached = cache.get(domain);
    if (cached && cached.until > now()) return cached.receives;
    const mx = await dns.mx(domain);
    // A null MX ("." , RFC 7505) says the domain takes no mail.
    const receives = mx.length ? !mx.every((host) => host === "" || host === ".") : (await dns.a(domain)).length > 0;
    cache.set(domain, { receives, until: now() + 86_400_000 });
    return receives;
  };
}

/** The health a periodic check gives; what our own mail proved (bounced, complained, unsubscribed) is never undone by a DNS look. */
export async function checkContactHealth(contact: Pick<MailContact, "address" | "domain" | "health" | "softBounces" | "lastEngagedAt">, receives: (domain: string) => Promise<boolean>): Promise<{ health: MailHealth; reasons: string[] }> {
  if (contact.health === "BOUNCED" || contact.health === "COMPLAINED" || contact.health === "UNSUBSCRIBED") return { health: contact.health, reasons: [] };
  const local = contact.address.slice(0, contact.address.lastIndexOf("@"));
  if (NEVER_LOCAL.test(local)) return { health: "INVALID", reasons: [`${local}@ is not a mailbox that takes campaign mail`] };
  if (!(await receives(contact.domain))) return { health: "INVALID", reasons: [`${contact.domain} takes no mail (no MX or A record)`] };
  const reasons: string[] = [];
  if (DOMAIN_TYPOS[contact.domain]) reasons.push(`did you mean @${DOMAIN_TYPOS[contact.domain]}?`);
  if (DISPOSABLE_DOMAINS.has(contact.domain)) reasons.push("a throwaway mailbox provider");
  if (ROLE_LOCAL.test(local)) reasons.push("a shared role mailbox (fine for B2B, not for consent lists)");
  if (contact.softBounces >= 2) return { health: "INVALID", reasons: [`${contact.softBounces} delivery delays on our mail`] };
  if (contact.softBounces === 1) reasons.push("one delivery delay on our mail");
  if (reasons.length) return { health: "RISKY", reasons };
  return { health: "VALID", reasons: [contact.lastEngagedAt ? "replied to our mail" : "the domain takes mail and nothing bounced"] };
}
