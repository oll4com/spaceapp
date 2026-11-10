import { Resolver } from "node:dns/promises";
import type { MailCheckStatus, MailSender, MailTemplateContent } from "@space/contracts";
import { mailSite } from "./site.js";

// The deliverability lab (plan clipboard:IJ2ovfLg1Lbw step 6), the server's own checks: DNS authentication of the sender's domain for its
// route, blocklists of the sending address and link domains, and the content of the template version. Each check answers a status, a
// score (0-100) and concrete fixes. Reputation, not evasion: nothing here suggests hiding content or rotating senders.

export interface LabCheck { kind: "DNS" | "DNSBL" | "LINT"; status: MailCheckStatus; score: number; details: { findings: string[]; fixes: string[]; [key: string]: unknown } }
export interface LabDns {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  ptr(ip: string): Promise<string[]>;
}
/** Each route's DKIM selector on the sender's domain and what SPF must allow (SMTP: the egress address, or a and mx). */
const ROUTE_AUTH: Record<MailSender["config"]["route"], { selector: string; spf: (record: string, ip: string) => boolean; what: (ip: string) => string }> = {
  GMAIL_DELEGATED: { selector: "google", spf: (record) => /include:_spf\.google\.com/.test(record), what: () => "include:_spf.google.com" },
  GMAIL_CONNECTOR: { selector: "google", spf: (record) => /include:_spf\.google\.com/.test(record), what: () => "include:_spf.google.com" },
  SMTP: { selector: "default", spf: (record, ip) => (ip !== "" && record.includes(`ip4:${ip}`)) || /\s[+]?(a|mx)(\s|$)/.test(record), what: (ip) => ip ? `ip4:${ip}` : "a mx" }
};

export function systemDns(timeoutMs = 5_000): LabDns {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
  const quiet = async <T>(lookup: () => Promise<T[]>) => lookup().catch(() => [] as T[]);
  return {
    txt: async (name) => (await quiet(() => resolver.resolveTxt(name))).map((chunks) => chunks.join("")),
    mx: async (name) => (await quiet(() => resolver.resolveMx(name))).map((record) => record.exchange.toLowerCase()),
    a: (name) => quiet(() => resolver.resolve4(name)),
    ptr: (ip) => quiet(() => resolver.reverse(ip))
  };
}

const score = (findings: number, fails: number) => Math.max(0, 100 - fails * 40 - findings * 10);
const status = (fails: number, warns: number): MailCheckStatus => fails ? "FAIL" : warns ? "WARN" : "PASS";

