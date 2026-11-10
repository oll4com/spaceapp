import { createHash, createPrivateKey, createSign } from "node:crypto";

// Space's own DKIM signature on SMTP campaign mail (Nous 2/11, plan clipboard:IJ2ovfLg1Lbw step 11): public-host's Plesk signer covers only
// From, To and Subject, and RFC 8058 asks one-click mail to sign List-Unsubscribe and List-Unsubscribe-Post. rsa-sha256, relaxed/relaxed
// (RFC 6376 §3.4.2, §3.4.4); a header listed here is signed only when the message has it.
export const DKIM_SIGNED_HEADERS = ["from", "to", "subject", "date", "message-id", "reply-to", "list-unsubscribe", "list-unsubscribe-post", "list-id",
  "feedback-id", "mime-version", "content-type", "content-transfer-encoding"] as const;

const relaxedHeader = (name: string, value: string) =>
  `${name.toLowerCase()}:${value.replace(/\r?\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim()}\r\n`;

/** The relaxed body: whitespace runs to one space, none at line ends, no empty lines at the end, one CRLF after the last line. */
export function dkimRelaxedBody(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

/** A kept Vault key's value: a PEM, or the PKCS#8 DER in base64 on one line (Vault keys are one line). */
export function dkimPrivateKey(value: string) {
  const trimmed = value.trim();
  return /-----BEGIN/.test(trimmed) ? createPrivateKey(trimmed) : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
}

/** The message with a DKIM-Signature header on top. */
export function dkimSign(raw: Buffer, options: { domain: string; selector: string; privateKey: string; now?: number }): Buffer {
  const text = raw.toString("utf8");
  const gap = /\r?\n\r?\n/.exec(text);
  const head = gap ? text.slice(0, gap.index) : text;
  const body = gap ? text.slice(gap.index + gap[0].length) : "";
  const fields = head.split(/\r?\n(?![ \t])/).map((field) => {
    const colon = field.indexOf(":");
    return { name: field.slice(0, colon).trim(), value: field.slice(colon + 1) };
  }).filter((field) => field.name);
  // The last instance of each signed name (§5.4.2): the one a verifier takes first, bottom up.
  const signed = DKIM_SIGNED_HEADERS.flatMap((name) => {
    const field = fields.filter((candidate) => candidate.name.toLowerCase() === name).at(-1);
    return field ? [field] : [];
  });
  const bh = createHash("sha256").update(dkimRelaxedBody(body), "utf8").digest("base64");
  const tags = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${options.domain}; s=${options.selector}; t=${Math.floor((options.now ?? Date.now()) / 1000)}; ` +
    `h=${signed.map((field) => field.name.toLowerCase()).join(":")}; bh=${bh}; b=`;
  const data = signed.map((field) => relaxedHeader(field.name, field.value)).join("") + relaxedHeader("DKIM-Signature", ` ${tags}`).replace(/\r\n$/, "");
  const b = createSign("RSA-SHA256").update(data, "utf8").sign(dkimPrivateKey(options.privateKey), "base64");
  return Buffer.concat([Buffer.from(`DKIM-Signature: ${tags}${b}\r\n`, "utf8"), raw]);
}
