// What came back from our campaign mail (plan clipboard:IJ2ovfLg1Lbw step 7), read from a raw RFC 5322 message found in a sender's
// mailbox: a delivery status notification (hard or soft bounce), an abuse/feedback report (complaint), or a reply (an opt-out such as
// «Όχι» / "unsubscribe" in its first lines, else engagement). Complaints and replies count only when they name a Message-ID the send log
// keeps (ours, `<mc.…@domain>`, or the one Gmail sent instead, 12/11); a bounce counts by its failed recipient too (operator 6/11: mail sent outside a campaign, or a DSN that does not quote
// our id, bounced again and again), and the service applies it only to an address that is already a contact. Pure: no network.

import { createHash } from "node:crypto";

export type CampaignSignal =
  | { kind: "HARD_BOUNCE" | "SOFT_BOUNCE"; messageIds: string[]; recipient: string | null; status: string; noticeId: string;
      /** The address we mailed when the failed one differs (a forward target's DSN, Punto Ingrosso 12/11). */
      originalRecipient?: string }
  | { kind: "COMPLAINT"; messageIds: string[]; recipient: string | null }
  | { kind: "UNSUBSCRIBE" | "REPLY"; messageIds: string[]; from: string | null };

const OUR_ID = /<mc\.[A-Za-z0-9_-]{6,80}\.[A-Za-z0-9_-]{6,80}\.[A-Za-z0-9_-]{6,40}@[a-z0-9.-]+>/g;
const ANY_ID = /<[^<>\s@]+@[^<>\s@]+>/g;
/** First lines of a reply that ask us to stop (Greek and English, accents folded). */
const OPT_OUT = /^(?:\s*(?:οχι|οχι ευχαριστω|οχι,? ευχαριστω|μη μου ξαναστειλετε|σταματηστε|διαγραφη|αφαιρεστε με|no|no thanks|no,? thank you|unsubscribe|remove me|stop|please remove me|take me off)[\s.!,]*)$/iu;
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function headerBlock(raw: string): string { const end = raw.search(/\r?\n\r?\n/); return end < 0 ? raw : raw.slice(0, end); }
function header(headers: string, name: string): string {
  const match = new RegExp(`^${name}:[ \\t]*((?:.*)(?:\\r?\\n[ \\t].*)*)`, "im").exec(headers);
  return match ? match[1]!.replace(/\r?\n[ \t]+/g, " ").trim() : "";
}
/** Every MIME part's decoded text with its content type (enough MIME for our purpose; nested multiparts are split too). */
function decodedParts(body: string, topType: string): Array<{ type: string; text: string }> {
  if (!/^multipart\//.test(topType)) return [{ type: topType || "text/plain", text: decode(body, "") }];
  return body.split(/\r?\n--[^\r\n]+\r?\n/).slice(1).map((part) => {
    const head = headerBlock(part);
    return { type: header(head, "Content-Type").toLowerCase(), text: decode(part.slice(head.length).replace(/^\r?\n\r?\n/, ""), head) };
  });
}
function decode(body: string, head: string): string {
  if (/content-transfer-encoding:\s*base64/i.test(head)) { try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; } }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) return body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return body;
}
const addressOf = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase() || null;

/**
 * A delivery status notification: its failed (else delayed) recipient block. Hard: a 5.x.x status, or `Action: failed` (a delay that ended
 * in a final failure, 4.x.x included); soft: a delay. Without our id it needs a named recipient, or it is no signal at all.
 * shortcut: one recipient per DSN (each campaign message has one); a DSN listing several takes its first failed one.
 */
