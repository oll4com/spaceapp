// Forgot password by mail (Nous 13/11, condition 3): agents read the owner's mailboxes (Mail Copilot, Nous mail tools, Job Copilot,
// Dots), so every mail read path hides a SpaceApp reset link's token, as with one-time codes. `=3D` is the same link quoted-printable.
const RESET_TOKEN = /(password-reset(?:=3D|=))[A-Za-z0-9_-]{16,}/g;
const HIDDEN = "[hidden: a SpaceApp password reset link works only for the owner, in their own browser]";

export function maskPasswordResetLinks(text: string): string {
  return text.includes("password-reset") ? text.replace(RESET_TOKEN, `$1${HIDDEN}`) : text;
}

/** A mail provider's JSON answer with every reset token hidden: plain strings, and Gmail's base64url `data`/`raw` bodies. */
export function maskPasswordResetJson<T>(value: T): T {
  return walk(value, "") as T;
}

function walk(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if ((key === "data" || key === "raw") && value.length >= 16 && /^[A-Za-z0-9_=-]+$/.test(value)) {
      const decoded = Buffer.from(value, "base64url").toString("utf8");
      const masked = maskPasswordResetLinks(decoded);
      return masked === decoded ? value : Buffer.from(masked, "utf8").toString("base64url");
    }
    return maskPasswordResetLinks(value);
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
  return value;
}
