import { z } from "zod";

export const pluginCategorySchema = z.enum([
  "developer",
  "communication",
  "database",
  "analytics",
  "creative",
  "finance",
  "infra",
  "productivity"
]);

export const pluginAuthTypeSchema = z.enum([
  "api_key",
  "oauth2",
  "bearer_token",
  "custom_headers",
  "none"
]);

export const pluginConnectionStatusSchema = z.enum([
  "NOT_CONNECTED",
  "CONNECTING",
  "CONNECTED",
  "ERROR"
]);

export const pluginAuthFieldSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "password", "url"]),
  required: z.boolean().default(true),
  placeholder: z.string().max(160).default(""),
  description: z.string().max(300).default("")
});

export const pluginCatalogItemSchema = z.object({
  id: z.string().min(1).max(80),
  displayName: z.string().min(1).max(120),
  description: z.string().max(500),
  category: pluginCategorySchema,
  icon: z.string().min(1).max(80),
  authType: pluginAuthTypeSchema,
  authFields: z.array(pluginAuthFieldSchema).default([]),
  websiteUrl: z.string().url().nullable().default(null),
  docsUrl: z.string().url().nullable().default(null),
  preview: z.boolean().default(false),
  defaultEnabled: z.boolean().default(true),
  mcpCommand: z.string().min(1).max(300).nullable().default(null),
  mcpArgs: z.array(z.string().max(300)).default([])
});

export const pluginConnectionStateSchema = z.object({
  pluginId: z.string().min(1).max(80),
  status: pluginConnectionStatusSchema,
  connectedAt: z.string().datetime({ offset: true }).nullable().default(null),
  lastHealthCheckAt: z.string().datetime({ offset: true }).nullable().default(null),
  accountLabel: z.string().max(160).nullable().default(null),
  toolCount: z.number().int().nonnegative().default(0),
  error: z.string().max(500).nullable().default(null)
});

export const pluginWithStateSchema = pluginCatalogItemSchema.extend({
  connection: pluginConnectionStateSchema
});

export const connectPluginInputSchema = z.object({
  pluginId: z.string().min(1).max(80),
  credentials: z.record(z.string().min(1).max(80), z.string().max(4000)),
  accountLabel: z.string().max(160).optional()
});

export const agentPluginConfigSchema = z.object({
  paneId: z.string().min(1).max(160),
  enabledPluginIds: z.array(z.string().min(1).max(80)).default([]),
  disabledPluginIds: z.array(z.string().min(1).max(80)).default([])
});

export type PluginCategory = z.infer<typeof pluginCategorySchema>;
export type PluginAuthType = z.infer<typeof pluginAuthTypeSchema>;
export type PluginConnectionStatus = z.infer<typeof pluginConnectionStatusSchema>;
export type PluginAuthField = z.infer<typeof pluginAuthFieldSchema>;
export type PluginCatalogItem = z.infer<typeof pluginCatalogItemSchema>;
export type PluginConnectionState = z.infer<typeof pluginConnectionStateSchema>;
export type PluginWithState = z.infer<typeof pluginWithStateSchema>;
export type ConnectPluginInput = z.infer<typeof connectPluginInputSchema>;
export type AgentPluginConfig = z.infer<typeof agentPluginConfigSchema>;