/** SPF, DKIM, DMARC and alignment for the route, MX of the From domain, and the egress PTR for SMTP. */
export async function dnsCheck(dns: LabDns, sender: Pick<MailSender, "domain" | "config">, egressIp = mailSite().egressIp): Promise<LabCheck> {
  const auth = ROUTE_AUTH[sender.config.route];
  const what = auth.what(egressIp);
  const findings: string[] = []; const fixes: string[] = []; let fails = 0; let warns = 0;
  const spf = (await dns.txt(sender.domain)).filter((record) => /^v=spf1\b/i.test(record));
  if (spf.length !== 1) { fails++; findings.push(spf.length ? "more than one SPF record" : "no SPF record"); fixes.push(`publish one TXT "v=spf1 ... ${what} ~all" on ${sender.domain}`); }
  else if (!auth.spf(spf[0]!, egressIp)) { fails++; findings.push(`SPF does not allow this route (${what})`); fixes.push(`add ${what} to the SPF record of ${sender.domain}`); }
  else if (/\+all/.test(spf[0]!)) { fails++; findings.push("SPF ends in +all (anyone may send)"); fixes.push("end the SPF record with ~all or -all"); }
  const selector = sender.config.route === "SMTP" && sender.config.dkim ? sender.config.dkim.selector : auth.selector;
  const dkim = (await dns.txt(`${selector}._domainkey.${sender.domain}`)).find((record) => /(^|;)\s*p=[A-Za-z0-9+/]/.test(record));
  if (!dkim) { fails++; findings.push(`no DKIM key at ${selector}._domainkey.${sender.domain}`); fixes.push(`publish the route's DKIM key (selector ${selector}) for ${sender.domain}`); }
  const dmarc = (await dns.txt(`_dmarc.${sender.domain}`)).find((record) => /^v=DMARC1/i.test(record));
  if (!dmarc) { fails++; findings.push("no DMARC record"); fixes.push(`publish _dmarc.${sender.domain} TXT "v=DMARC1; p=none; rua=mailto:..." and tighten later`); }
  else {
    if (!/rua=/i.test(dmarc)) { warns++; findings.push("DMARC has no rua (no reports)"); fixes.push(`add rua=mailto:<a mailbox we read> to _dmarc.${sender.domain} to see who sends as the domain`); }
    if (/p=none/i.test(dmarc)) { warns++; findings.push("DMARC p=none"); fixes.push("move DMARC to p=quarantine once the reports are clean"); }
  }
  if (!(await dns.mx(sender.domain)).length) { fails++; findings.push(`${sender.domain} has no MX (replies and bounces have nowhere to go)`); fixes.push(`publish an MX for ${sender.domain}`); }
  if (sender.config.route === "SMTP" && !egressIp) { fails++; findings.push("no egress address is set, so its reverse name is unchecked"); fixes.push("set SPACE_MAIL_EGRESS_IP to the public address SMTP mail leaves from"); }
  else if (sender.config.route === "SMTP") {
    const names = await dns.ptr(egressIp);
    const forward = names.length ? await dns.a(names[0]!) : [];
    if (!names.length || !forward.includes(egressIp)) { fails++; findings.push(`${egressIp} has no forward-confirmed reverse name`); fixes.push(`set the PTR of ${egressIp} to the HELO name with a matching A record`); }
  }
  return { kind: "DNS", status: status(fails, warns), score: score(warns, fails), details: { findings, fixes, domain: sender.domain, route: sender.config.route, selector } };
}

const IP_LISTS = ["zen.spamhaus.org", "b.barracudacentral.org", "bl.spamcop.net"];
const DOMAIN_LISTS = ["dbl.spamhaus.org", "multi.surbl.org"];
/** Blocklists of the sending address (SMTP route) and of the sender's and links' domains. Spamhaus refuses public resolvers (127.255.255.x): UNKNOWN. */
export async function dnsblCheck(dns: LabDns, sender: Pick<MailSender, "domain" | "config">, linkDomains: string[], egressIp = mailSite().egressIp): Promise<LabCheck> {
  const findings: string[] = []; const fixes: string[] = []; const unknown: string[] = []; let fails = 0;
  const listed = async (name: string, list: string) => {
    const answers = await dns.a(`${name}.${list}`);
    if (answers.some((answer) => answer.startsWith("127.255.255."))) { unknown.push(list); return false; }
    return answers.some((answer) => answer.startsWith("127."));
  };
  // Without an egress address (unset SPACE_MAIL_EGRESS_IP) the DNS check already fails the SMTP route.
  if (sender.config.route === "SMTP" && egressIp) {
    const reversed = egressIp.split(".").reverse().join(".");
    for (const list of IP_LISTS) if (await listed(reversed, list)) { fails++; findings.push(`${egressIp} is listed on ${list}`); fixes.push(`request delisting of ${egressIp} at ${list} and find what sent spam from it`); }
  }
  for (const domain of [...new Set([sender.domain, ...linkDomains])].slice(0, 10)) {
    for (const list of DOMAIN_LISTS) if (await listed(domain, list)) { fails++; findings.push(`${domain} is listed on ${list}`); fixes.push(`remove links to ${domain} or get it delisted at ${list}`); }
  }
  if (unknown.length) findings.push(`not answered (needs a registered resolver): ${[...new Set(unknown)].join(", ")}`);
  return { kind: "DNSBL", status: fails ? "FAIL" : "PASS", score: fails ? 0 : 100, details: { findings, fixes, unknown: [...new Set(unknown)] } };
}

