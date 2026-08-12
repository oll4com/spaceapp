import { z } from "zod";

export const streamingProviderSchema = z.enum(["YOUTUBE", "TWITCH", "TIKTOK", "SPACE"]);
export const streamingOAuthProviderSchema = z.enum(["YOUTUBE", "TWITCH", "TIKTOK"]);
export const streamingProviderReadinessStatusSchema = z.enum(["READY", "UNCONFIGURED", "ERROR"]);
export const streamingAuthorizationStatusSchema = z.enum(["ACTIVE", "REVOKE_PENDING", "REVOKED", "ERROR"]);
export const streamingAccountStatusSchema = z.enum(["ACTIVE", "ERROR", "DISCONNECTED"]);
export const streamingMetricStateSchema = z.enum(["FRESH", "STALE", "OFFLINE", "UNAVAILABLE", "ERROR"]);
export const streamingAnalyticsPeriodSchema = z.union([z.literal(7), z.literal(28), z.literal(90)]);

export const streamingMetricKeySchema = z.enum([
  "space.rooms",
  "space.active_agents",
  "space.active_cli_sessions",
  "youtube.channel.subscribers",
  "youtube.channel.total_views",
  "youtube.channel.public_videos",
  "youtube.live.concurrent_viewers",
  "youtube.live.likes",
  "youtube.live.total_chat_count",
  "youtube.live.duration",
  "youtube.analytics.views",
  "youtube.analytics.watch_hours",
  "youtube.analytics.average_view_duration",
  "youtube.analytics.subscribers_gained",
  "youtube.analytics.subscribers_lost",
  "youtube.analytics.net_subscribers",
  "twitch.followers",
  "twitch.subscribers",
  "twitch.subscriber_points",
  "twitch.concurrent_viewers",
  "twitch.live_duration",
  "tiktok.followers",
  "tiktok.total_likes",
  "tiktok.public_videos"
]);

export const streamingMetricDefinitionSchema = z.object({
  key: streamingMetricKeySchema,
  provider: streamingProviderSchema,
  label: z.string().min(1).max(80),
  category: z.enum(["SPACE", "CHANNEL", "LIVE", "ANALYTICS", "PROFILE"]),
  analyticsPeriod: z.boolean().default(false)
}).strict();

export const streamingMetricDefinitions = [
  { key: "space.rooms", provider: "SPACE", label: "Rooms", category: "SPACE", analyticsPeriod: false },
  { key: "space.active_agents", provider: "SPACE", label: "Active agents", category: "SPACE", analyticsPeriod: false },
  { key: "space.active_cli_sessions", provider: "SPACE", label: "Active CLI sessions", category: "SPACE", analyticsPeriod: false },
  { key: "youtube.channel.subscribers", provider: "YOUTUBE", label: "Subscribers", category: "CHANNEL", analyticsPeriod: false },
  { key: "youtube.channel.total_views", provider: "YOUTUBE", label: "Total views", category: "CHANNEL", analyticsPeriod: false },
  { key: "youtube.channel.public_videos", provider: "YOUTUBE", label: "Public videos", category: "CHANNEL", analyticsPeriod: false },
  { key: "youtube.live.concurrent_viewers", provider: "YOUTUBE", label: "Concurrent viewers", category: "LIVE", analyticsPeriod: false },
  { key: "youtube.live.likes", provider: "YOUTUBE", label: "Live likes", category: "LIVE", analyticsPeriod: false },
  { key: "youtube.live.total_chat_count", provider: "YOUTUBE", label: "Chat messages", category: "LIVE", analyticsPeriod: false },
  { key: "youtube.live.duration", provider: "YOUTUBE", label: "Live duration", category: "LIVE", analyticsPeriod: false },
  { key: "youtube.analytics.views", provider: "YOUTUBE", label: "Period views", category: "ANALYTICS", analyticsPeriod: true },
  { key: "youtube.analytics.watch_hours", provider: "YOUTUBE", label: "Watch hours", category: "ANALYTICS", analyticsPeriod: true },
  { key: "youtube.analytics.average_view_duration", provider: "YOUTUBE", label: "Average view duration", category: "ANALYTICS", analyticsPeriod: true },
  { key: "youtube.analytics.subscribers_gained", provider: "YOUTUBE", label: "Subscribers gained", category: "ANALYTICS", analyticsPeriod: true },
  { key: "youtube.analytics.subscribers_lost", provider: "YOUTUBE", label: "Subscribers lost", category: "ANALYTICS", analyticsPeriod: true },
  { key: "youtube.analytics.net_subscribers", provider: "YOUTUBE", label: "Net subscribers", category: "ANALYTICS", analyticsPeriod: true },
  { key: "twitch.followers", provider: "TWITCH", label: "Followers", category: "CHANNEL", analyticsPeriod: false },
  { key: "twitch.subscribers", provider: "TWITCH", label: "Subscribers", category: "CHANNEL", analyticsPeriod: false },
  { key: "twitch.subscriber_points", provider: "TWITCH", label: "Subscriber points", category: "CHANNEL", analyticsPeriod: false },
  { key: "twitch.concurrent_viewers", provider: "TWITCH", label: "Concurrent viewers", category: "LIVE", analyticsPeriod: false },
  { key: "twitch.live_duration", provider: "TWITCH", label: "Live duration", category: "LIVE", analyticsPeriod: false },
  { key: "tiktok.followers", provider: "TIKTOK", label: "Followers", category: "PROFILE", analyticsPeriod: false },
  { key: "tiktok.total_likes", provider: "TIKTOK", label: "Total likes", category: "PROFILE", analyticsPeriod: false },
  { key: "tiktok.public_videos", provider: "TIKTOK", label: "Public videos", category: "PROFILE", analyticsPeriod: false }
] as const satisfies readonly z.input<typeof streamingMetricDefinitionSchema>[];

