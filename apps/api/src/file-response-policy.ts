import type { FastifyReply } from "fastify";

const sandboxedInlineTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/x-icon",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "video/mp4", "video/webm", "video/quicktime", "application/pdf"
]);

/** Active web formats and unknown types download; media/PDF remain available
 * inline under the sandbox. A declared type must never grant app privileges. */
export function applyFileResponsePolicy(reply: FastifyReply, mimeType: string, filename: string, download = false): void {
  const disposition = !download && sandboxedInlineTypes.has(mimeType.toLowerCase()) ? "inline" : "attachment";
  const safeName = filename.replace(/[\x00-\x1f\x7f"\\]/g, "_");
  reply
    .type(mimeType)
    .header("content-disposition", `${disposition}; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`)
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "private, no-store")
    .header("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; sandbox")
    .header("referrer-policy", "no-referrer");
}
