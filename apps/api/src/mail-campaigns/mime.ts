import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Every campaign message (plan clipboard:IJ2ovfLg1Lbw step 5): text and HTML alternatives (base64, 76-column lines), the sender's real
// identity, a Message-ID on the sender's domain, one-click unsubscribe (RFC 8058 List-Unsubscribe-Post when an https endpoint exists,
// always a mailto), List-Id and Gmail's Feedback-ID, and a footer the server adds (identity, postal line, a visible opt-out).

export interface CampaignMessage {
  from: string; fromName: string; to: string; replyTo: string | null;
  subject: string; preheader: string; html: string; text: string; language: "el" | "en";
  campaignId: string; contactId: string; senderDomain: string; footerAddress: string;
  /** https one-click link, or null when no public endpoint exists yet (mailto only). */
  unsubscribeUrl: string | null;
  /** A copy for the operator's own seed mailboxes: the subject says so. */
  test?: boolean;
  date?: Date;
}

const OPT_OUT: Record<"el" | "en", { line: string; link: string; reply: string; test: string }> = {
  el: { line: "Λαμβάνετε αυτό το μήνυμα από", link: "Διαγραφή από τη λίστα", reply: "ή απαντήστε «Όχι» και δεν θα σας ξαναστείλουμε.", test: "[ΔΟΚΙΜΗ] " },
  en: { line: "You receive this message from", link: "Unsubscribe", reply: "or reply \"No\" and we will not write again.", test: "[TEST] " }
};

function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}
function mailbox(name: string, address: string): string {
  const clean = name.replace(/[\r\n"\\]+/g, " ").trim();
  return clean ? `${/^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : encodeHeader(clean)} <${address}>` : address;
}
const wrap = (base64: string) => base64.replace(/.{1,76}/g, "$&\r\n");
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The mailto unsubscribe of a sender (replies with this subject are read as opt-outs). */
export const mailtoUnsubscribe = (from: string) => `mailto:${from}?subject=unsubscribe`;

/** A plain-text mail's HTML part: the same words, escaped, line for line (links stay text; clients link them). */
export const textAsHtml = (text: string) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;

/** The HTML with a hidden preheader first and the server's footer last (inside <body> when there is one). */
export function htmlWithFooter(message: Pick<CampaignMessage, "language" | "preheader" | "unsubscribeUrl" | "from" | "fromName" | "footerAddress" | "html" | "text">): string {
  const words = OPT_OUT[message.language];
  const preheader = message.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(message.preheader)}</div>` : "";
  const optOut = message.unsubscribeUrl ? `<a href="${escapeHtml(message.unsubscribeUrl)}" style="color:#666">${words.link}</a>` : `<a href="${escapeHtml(mailtoUnsubscribe(message.from))}" style="color:#666">${words.link}</a>`;
  const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;color:#666;font-family:Arial,sans-serif">`
    + `${words.line} ${escapeHtml(message.fromName)} &lt;${escapeHtml(message.from)}&gt;. ${escapeHtml(message.footerAddress)}<br>${optOut} ${words.reply}</div>`;
  const html = message.html.trim() ? message.html : textAsHtml(message.text);
  const bodyOpen = /<body[^>]*>/i.exec(html);
  const withPreheader = bodyOpen ? html.replace(bodyOpen[0], `${bodyOpen[0]}${preheader}`) : `${preheader}${html}`;
  return /<\/body>/i.test(withPreheader) ? withPreheader.replace(/<\/body>/i, `${footer}</body>`) : `${withPreheader}${footer}`;
}
export function textWithFooter(message: Pick<CampaignMessage, "language" | "unsubscribeUrl" | "from" | "fromName" | "footerAddress" | "text">): string {
  const words = OPT_OUT[message.language];
  return `${message.text.trimEnd()}\n\n--\n${words.line} ${message.fromName} <${message.from}>. ${message.footerAddress}\n${words.link}: ${message.unsubscribeUrl ?? mailtoUnsubscribe(message.from)} ${words.reply}\n`;
}

/** The complete message; `messageId` is what the send log keeps (DSNs and replies quote it). */
export function buildCampaignMime(message: CampaignMessage): { raw: Buffer; messageId: string } {
  const unique = randomBytes(9).toString("base64url");
  const messageId = `<mc.${message.campaignId.slice(6)}.${message.contactId.slice(9)}.${unique}@${message.senderDomain}>`;
  const boundary = `mc-${unique}`;
  const words = OPT_OUT[message.language];
  const subject = `${message.test ? words.test : ""}${message.subject}`;
  const unsubscribe = [message.unsubscribeUrl ? `<${message.unsubscribeUrl}>` : null, `<${mailtoUnsubscribe(message.from)}>`].filter(Boolean).join(", ");
  const lines = [
    `From: ${mailbox(message.fromName, message.from)}`, `To: ${message.to}`, ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`, `Date: ${(message.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`, `Message-ID: ${messageId}`,
    `List-Unsubscribe: ${unsubscribe}`, ...(message.unsubscribeUrl ? ["List-Unsubscribe-Post: List-Unsubscribe=One-Click"] : []),
    `List-Id: ${encodeHeader(message.campaignId)} <${message.campaignId.replace(":", ".")}.${message.senderDomain}>`,
    `Feedback-ID: ${message.campaignId.slice(6)}:${message.senderDomain}:mailcampaigns`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(textWithFooter(message), "utf8").toString("base64")),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(htmlWithFooter(message), "utf8").toString("base64")),
    `--${boundary}--`, ""
  ];
  return { raw: Buffer.from(lines.join("\r\n"), "utf8"), messageId };
}

// ---- one-click unsubscribe tokens ---------------------------------------------------------------------
// `<campaign>.<contact>.<mac>`: base64url ids and 16 bytes of HMAC-SHA256 under a key derived from the connector key, which never rotates
// lightly (it seals every connector token), so links stay valid for good. A forged or changed token does nothing.

export function unsubscribeToken(key: Buffer, campaignId: string, contactId: string): string {
  const body = `${Buffer.from(campaignId).toString("base64url")}.${Buffer.from(contactId).toString("base64url")}`;
  return `${body}.${createHmac("sha256", key).update(body).digest().subarray(0, 16).toString("base64url")}`;
}
export function readUnsubscribeToken(key: Buffer, token: string): { campaignId: string; contactId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]{1,200}$/.test(part))) return null;
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest().subarray(0, 16);
  const given = Buffer.from(parts[2]!, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const campaignId = Buffer.from(parts[0]!, "base64url").toString();
  const contactId = Buffer.from(parts[1]!, "base64url").toString();
  return /^mcamp:[A-Za-z0-9_-]{6,80}$/.test(campaignId) && /^mcontact:[A-Za-z0-9_-]{6,80}$/.test(contactId) ? { campaignId, contactId } : null;
}
