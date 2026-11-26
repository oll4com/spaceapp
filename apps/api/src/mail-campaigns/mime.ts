import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mailAttachmentType, type MailTemplateAttachment } from "@space/contracts";

// Every campaign message (plan clipboard:IJ2ovfLg1Lbw step 5): text and HTML alternatives (base64, 76-column lines), the sender's real
// identity, a Message-ID on the sender's domain, one-click unsubscribe (RFC 8058 List-Unsubscribe-Post when an https endpoint exists,
// always a mailto), List-Id and Gmail's Feedback-ID, and a footer the server adds (identity, postal line, a visible opt-out).

export interface CampaignMessage {
  from: string; fromName: string; to: string; replyTo: string | null;
  subject: string; preheader: string; html: string; text: string; language: "el" | "en";
  campaignId: string; contactId: string; senderDomain: string; footerAddress: string;
  /** The campaign's list and sender ids, for List-Id and Feedback-ID (Google Postmaster groups complaints by them). */
  listId: string; senderId: string;
  /** https one-click link, or null when no public endpoint exists yet (mailto only). */
  unsubscribeUrl: string | null;
  /** A copy for the operator's own seed mailboxes: the subject says so. */
  test?: boolean;
  date?: Date;
  /** Files the template version carries (names already checked by the contract: ASCII, no quotes). */
  attachments?: MailTemplateAttachment[];
  /** A tracked campaign's open pixel for this recipient: after the footer, so the approved content and the unsubscribe link stay as they are. */
  openPixel?: string;
  /** This recipient's mail on the sender domain's relay ("view in browser"): a line above the content, outside what the operator approved, never wrapped. */
  webVersionUrl?: string | null;
}

