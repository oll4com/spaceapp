import { z } from "zod";

/**
 * Space Dots Stage 6: Slack and Teams conversations with a user's Dots.
 *
 * A Slack or Teams user links to their Space account with a one-time code.
 * Each external thread maps to one Dot conversation of that owner. Only the
 * linked owner can drive it. In shared conversations a Dot's answers go to
 * the owner directly unless the owner allows replies in that thread.
 */
export const channelProviderSchema = z.enum(["SLACK", "TEAMS"]);
export type ChannelProvider = z.infer<typeof channelProviderSchema>;
export const channelConversationKindSchema = z.enum(["DIRECT", "GROUP"]);
export type ChannelConversationKind = z.infer<typeof channelConversationKindSchema>;

/** A message from Slack or Teams after its signature was verified. */
export interface ChannelInboundMessage {
  provider: ChannelProvider;
  /** Slack team id or Teams tenant id. */
  tenantId: string;
  /** Provider event or activity id, used to ignore retries. */
  eventId: string;
  conversationId: string;
  /** Slack thread root ts, or the Teams conversation id (which carries the thread for channels). */
  threadKey: string;
  conversationKind: ChannelConversationKind;
  externalUserId: string;
  /** Where a direct message reaches this user: the Slack user id or the Teams channel account id. */
  replyAddress: string;
  displayName: string | null;
  text: string;
  /** Teams only: where replies are sent. */
  serviceUrl: string | null;
}

/** One-time link codes: eight characters from an unambiguous alphabet, shown as XXXX-XXXX. */
export const CHANNEL_LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function normalizeChannelLinkCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((char) => CHANNEL_LINK_ALPHABET.includes(char)) ? code : null;
}
export function formatChannelLinkCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4)}`; }

export type ChannelCommand =
  | { kind: "link"; code: string }
  | { kind: "unlink" }
  | { kind: "reply-here"; enabled: boolean }
  | { kind: "message"; dot: string | null; text: string };

/** Reads what the user asked for: linking, reply placement, or a message, optionally addressed as "Orbit: …". */
export function parseChannelCommand(raw: string, dotNames: string[]): ChannelCommand {
  const text = raw.replace(/\s+/g, " ").trim();
  const link = /^link\s+([A-Za-z0-9-]{8,12})$/i.exec(text);
  if (link) { const code = normalizeChannelLinkCode(link[1]!); if (code) return { kind: "link", code }; }
  if (/^unlink$/i.test(text)) return { kind: "unlink" };
  if (/^reply here$/i.test(text)) return { kind: "reply-here", enabled: true };
  if (/^reply privately$/i.test(text)) return { kind: "reply-here", enabled: false };
  const addressed = /^@?([\p{L}\p{N} _-]{1,80}?)\s*[:,]\s*([\s\S]+)$/u.exec(raw.trim());
  if (addressed) {
    const name = dotNames.find((candidate) => candidate.toLocaleLowerCase() === addressed[1]!.trim().toLocaleLowerCase());
    if (name) return { kind: "message", dot: name, text: addressed[2]!.trim() };
  }
  return { kind: "message", dot: null, text: raw.trim() };
}

export interface ChannelProviderStatus {
  provider: ChannelProvider; configured: boolean; reason: string | null;
  /** Opens the direct conversation with the Space app (Slack: SPACE_SLACK_APP_ID); null when the server does not know its app. */
  appUrl?: string | null;
}
/** Slack's link to the direct conversation with an app; null for anything that is not a Slack app id. */
export function slackAppUrl(appId: string | null | undefined, teamId?: string | null): string | null {
  const app = appId?.trim() ?? "";
  if (!/^A[A-Z0-9]{6,30}$/.test(app)) return null;
  const team = teamId && /^[TE][A-Z0-9]{6,30}$/.test(teamId) ? `&team=${teamId}` : "";
  return `https://slack.com/app_redirect?app=${app}${team}`;
}
export interface ChannelIdentitySummary { identityId: string; provider: ChannelProvider; tenantId: string; displayName: string | null; linkedAt: string }
export interface ChannelThreadSummary {
  threadId: string; provider: ChannelProvider; conversationKind: ChannelConversationKind; dotId: string; replyInThread: boolean; updatedAt: string;
}
export interface ChannelsStatus { providers: ChannelProviderStatus[]; identities: ChannelIdentitySummary[]; threads: ChannelThreadSummary[] }