const SHORTENERS = /^(bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc)$/i;
// Word edges by letters, not \b (which knows only ASCII), on accent-folded text so «ΔΩΡΕΑΝ» and «δωρεάν» both match.
const SPAM_WORDS = /(?<!\p{L})(free|δωρεαν|act now|click here|πατηστε εδω|winner|κερδισατε|guarantee|εγγυημενο|risk[- ]free|no obligation|cash|μετρητα|urgent|επειγον|limited time|viagra|crypto|bitcoin)(?!\p{L})/iu;
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "");
/** The domains every https link points at (in HTML links or plain text). */
export function linkDomains(content: string): string[] {
  return [...new Set([...content.matchAll(/https:\/\/([^/"'?#:\s<>]+)/gi)].map((match) => match[1]!.toLowerCase().replace(/[.,;)]+$/, "")))];
}
/** The template version's content: plain text, size (Gmail clips at 102 KB), images against text, link domains, hidden text, the subject. */
export function lintCheck(content: Pick<MailTemplateContent, "subject" | "preheader" | "html" | "text">, senderDomain: string): LabCheck {
  const findings: string[] = []; const fixes: string[] = []; let fails = 0; let warns = 0;
  const htmlBytes = Buffer.byteLength(content.html, "utf8");
  if (htmlBytes > 90_000) { fails++; findings.push(`HTML is ${Math.round(htmlBytes / 1024)} KB`); fixes.push("cut the HTML under 90 KB (Gmail clips at 102 KB and hides the unsubscribe line)"); }
  const visible = content.html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const images = (content.html.match(/<img\b/gi) ?? []).length;
  if (images && visible.length < 200) { warns++; findings.push(`${images} image(s) with only ${visible.length} characters of text`); fixes.push("write the offer in real text; images alone read as spam and show nothing when images are off"); }
  if (content.text.trim().length < Math.min(200, visible.length / 3)) { warns++; findings.push("the plain-text part is much shorter than the HTML"); fixes.push("make the plain-text part say what the HTML says"); }
  if (/<img\b(?![^>]*\balt=)/i.test(content.html)) { warns++; findings.push("images without alt text"); fixes.push("give every image an alt text"); }
  const domains = linkDomains(`${content.html}\n${content.text}`);
  const short = domains.filter((domain) => SHORTENERS.test(domain));
  if (short.length) { fails++; findings.push(`link shorteners: ${short.join(", ")}`); fixes.push("link to the real page on our own domain"); }
  const foreign = domains.filter((domain) => !domain.endsWith(senderDomain) && !SHORTENERS.test(domain));
  if (foreign.length > 3) { warns++; findings.push(`links to ${foreign.length} other domains`); fixes.push("keep links on the brand's own domain"); }
  if (/(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px)?\b)/i.test(content.html)) { fails++; findings.push("hidden text in the template"); fixes.push("remove hidden text (the server adds the preheader itself)"); }
  if (content.subject.length > 78) { warns++; findings.push(`the subject is ${content.subject.length} characters`); fixes.push("keep the subject under about 60 characters"); }
  const letters = content.subject.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 8 && letters === letters.toUpperCase()) { warns++; findings.push("the subject is in capitals"); fixes.push("write the subject in sentence case"); }
  if (/[!?]{2,}|€€|\$\$/.test(content.subject)) { warns++; findings.push("repeated punctuation or currency signs in the subject"); fixes.push("one exclamation mark at most, no repeated symbols"); }
  const trigger = SPAM_WORDS.exec(fold(`${content.subject} ${visible}`));
  if (trigger) { warns++; findings.push(`spam-trigger wording ("${trigger[0]}")`); fixes.push("say the offer plainly without trigger words"); }
  if (!content.preheader) { warns++; findings.push("no preheader"); fixes.push("add a preheader: the line inboxes show after the subject"); }
  return { kind: "LINT", status: status(fails, warns), score: score(warns, fails), details: { findings, fixes, htmlBytes, images, linkDomains: domains } };
}
