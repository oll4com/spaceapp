import type { MailThread, MailThreadsPage, MailThreadsQuery } from "@space/contracts";

/**
 * R10-17 (lesson 28/10 19:31 BKK third-party-silence: the Shopflix card 7de64329 said «δεν έχει γράψει τίποτα» while two threads from
 * other Shopflix senders held their answers): every EXTERNAL decision to recipients or a mail thread carries, written by the server,
 * one line per recipient domain with the mail of the last 14 days in the connected Gmail accounts (read only).
 */
// R13-12 (29/10 6dffcd55: 3 days of mail searched, no mailbox named): 30 days, one line per connected account.
export const NOUS_MAIL_CONTEXT_DAYS = 30;
const CACHE_MS = 2 * 60_000;

export interface NousMailContextDeps {
  threads(owner: string, query: MailThreadsQuery): Promise<MailThreadsPage>;
  thread?(owner: string, account: string, threadId: string): Promise<MailThread>;
  /** The owner's connected Google accounts: their addresses and domains are never a third party. */
  accounts?(owner: string): Promise<string[]>;
  now?: () => number;
}

// Operator 30/10 08:44 BKK («Γιατί αναφέρει όλα αυτά τα εμαιλ σε κάθε decisions;»): nearly every thread matches a mail provider's domain
// (and Google's own notices), so such a domain line names no third party; a recipient there is searched by its full address.
const MAIL_PROVIDERS = ["gmail.com", "googlemail.com", "google.com", "outlook.com", "hotmail.com", "hotmail.gr", "live.com", "msn.com", "yahoo.com", "yahoo.gr",
  "icloud.com", "me.com", "proton.me", "protonmail.com"];
const domainOf = (address: string) => address.split("@").pop()!.trim().toLowerCase();
const within = (domain: string, parents: Iterable<string>) => [...parents].some((parent) => domain === parent || domain.endsWith(`.${parent}`));

/**
 * What to search for addresses and hosts, lower case, in order: a third party's domain, or the full address of one on a mail provider;
 * never the owner's own addresses, their domains (and subdomains) or a mail provider's host.
 */
function mailTargets(entries: string[], own: string[] = []): string[] {
  const mine = new Set(own.map((address) => address.trim().toLowerCase()));
  const myDomains = [...mine].map(domainOf).filter((domain) => !within(domain, MAIL_PROVIDERS));
  return [...new Set(entries.map((entry) => entry.trim().toLowerCase()).flatMap((entry) => {
    const domain = domainOf(entry);
    if (!domain.includes(".") || mine.has(entry) || within(domain, myDomains)) return [];
    return !within(domain, MAIL_PROVIDERS) ? [domain] : entry.includes("@") ? [entry] : [];
  }))];
}

/** Card lines: per connected account "Mail from <domain>" (or "Mail with <address>") "in 30 days: <account>: N threads, newest <date> "<subject>"", else "none" or "unknown". */
export function mailContextLines(target: string, page: MailThreadsPage | null): string[] {
  const head = `Mail ${target.includes("@") ? "with" : "from"} ${target} in ${NOUS_MAIL_CONTEXT_DAYS} days:`;
  if (!page || (!page.threads.length && page.errors.length)) return [`${head} unknown (the mail read failed)`];
  if (!page.threads.length) return [`${head} none`];
  const accounts = new Map<string, typeof page.threads>();
  for (const thread of page.threads) accounts.set(thread.account, [...accounts.get(thread.account) ?? [], thread]);
  return [...accounts].map(([account, threads]) => {
    const count = `${threads.length}${page.nextPageToken ? "+" : ""}`;
    return `${head} ${account}: ${count} thread${threads.length === 1 && !page.nextPageToken ? "" : "s"}, newest ${threads[0]!.receivedAt?.slice(0, 10) ?? "undated"} "${threads[0]!.subject.replace(/\s+/g, " ").trim().slice(0, 80)}"`;
  });
}

export function createNousMailContext(deps: NousMailContextDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; lines: string[] }>();
  async function cached(key: string, load: () => Promise<string[]>): Promise<string[]> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.lines;
    const lines = await load();
    cache.set(key, { at: now(), lines });
    return lines;
  }
  const targetLines = (owner: string, target: string) => cached(`${owner}\n${target}`, async () => mailContextLines(target,
    await deps.threads(owner, { account: "all", labelId: "ALL", q: `from:${target} OR to:${target} newer_than:${NOUS_MAIL_CONTEXT_DAYS}d`, max: 50 }).catch(() => null)));
  return {
    /**
     * The lines for a decision's recipients and mail thread (its other participants), and (R13-12) the sites its texts name,
     * those only when they hold mail; [] when it names none.
     */
    async lines(owner: string, refs: { recipients?: string[]; mailThread?: { account: string; threadId: string } }, named: string[] = []): Promise<string[]> {
      const addresses = [...(refs.recipients ?? [])];
      if (refs.mailThread && deps.thread) {
        const thread = await deps.thread(owner, refs.mailThread.account, refs.mailThread.threadId).catch(() => null);
        for (const message of thread?.messages ?? []) addresses.push(...[message.from, ...message.to].map((who) => who.address).filter(Boolean));
      }
      const accounts = deps.accounts ? await cached(`${owner}\n@accounts`, () => deps.accounts!(owner).catch(() => [])) : [];
      const own = [...(refs.mailThread ? [refs.mailThread.account] : []), ...accounts];
      const targets = mailTargets(addresses, own);
      const extra = mailTargets(named, own).filter((target) => !targets.includes(target));
      const picked = [...targets.map((target) => ({ target, quiet: false })), ...extra.map((target) => ({ target, quiet: true }))];
      return (await Promise.all(picked.map(async ({ target, quiet }) => (await targetLines(owner, target)).filter((line) => !quiet || !/: (?:none|unknown \(the mail read failed\))$/.test(line))))).flat();
    },
    /**
     * Plan clipboard:1NF6u6gcCwtj step 23: whether the connected mailboxes hold mail with a site's domain in 30 days; null when that cannot be
     * told (the owner's own or a mail provider's domain, or the read failed).
     */
    async site(owner: string, site: string): Promise<boolean | null> {
      const accounts = deps.accounts ? await cached(`${owner}\n@accounts`, () => deps.accounts!(owner).catch(() => [])) : [];
      const [target] = mailTargets([site], accounts);
      if (!target || target.includes("@")) return null;
      const lines = await targetLines(owner, target);
      return lines.some((line) => line.endsWith(" unknown (the mail read failed)")) ? null : !lines.some((line) => line.endsWith(" none"));
    }
  };
}
export type NousMailContext = ReturnType<typeof createNousMailContext>;
