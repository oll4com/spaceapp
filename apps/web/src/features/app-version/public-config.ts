export type PublicHomepageConfig = {
  discordUrl: string | null;
};

declare global {
  interface Window {
    __SPACE_PUBLIC_CONFIG__?: { discordUrl?: unknown };
  }
}

function safeDiscordUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const isShortInvite = url.hostname === "discord.gg" && pathSegments.length === 1;
    const isCanonicalInvite = url.hostname === "discord.com" && pathSegments.length === 2 && pathSegments[0] === "invite";
    return isShortInvite || isCanonicalInvite ? url.toString() : null;
  } catch {
    return null;
  }
}

export function readPublicHomepageConfig(
  source: { discordUrl?: unknown } | undefined = typeof window === "undefined" ? undefined : window.__SPACE_PUBLIC_CONFIG__
): PublicHomepageConfig {
  return { discordUrl: safeDiscordUrl(source?.discordUrl) };
}
