import type { StreamingAuthorization, StreamingPlatformAccount } from "@space/contracts";

export interface StreamingCapabilities {
  metrics: boolean;
  readChat: boolean;
  reply: boolean;
  moderate: boolean;
  reason: string | null;
}

export function streamingCapabilities(
  account: StreamingPlatformAccount,
  authorization: StreamingAuthorization | undefined
): StreamingCapabilities {
  const connected = account.status === "ACTIVE" && authorization?.status === "ACTIVE";
  if (!connected) return { metrics: false, readChat: false, reply: false, moderate: false, reason: "Account is not active." };
  const scopes = new Set(authorization.scopes);
  switch (account.provider) {
    case "YOUTUBE": {
      const chat = scopes.has("https://www.googleapis.com/auth/youtube.force-ssl");
      return { metrics: true, readChat: chat, reply: chat, moderate: chat, reason: chat ? null : "YouTube chat permission is missing." };
    }
    case "TWITCH": {
      const readChat = scopes.has("user:read:chat");
      const reply = scopes.has("user:write:chat");
      const moderate = scopes.has("moderator:manage:banned_users");
      return { metrics: true, readChat, reply, moderate, reason: !readChat ? "Twitch chat read permission is missing." : !moderate ? "Twitch timeout permission is missing." : null };
    }
    case "DISCORD": return { metrics: true, readChat: false, reply: false, moderate: false, reason: "A Discord bot with channel and server moderation permissions is required." };
    case "TIKTOK": return { metrics: true, readChat: false, reply: false, moderate: false, reason: "Official live chat and moderation API unavailable." };
    case "X": return { metrics: true, readChat: false, reply: false, moderate: false, reason: "Official live chat and timeout API unavailable." };
  }
}