const OPT_OUT: Record<"el" | "en", { line: string; link: string; reply: string; test: string; web: string }> = {
  el: { line: "Λαμβάνετε αυτό το μήνυμα από", link: "Διαγραφή από τη λίστα", reply: "ή απαντήστε «Όχι» και δεν θα σας ξαναστείλουμε.", test: "[ΔΟΚΙΜΗ] ", web: "Δείτε το στο browser" },
  en: { line: "You receive this message from", link: "Unsubscribe", reply: "or reply \"No\" and we will not write again.", test: "[TEST] ", web: "View in browser" }
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
export function htmlWithFooter(message: Pick<CampaignMessage, "language" | "preheader" | "unsubscribeUrl" | "from" | "fromName" | "footerAddress" | "html" | "text" | "openPixel" | "webVersionUrl">): string {
  const words = OPT_OUT[message.language];
  const web = message.webVersionUrl ? `<div style="text-align:center;padding:6px 0;font-size:12px;font-family:Arial,sans-serif"><a href="${escapeHtml(message.webVersionUrl)}" style="color:#666">${words.web}</a></div>` : "";
  const preheader = (message.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(message.preheader)}</div>` : "") + web;
  const optOut = message.unsubscribeUrl ? `<a href="${escapeHtml(message.unsubscribeUrl)}" style="color:#666">${words.link}</a>` : `<a href="${escapeHtml(mailtoUnsubscribe(message.from))}" style="color:#666">${words.link}</a>`;
  const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;color:#666;font-family:Arial,sans-serif">`
    + `${words.line} ${escapeHtml(message.fromName)} &lt;${escapeHtml(message.from)}&gt;. ${escapeHtml(message.footerAddress)}<br>${optOut} ${words.reply}</div>${message.openPixel ?? ""}`;
  const html = message.html.trim() ? message.html : textAsHtml(message.text);
  const bodyOpen = /<body[^>]*>/i.exec(html);
  const withPreheader = bodyOpen ? html.replace(bodyOpen[0], `${bodyOpen[0]}${preheader}`) : `${preheader}${html}`;
  return /<\/body>/i.test(withPreheader) ? withPreheader.replace(/<\/body>/i, `${footer}</body>`) : `${withPreheader}${footer}`;
}
export function textWithFooter(message: Pick<CampaignMessage, "language" | "unsubscribeUrl" | "from" | "fromName" | "footerAddress" | "text" | "webVersionUrl">): string {
  const words = OPT_OUT[message.language];
  return `${message.webVersionUrl ? `${words.web}: ${message.webVersionUrl}\n\n` : ""}${message.text.trimEnd()}\n\n--\n${words.line} ${message.fromName} <${message.from}>. ${message.footerAddress}\n${words.link}: ${message.unsubscribeUrl ?? mailtoUnsubscribe(message.from)} ${words.reply}\n`;
}

/** The complete message; `messageId` is what the send log keeps (DSNs and replies quote it). */
const idTail = (id: string) => id.slice(id.indexOf(":") + 1);

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
    `List-Id: <${idTail(message.listId)}.${message.senderDomain}>`,
    `Feedback-ID: ${idTail(message.campaignId)}:${idTail(message.listId)}:${message.senderDomain.split(".")[0]}:${idTail(message.senderId)}`,
    "MIME-Version: 1.0"
  ];
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(textWithFooter(message), "utf8").toString("base64")),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(htmlWithFooter(message), "utf8").toString("base64")),
    `--${boundary}--`, ""
  ];
  const files = message.attachments ?? [];
  // With files the alternatives become the first part of a multipart/mixed; without, the message is what it always was.
  const mixed = `mm-${unique}`;
  lines.push(...(files.length ? [
    `Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, ...alternative,
    ...files.flatMap((file) => [`--${mixed}`, `Content-Type: ${mailAttachmentType(file.filename)}; name="${file.filename}"`,
      `Content-Disposition: attachment; filename="${file.filename}"`, "Content-Transfer-Encoding: base64", "", wrap(file.contentBase64)]),
    `--${mixed}--`, ""
  ] : alternative));
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

/**
 * A tracked campaign mail's links (plan clipboard:2wiBJQwRzN8X step 5, operator 23/11 "which product was clicked"): every https <a href> of the approved
 * HTML goes through the relay, `links[n]` being the original the relay may redirect to: `<relay dir>c/<token>/<n>` on a site's own relay (`own`, plan
 * vxtgxdSGE586 step 5), `<relay>&c=<token>&n=<n>` on the shared one. `skip` (the web version link a template may carry) is left as it is; the footer
 * (unsubscribe) and the "view in browser" line are added after this, so they are never wrapped.
 */
export function trackLinks(html: string, relay: string, token: string, own = false, skip: string | null = null): { html: string; links: string[] } {
  const links: string[] = [];
  const wrapped = html.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])(https:\/\/[^"']+)\2/gi, (whole: string, start: string, quote: string, url: string) => {
    const original = url.replace(/&amp;/g, "&");
    if (original === skip) return whole;
    const n = links.push(original) - 1;
    return `${start}${quote}${own ? sitePath(relay, "c", token, n) : `${relay}&amp;c=${token}&amp;n=${n}`}${quote}`;
  });
  return { html: wrapped, links };
}
/** A link on a site's own relay (plan vxtgxdSGE586 steps 4-5): `<relay dir><kind>/<token>[/<n>]`, `?i=dev` only off stable (the site's default instance). */
export function sitePath(relay: string, kind: "v" | "c", token: string, n?: number): string {
  const url = new URL(relay);
  return `${url.origin}${url.pathname}${kind}/${token}${n === undefined ? "" : `/${n}`}${url.searchParams.get("i") === "dev" ? "?i=dev" : ""}`;
}
/** The 1x1 pixel of one tracked mail on the relay. */
export const openPixel = (relay: string, token: string) =>
  `<img src="${relay}&o=${token}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />`;
/** A campaign recipient's open-tracking token (open-tracking.ts): secret-keyed, so it cannot be guessed, and the same on a retry of the same send (one tracked mail per send). */
export const campaignOpenToken = (key: Buffer, campaignId: string, contactId: string) =>
  createHmac("sha256", key).update(`open:${campaignId}:${contactId}`).digest().subarray(0, 24).toString("base64url");
