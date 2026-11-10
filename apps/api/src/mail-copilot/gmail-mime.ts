import type { MailAttachment, MailParticipant } from "@space/contracts";
import { decodeHtmlEntities, htmlToText, looksLikeHtml } from "../mail-html-text.js";

// Gmail's `format=full` payload (parts already base64url, charset handled by Gmail) in and an RFC 2822
// message out. Nothing here touches the network.

export function header(headers: unknown, name: string): string {
  const found = Array.isArray(headers) ? headers.find((item: { name?: string }) => item?.name?.toLowerCase() === name.toLowerCase()) as { value?: string } | undefined : undefined;
  return found?.value ?? "";
}

/** `Name <address>, other@example.com` becomes participants; display names lose their quotes. */
export function parseParticipants(value: string): MailParticipant[] {
  const out: MailParticipant[] = [];
  for (const raw of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(part);
    if (match) out.push({ name: decodeHtmlEntities(match[1]?.trim() ?? ""), address: match[2]!.trim().toLowerCase() });
    else out.push({ name: "", address: part.replace(/^<|>$/g, "").trim().toLowerCase() });
  }
  return out;
}

export interface ParsedBody { text: string; html: string | null; attachments: MailAttachment[] }

/** Text, HTML and attachment list of a message payload; inline parts keep their Content-ID for `cid:` images. */
export function parsePayload(payload: Record<string, unknown> | undefined): ParsedBody {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: MailAttachment[] = [];
  const walk = (part: Record<string, unknown> | undefined) => {
    if (!part) return;
    const body = (part.body ?? {}) as { data?: string; attachmentId?: string; size?: number };
    const mimeType = String(part.mimeType ?? "");
    const filename = typeof part.filename === "string" ? part.filename : "";
    if (body.attachmentId && (filename || !mimeType.startsWith("text/"))) {
      const contentId = header(part.headers, "Content-ID").replace(/^<|>$/g, "");
      attachments.push({ attachmentId: body.attachmentId, filename: filename || (contentId ? `${contentId}` : "attachment"), mimeType: mimeType || "application/octet-stream",
        size: Number(body.size) || 0, contentId: contentId || null });
    } else if (body.data && mimeType === "text/plain") plain.push(Buffer.from(body.data, "base64url").toString("utf8"));
    else if (body.data && mimeType === "text/html") html.push(Buffer.from(body.data, "base64url").toString("utf8"));
    for (const child of (part.parts as Record<string, unknown>[] | undefined) ?? []) walk(child);
  };
  walk(payload);
  const joinedHtml = html.length ? html.join("\n") : null;
  const plainText = plain.join("\n");
  const text = plain.some((part) => part.trim()) || !joinedHtml ? (looksLikeHtml(plainText) ? htmlToText(plainText) : plainText) : htmlToText(joinedHtml);
  return { text, html: joinedHtml, attachments };
}

function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}
function addresses(list: readonly string[]): string {
  return list.map((address) => address.replace(/[\r\n,]+/g, " ").trim()).filter(Boolean).join(", ");
}
function mailbox(name: string | undefined, address: string): string {
  const clean = (name ?? "").replace(/[\r\n"\\]+/g, " ").trim();
  return clean ? `${/^[\x20-\x7e]*$/.test(clean) ? `"${clean}"` : encodeHeader(clean)} <${addresses([address])}>` : addresses([address]);
}
/** Plain text as minimal HTML, so clients that prefer HTML show the same message. */
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="white-space:pre-wrap;font-family:inherit">${escaped.replace(/\r?\n/g, "<br>")}</div>`;
}

/** A file part of an outgoing message (a review's attachments, copied from the Gmail message that held them). */
export interface MimeAttachment { filename: string; mimeType: string; data: Buffer }
const base64Lines = (data: Buffer) => data.toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");

/**
 * An RFC 2822 message (base64url for Gmail): text and HTML alternatives, Cc/Bcc, and the threading headers of a
 * reply (`In-Reply-To`, `References`) when the replied message is known; with attachments, multipart/mixed around them.
 */
export function buildMime(input: { from: string; fromName?: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string;
  inReplyTo?: string | null; references?: string | null; attachments?: MimeAttachment[] }): string {
  const boundary = `space-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const mixed = `${boundary}-mixed`;
  const files = input.attachments ?? [];
  const lines = [
    `From: ${mailbox(input.fromName, input.from)}`, `To: ${addresses(input.to)}`,
    ...(input.cc?.length ? [`Cc: ${addresses(input.cc)}`] : []), ...(input.bcc?.length ? [`Bcc: ${addresses(input.bcc)}`] : []),
    `Subject: ${encodeHeader(input.subject)}`, `Message-ID: <${boundary}@space.local>`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${[input.references, input.inReplyTo].filter(Boolean).join(" ")}`] : []),
    "MIME-Version: 1.0",
    ...(files.length ? [`Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`] : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(input.text, "utf8").toString("base64"),
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(textToHtml(input.text), "utf8").toString("base64"),
    `--${boundary}--`,
    ...files.flatMap((file) => {
      const name = encodeHeader(file.filename).replace(/"/g, "");
      return [`--${mixed}`, `Content-Type: ${file.mimeType.replace(/[\r\n;]+/g, "")}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`,
        "Content-Transfer-Encoding: base64", "", base64Lines(file.data)];
    }),
    ...(files.length ? [`--${mixed}--`] : []), ""
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
