import { z } from "zod";
import {
  roomSchema,
  paneSchema,
  userSettingsSchema,
  userLinkSchema,
  clipboardItemSchema,
  taskItemSchema,
  cliRuntimeSettingSchema,
  codexCliModeDefaultsSchema,
  providerSettingsSchema,
  providerSchema
} from "./schemas.js";

export const configBundleMetadataSchema = z.object({
  roomsCount: z.number().int().nonnegative(),
  panesCount: z.number().int().nonnegative(),
  userLinksCount: z.number().int().nonnegative(),
  clipboardItemsCount: z.number().int().nonnegative(),
  taskItemsCount: z.number().int().nonnegative(),
  cliRuntimesCount: z.number().int().nonnegative(),
  providersCount: z.number().int().nonnegative()
});

export const configBundleSourceSchema = z.object({
  instance: z.string(),
  exportedBy: z.string(),
  appVersion: z.string().optional()
});

export const spaceConfigRoomSchema = roomSchema.extend({
  panes: z.array(paneSchema).default([])
});

export const spaceConfigDataSchema = z.object({
  userSettings: userSettingsSchema.optional(),
  rooms: z.array(spaceConfigRoomSchema).default([]),
  userLinks: z.array(userLinkSchema).default([]),
  clipboardItems: z.array(clipboardItemSchema).default([]),
  taskItems: z.array(taskItemSchema).default([]),
  cliRuntimeSettings: z.array(cliRuntimeSettingSchema).default([]),
  codexCliModeDefaults: codexCliModeDefaultsSchema.optional(),
  providerSettings: providerSettingsSchema.optional(),
  providers: z.array(providerSchema).default([])
});

export const spaceConfigBundleSchema = z.object({
  format: z.literal("spaceapp-configuration-bundle"),
  version: z.literal("1.0.0"),
  exportedAt: z.string(),
  source: configBundleSourceSchema,
  metadata: configBundleMetadataSchema,
  data: spaceConfigDataSchema
});

export type SpaceConfigBundle = z.infer<typeof spaceConfigBundleSchema>;
export type SpaceConfigRoom = z.infer<typeof spaceConfigRoomSchema>;

export const exportConfigOptionsSchema = z.object({
  userId: z.string().optional(),
  includeClosedPanes: z.boolean().optional().default(false),
  sections: z.array(z.enum([
    "rooms",
    "userSettings",
    "userLinks",
    "clipboardItems",
    "taskItems",
    "cliRuntimeSettings",
    "providers"
  ])).optional()
});
export type ExportConfigOptions = z.input<typeof exportConfigOptionsSchema>;

export const importConfigModeSchema = z.enum(["replace", "merge"]);
export type ImportConfigMode = z.infer<typeof importConfigModeSchema>;

export const importConfigOptionsSchema = z.object({
  mode: importConfigModeSchema.optional().default("replace"),
  targetUserId: z.string().optional(),
  pathRewrite: z.object({
    from: z.string(),
    to: z.string()
  }).optional(),
  sections: z.array(z.string()).optional()
});
export type ImportConfigOptions = z.input<typeof importConfigOptionsSchema>;

export const importConfigRequestSchema = importConfigOptionsSchema.extend({
  bundle: spaceConfigBundleSchema
});
export type ImportConfigRequest = z.infer<typeof importConfigRequestSchema>;

export const importConfigResultSchema = z.object({
  success: z.boolean(),
  mode: importConfigModeSchema,
  targetUserId: z.string(),
  stats: z.object({
    roomsImported: z.number().int().nonnegative(),
    panesImported: z.number().int().nonnegative(),
    linksImported: z.number().int().nonnegative(),
    clipboardImported: z.number().int().nonnegative(),
    tasksImported: z.number().int().nonnegative(),
    settingsUpdated: z.boolean(),
    cliRuntimesImported: z.number().int().nonnegative(),
    providersImported: z.number().int().nonnegative()
  }),
  warnings: z.array(z.string()).default([])
});
export type ImportConfigResult = z.infer<typeof importConfigResultSchema>;