function bounce(raw: string, text: string, headers: string, ids: string[], returned: string): CampaignSignal | null {
  const blocks = text.split(/\r?\n\s*\r?\n/).filter((block) => /^(?:Final|Original)-Recipient:/im.test(block)).map((block) => ({
    recipient: addressOf(/^Final-Recipient:\s*rfc822;\s*(.+)$/im.exec(block)?.[1] ?? /^Original-Recipient:\s*rfc822;\s*(.+)$/im.exec(block)?.[1] ?? ""),
    original: addressOf(/^Original-Recipient:\s*rfc822;\s*(.+)$/im.exec(block)?.[1] ?? ""),
    action: /^Action:\s*(\w+)/im.exec(block)?.[1]?.toLowerCase() ?? "",
    status: /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(block)?.[1] ?? ""
  }));
  const block = blocks.find((entry) => entry.action === "failed" || entry.status.startsWith("5")) ?? blocks.find((entry) => entry.action === "delayed" || entry.status.startsWith("4")) ?? blocks[0];
  const recipient = block?.recipient ?? addressOf(header(headers, "X-Failed-Recipients").split(",")[0] ?? "");
  // A forward target's DSN names the mailbox the mail was forwarded to; the DSN's Original-Recipient or the returned mail's one To is ours.
  const to = header(returned, "To");
  const originalRecipient = [block?.original, to.includes(",") ? null : addressOf(to)].find((address) => address && address !== recipient) ?? null;
  if (!ids.length && !recipient && !originalRecipient) return null;
  const status = block?.status || (/\b(5\.\d\.\d+)\b/.exec(text)?.[1] ?? (/\b(4\.\d\.\d+)\b/.exec(text)?.[1] ?? "5.0.0"));
  if (status.startsWith("2") || block?.action === "delivered" || block?.action === "relayed" || block?.action === "expanded") return null;
  const hard = status.startsWith("5") || block?.action === "failed";
  // The notice's own id (its Message-ID, else its bytes' hash): the same notice read again is the same delay.
  const noticeId = header(headers, "Message-ID") || `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return { kind: hard ? "HARD_BOUNCE" : "SOFT_BOUNCE", messageIds: ids, recipient, status, noticeId, ...(originalRecipient ? { originalRecipient } : {}) };
}

export function parseCampaignSignal(rawBytes: Buffer | string): CampaignSignal | null {
  const raw = typeof rawBytes === "string" ? rawBytes : rawBytes.toString("utf8");
  const headers = headerBlock(raw);
  const contentType = header(headers, "Content-Type").toLowerCase();
  const from = header(headers, "From");
  const parts = decodedParts(raw.slice(headers.length).replace(/^\r?\n\r?\n/, ""), contentType);
  const text = parts.map((part) => part.text).join("\n");
  // The original a DSN or feedback report returns (its headers come first).
  const returned = parts.find((part) => /^(?:message\/rfc822|text\/rfc822-headers)\b/.test(part.type))?.text ?? "";
  const named = `${header(headers, "In-Reply-To")} ${header(headers, "References")}`;
  // Ours anywhere, and any Message-ID a reply or the returned original names (Gmail sends its own instead of ours); the service matches them.
  const ids = [...new Set([...`${named} ${text}`.matchAll(OUR_ID), ...`${named} ${header(returned, "Message-ID")}`.matchAll(ANY_ID)].map((match) => match[0]))];
  const isDsn = /report-type="?delivery-status/.test(contentType) || /^(mailer-daemon|postmaster)@/i.test(addressOf(from) ?? "");
  const isComplaint = /report-type="?feedback-report/.test(contentType) || /^Feedback-Type:\s*abuse/im.test(text);
  if (isDsn && !isComplaint) return bounce(raw, text, headers, ids, returned);
  // A mailto List-Unsubscribe click: subject "unsubscribe", no reference to our mail; it can only take its own sender off.
  if (!ids.length) return /^unsubscribe$/i.test(header(headers, "Subject")) ? { kind: "UNSUBSCRIBE", messageIds: [], from: addressOf(from) } : null;
  const recipient = addressOf(/^(?:Final|Original)-Recipient:\s*rfc822;\s*(.+)$/im.exec(text)?.[1] ?? "") ;
  if (isComplaint) return { kind: "COMPLAINT", messageIds: ids, recipient };
  // A reply: only its own first lines count (quoted text below them is ours).
  const plain = parts.find((part) => part.type.startsWith("text/plain"))?.text ?? text;
  const own = plain.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(">")).slice(0, 3);
  const optOut = own.length > 0 && OPT_OUT.test(fold(own[0]!)) && own.join(" ").length < 120;
  return { kind: optOut ? "UNSUBSCRIBE" : "REPLY", messageIds: ids, from: addressOf(from) };
}
