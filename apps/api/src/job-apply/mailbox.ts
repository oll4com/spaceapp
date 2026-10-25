import { promises as dns } from "node:dns";
import type { JobApplyMailboxConfig } from "@space/contracts";

// The agent never sees the mailbox credential: the API opens IMAP, reads the few
// recent messages that match, and hands back codes, links or short snippets.
export interface MailboxMessageSummary {
  /** IMAP message UID. */
  uid?: number;
  /** Gmail message id, readable in full with the copilot's mail read tool. */
  messageId?: string;
  from: string;
  subject: string;
  receivedAt: string | null;
  snippet: string;
}
export interface MailboxSearchFilter {
  fromContains?: string | null;
  subjectContains?: string | null;
  since?: string | null;
}
export interface MailboxReader {
  recent(filter: MailboxSearchFilter & { limit: number }): Promise<MailboxMessageSummary[]>;
  /** Decoded plain text of the matching messages, newest first (bounded). */
  texts(filter: MailboxSearchFilter & { limit: number }): Promise<Array<MailboxMessageSummary & { text: string }>>;
  close(): Promise<void>;
}
export interface MailboxFactory {
  open(config: JobApplyMailboxConfig, password: string): Promise<MailboxReader>;
}

const softBreak = /=\r?\n/g;
const qpByte = /=([0-9A-Fa-f]{2})/g;

/** Quoted-printable decoding for the whole source; harmless on 7bit/8bit parts. */
export function decodeQuotedPrintable(text: string): string {
  return text.replace(softBreak, "").replace(qpByte, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Base64 bodies (common for HTML parts) are decoded when a part declares that transfer encoding. */
export function decodeBase64Parts(source: string): string {
  return source.replace(/Content-Transfer-Encoding:\s*base64[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]{40,})/gi, (match, body: string) => {
    try {
      const decoded = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
      return decoded.includes("�") ? match : `\n${decoded}\n`;
    } catch {
      return match;
    }
  });
}

export function sourceToText(source: string): string {
  const decoded = decodeQuotedPrintable(decodeBase64Parts(source));
  return decoded
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function extractCode(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match ? (match[1] ?? match[0]) : null;
}

/** Links in already-decoded text; `extractLinks` decodes a raw message source first. */
export function extractLinksFromText(decoded: string, urlContains?: string | null): string[] {
  const links = new Set<string>();
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const url = match[0].replace(/[.,;]+$/, "");
    if (!urlContains || url.toLowerCase().includes(urlContains.toLowerCase())) links.add(url);
  }
  return [...links];
}

export function extractLinks(source: string, urlContains?: string | null): string[] {
  return extractLinksFromText(decodeQuotedPrintable(decodeBase64Parts(source)), urlContains);
}

export function matches(summary: { from: string; subject: string }, filter: MailboxSearchFilter): boolean {
  if (filter.fromContains && !summary.from.toLowerCase().includes(filter.fromContains.toLowerCase())) return false;
  if (filter.subjectContains && !summary.subject.toLowerCase().includes(filter.subjectContains.toLowerCase())) return false;
  return true;
}

/** Gmail's IMAP host resolves to IPv6 first on this host and then times out; connect by A record with SNI. */
async function resolveImapHost(host: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  try {
    const [address] = await dns.resolve4(host);
    return address ?? host;
  } catch {
    return host;
  }
}

export function createImapMailboxFactory(options: { connectTimeoutMs?: number } = {}): MailboxFactory {
  return {
    async open(config, password) {
      const { ImapFlow } = await import("imapflow");
      const client = new ImapFlow({
        host: await resolveImapHost(config.host),
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: password },
        tls: { servername: config.host },
        logger: false,
        connectionTimeout: options.connectTimeoutMs ?? 20_000,
        greetingTimeout: options.connectTimeoutMs ?? 20_000,
        socketTimeout: 60_000
      });
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      const scan = async <T>(filter: MailboxSearchFilter & { limit: number }, withSource: boolean,
        map: (summary: MailboxMessageSummary, source: string) => T): Promise<T[]> => {
        const mailbox = client.mailbox;
        const exists = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
        if (!exists) return [];
        // Newest 80 messages are enough for verification codes; `since` narrows further.
        const since = filter.since ? new Date(filter.since) : null;
        const results: Array<{ sortKey: number; value: T }> = [];
        for await (const message of client.fetch(`${Math.max(1, exists - 79)}:*`, { uid: true, envelope: true, internalDate: true, source: withSource })) {
          const envelope = message.envelope;
          const receivedAt = message.internalDate instanceof Date ? message.internalDate.toISOString() : null;
          if (since && receivedAt && new Date(receivedAt) < since) continue;
          const summary: MailboxMessageSummary = {
            uid: message.uid,
            from: envelope?.from?.[0]?.address ?? "",
            subject: envelope?.subject ?? "",
            receivedAt,
            snippet: ""
          };
          if (!matches(summary, filter)) continue;
          const source = withSource && message.source ? message.source.toString("utf8") : "";
          results.push({ sortKey: message.uid, value: map(summary, source) });
        }
        return results.sort((left, right) => right.sortKey - left.sortKey).slice(0, filter.limit).map((entry) => entry.value);
      };
      return {
        recent: (filter) => scan(filter, true, (summary, source) => ({ ...summary, snippet: sourceToText(source).slice(0, 300) })),
        texts: (filter) => scan(filter, true, (summary, source) => ({ ...summary, snippet: sourceToText(source).slice(0, 300), text: `${sourceToText(source)}\n${extractLinks(source).join("\n")}` })),
        async close() {
          lock.release();
          await client.logout().catch(() => undefined);
        }
      };
    }
  };
}
