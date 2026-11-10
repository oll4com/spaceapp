import { hostname } from "node:os";

/**
 * The owner's own mail infrastructure, set per instance (stable's in deploy/space-api.service), never in code (review EXT-C-F18 R2).
 * Unset: no SMTP server of our own (an SMTP sender then needs the operator's EXTERNAL decision), the lab names the missing egress
 * address, and SMTP greets with this host's name.
 */
export function mailSite(env: NodeJS.ProcessEnv = process.env) {
  return {
    /** The one public address every guest sends from (SPACE_MAIL_EGRESS_IP). */
    egressIp: env.SPACE_MAIL_EGRESS_IP?.trim() ?? "",
    /** Our own submission servers (SPACE_MAIL_SMTP_HOSTS, comma-separated); anything else (an ESP, a paid relay) needs the operator's EXTERNAL decision. */
    smtpHosts: new Set((env.SPACE_MAIL_SMTP_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean)),
    /** The HELO name of SMTP submission, the egress address's public name (SPACE_MAIL_HELO_NAME). */
    heloName: env.SPACE_MAIL_HELO_NAME?.trim() || hostname()
  };
}