const metricProviderByKey = new Map(streamingMetricDefinitions.map((metric) => [metric.key, metric.provider]));
const analyticsMetricKeys: ReadonlySet<string> = new Set(
  streamingMetricDefinitions.filter((metric) => metric.analyticsPeriod).map((metric) => metric.key)
);

export const streamingOverlayTileSchema = z.object({
  metricKey: streamingMetricKeySchema,
  accountId: z.string().min(1).max(200).nullable(),
  analyticsPeriod: streamingAnalyticsPeriodSchema.optional()
}).strict().superRefine((tile, context) => {
  const provider = metricProviderByKey.get(tile.metricKey);
  if (provider === "SPACE" && tile.accountId !== null) {
    context.addIssue({ code: "custom", path: ["accountId"], message: "Space metrics cannot reference a provider account." });
  }
  if (provider !== "SPACE" && tile.accountId === null) {
    context.addIssue({ code: "custom", path: ["accountId"], message: "Provider metrics require an account." });
  }
  if (tile.analyticsPeriod !== undefined && !analyticsMetricKeys.has(tile.metricKey)) {
    context.addIssue({ code: "custom", path: ["analyticsPeriod"], message: "Only YouTube Analytics metrics accept a period." });
  }
});

export const defaultStreamingOverlayTiles = [
  { metricKey: "space.rooms", accountId: null },
  { metricKey: "space.active_agents", accountId: null },
  { metricKey: "space.active_cli_sessions", accountId: null }
] as const;

export const streamingOverlaySettingsSchema = z.object({
  version: z.number().int().positive(),
  tiles: z.array(streamingOverlayTileSchema).max(12),
  customTextEnabled: z.boolean(),
  customText: z.string().max(160),
  updatedAt: z.string().datetime(),
  updatedBy: z.string().min(1).max(200).nullable()
}).strict();

export const updateStreamingOverlaySettingsInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  tiles: z.array(streamingOverlayTileSchema).max(12),
  customTextEnabled: z.boolean(),
  customText: z.string().max(160)
}).strict().superRefine((settings, context) => {
  const seen = new Set<string>();
  settings.tiles.forEach((tile, index) => {
    const key = `${tile.metricKey}\u0000${tile.accountId ?? "SPACE"}\u0000${tile.analyticsPeriod ?? ""}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["tiles", index], message: "Overlay tiles must be unique." });
    seen.add(key);
  });
});

export const streamingProviderReadinessSchema = z.object({
  provider: streamingOAuthProviderSchema,
  status: streamingProviderReadinessStatusSchema,
  clientFilePresent: z.boolean(),
  clientFileSecure: z.boolean(),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(300),
  scopes: z.array(z.string().min(1).max(160)).max(10)
}).strict();

export const streamingAuthorizationSchema = z.object({
  id: z.string().min(1).max(200),
  provider: streamingOAuthProviderSchema,
  status: streamingAuthorizationStatusSchema,
  scopes: z.array(z.string().min(1).max(160)).max(20),
  accountCount: z.number().int().nonnegative(),
  lastRefreshedAt: z.string().datetime().nullable(),
  safeErrorCode: z.string().max(100).nullable(),
  safeErrorMessage: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const streamingPlatformAccountSchema = z.object({
  id: z.string().min(1).max(200),
  authorizationId: z.string().min(1).max(200),
  provider: streamingOAuthProviderSchema,
  externalAccountId: z.string().min(1).max(300),
  displayName: z.string().min(1).max(300),
  badge: z.string().min(1).max(160),
  status: streamingAccountStatusSchema,
  analyticsPeriod: streamingAnalyticsPeriodSchema,
  verifiedAt: z.string().datetime().nullable(),
  safeErrorCode: z.string().max(100).nullable(),
  safeErrorMessage: z.string().max(500).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const streamingCatalogResponseSchema = z.object({
  providers: z.array(streamingProviderReadinessSchema).length(3),
  metrics: z.array(streamingMetricDefinitionSchema).min(1).max(40),
  authorizations: z.array(streamingAuthorizationSchema).max(100),
  accounts: z.array(streamingPlatformAccountSchema).max(200),
  settings: streamingOverlaySettingsSchema
}).strict();

export const streamingOAuthStartResponseSchema = z.object({
  provider: streamingOAuthProviderSchema,
  authorizationUrl: z.string().url(),
  expiresAt: z.string().datetime()
}).strict();

export const streamingVerifyAccountResponseSchema = z.object({
  account: streamingPlatformAccountSchema
}).strict();

export const streamingDisconnectAuthorizationResponseSchema = z.object({
  authorizationId: z.string().min(1).max(200),
  status: streamingAuthorizationStatusSchema,
  disconnected: z.boolean()
}).strict();

export const streamingMetricTileSnapshotSchema = z.object({
  metricKey: streamingMetricKeySchema,
  accountId: z.string().min(1).max(200).nullable(),
  provider: streamingProviderSchema,
  label: z.string().min(1).max(80),
  badge: z.string().min(1).max(160),
  value: z.union([z.number().finite(), z.string().max(160)]).nullable(),
  state: streamingMetricStateSchema,
  sampledAt: z.string().datetime().nullable()
}).strict();

export const streamingOverlaySnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  settingsVersion: z.number().int().positive(),
  tiles: z.array(streamingMetricTileSnapshotSchema).max(12),
  customTextEnabled: z.boolean(),
  customText: z.string().max(160)
}).strict();

export type StreamingProvider = z.infer<typeof streamingProviderSchema>;
export type StreamingOAuthProvider = z.infer<typeof streamingOAuthProviderSchema>;
export type StreamingProviderReadinessStatus = z.infer<typeof streamingProviderReadinessStatusSchema>;
export type StreamingAuthorizationStatus = z.infer<typeof streamingAuthorizationStatusSchema>;
export type StreamingAccountStatus = z.infer<typeof streamingAccountStatusSchema>;
export type StreamingMetricState = z.infer<typeof streamingMetricStateSchema>;
export type StreamingMetricKey = z.infer<typeof streamingMetricKeySchema>;
export type StreamingMetricDefinition = z.infer<typeof streamingMetricDefinitionSchema>;
export type StreamingAnalyticsPeriod = z.infer<typeof streamingAnalyticsPeriodSchema>;
export type StreamingOverlayTile = z.infer<typeof streamingOverlayTileSchema>;
export type StreamingOverlaySettings = z.infer<typeof streamingOverlaySettingsSchema>;
export type UpdateStreamingOverlaySettingsInput = z.infer<typeof updateStreamingOverlaySettingsInputSchema>;
export type StreamingProviderReadiness = z.infer<typeof streamingProviderReadinessSchema>;
export type StreamingAuthorization = z.infer<typeof streamingAuthorizationSchema>;
export type StreamingPlatformAccount = z.infer<typeof streamingPlatformAccountSchema>;
export type StreamingCatalogResponse = z.infer<typeof streamingCatalogResponseSchema>;
export type StreamingOAuthStartResponse = z.infer<typeof streamingOAuthStartResponseSchema>;
export type StreamingVerifyAccountResponse = z.infer<typeof streamingVerifyAccountResponseSchema>;
export type StreamingDisconnectAuthorizationResponse = z.infer<typeof streamingDisconnectAuthorizationResponseSchema>;
export type StreamingMetricTileSnapshot = z.infer<typeof streamingMetricTileSnapshotSchema>;
export type StreamingOverlaySnapshot = z.infer<typeof streamingOverlaySnapshotSchema>;
