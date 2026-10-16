import type {
  StreamingAccountStatus,
  StreamingAuthorizationStatus,
  StreamingBotActivityStatus,
  StreamingBotReviewedMemory,
  StreamingModerationAction,
  StreamingProvider,
  StreamingProviderReadinessStatus
} from "@space/contracts";

// Readable English labels for the codes the streaming API returns, so the
// dock never shows raw enum values such as CLIENT_FILE_MISSING.

/** "PROVIDER_FAILED" -> "Provider failed"; text that is not a code is returned unchanged. */
export function readableCode(code: string): string {
  if (!/^[A-Z0-9_]+$/.test(code)) return code;
  const words = code.toLowerCase().replaceAll("_", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function providerLabel(provider: StreamingProvider | string): string {
  switch (provider) {
    case "YOUTUBE": return "YouTube";
    case "TWITCH": return "Twitch";
    case "TIKTOK": return "TikTok";
    case "X": return "X";
    case "DISCORD": return "Discord";
    case "SPACE": return "Space";
    default: return readableCode(provider);
  }
}

const readinessStatusLabels: Record<StreamingProviderReadinessStatus, string> = {
  READY: "Ready",
  UNCONFIGURED: "Not configured",
  ERROR: "Error"
};

export function readinessStatusLabel(status: StreamingProviderReadinessStatus | undefined): string {
  return status ? readinessStatusLabels[status] ?? readableCode(status) : "Unavailable";
}

const readinessCodeLabels: Record<string, string> = {
  READY: "Ready to connect",
  CLIENT_FILE_MISSING: "Client credentials file is missing",
  CLIENT_FILE_PERMISSIONS: "Client credentials file needs owner-only permissions",
  CLIENT_FILE_INVALID: "Client credentials file is not valid",
  DEMO_LOCAL_ONLY: "Not available in the local demo"
};

export function readinessCodeLabel(code: string): string {
  return readinessCodeLabels[code] ?? readableCode(code);
}

const accountStatusLabels: Record<StreamingAccountStatus, string> = {
  ACTIVE: "Active",
  ERROR: "Needs attention",
  DISCONNECTED: "Disconnected"
};

export function accountStatusLabel(status: StreamingAccountStatus): string {
  return accountStatusLabels[status] ?? readableCode(status);
}

const authorizationStatusLabels: Record<StreamingAuthorizationStatus, string> = {
  ACTIVE: "Active",
  REVOKE_PENDING: "Disconnecting",
  REVOKED: "Disconnected",
  ERROR: "Needs attention"
};

export function authorizationStatusLabel(status: StreamingAuthorizationStatus): string {
  return authorizationStatusLabels[status] ?? readableCode(status);
}

const activityStatusLabels: Record<StreamingBotActivityStatus, string> = {
  REPLIED: "Replied",
  SKIPPED: "Skipped",
  ERROR: "Error",
  TEST: "Test"
};

export function activityStatusLabel(status: StreamingBotActivityStatus): string {
  return activityStatusLabels[status] ?? readableCode(status);
}

const moderationDecisionLabels: Record<StreamingModerationAction["decision"], string> = {
  ALLOW: "Allowed",
  REVIEW: "Sent to review",
  WARN: "Warning",
  TIMEOUT_5M: "5 minute timeout",
  TIMEOUT_30M: "30 minute timeout"
};

export function moderationDecisionLabel(decision: StreamingModerationAction["decision"]): string {
  return moderationDecisionLabels[decision] ?? readableCode(decision);
}

const moderationResultLabels: Record<StreamingModerationAction["result"], string> = {
  PENDING: "Pending",
  SUCCEEDED: "Done",
  FAILED: "Failed",
  UNAVAILABLE: "Not available",
  REVIEW: "In review",
  UNDONE: "Undone"
};

export function moderationResultLabel(result: StreamingModerationAction["result"]): string {
  return moderationResultLabels[result] ?? readableCode(result);
}

export function memoryStatusLabel(status: StreamingBotReviewedMemory["status"]): string {
  return status === "PENDING" ? "Pending review" : status === "APPROVED" ? "Approved" : readableCode(status);
}

export function memorySourceLabel(source: StreamingBotReviewedMemory["source"]): string {
  return source === "OPERATOR" ? "Added by you" : source === "BOT" ? "Suggested by the bot" : source === "LEGACY" ? "Imported" : readableCode(source);
}
