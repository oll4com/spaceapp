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
  providersCount: z.number().int().nonnegative(),
  apiKeysCount: z.number().int().nonnegative().optional(),
  credentialsCount: z.number().int().nonnegative().optional()
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
  providers: z.array(providerSchema).default([]),
  apiKeys: z.record(z.string(), z.string()).optional(),
  credentials: z.record(z.string(), z.string()).optional()
});

// Secrets (API keys, CLI logins) travel only inside this passphrase-encrypted blob.
// The KDF parameters are fixed so a crafted bundle cannot make the importer burn memory.
export const encryptedConfigSecretsSchema = z.object({
  alg: z.literal("AES-256-GCM"),
  kdf: z.object({
    name: z.literal("scrypt"),
    N: z.literal(131072),
    r: z.literal(8),
    p: z.literal(1),
    salt: z.string().min(1).max(64)
  }),
  nonce: z.string().min(1).max(64),
  /** Ciphertext followed by the 16-byte GCM tag, base64. */
  ciphertext: z.string().min(1),
  aad: z.string().max(80)
});
export type EncryptedConfigSecrets = z.infer<typeof encryptedConfigSecretsSchema>;

export const configBundlePassphraseSchema = z.string().min(12).max(1024);
export const configBundleVersion = "1.1.0";

export const spaceConfigBundleSchema = z.object({
  format: z.literal("spaceapp-configuration-bundle"),
  // 1.0.0 bundles may carry plaintext data.apiKeys; 1.1.0 keeps every secret in `encrypted`.
  version: z.enum(["1.0.0", configBundleVersion]),
  exportedAt: z.string(),
  source: configBundleSourceSchema,
  metadata: configBundleMetadataSchema,
  data: spaceConfigDataSchema,
  /** Names only: what the encrypted blob holds. */
  sections: z.object({
    apiKeys: z.object({ included: z.boolean(), encrypted: z.boolean(), names: z.array(z.string()).default([]) }).optional(),
    cliAuth: z.object({ included: z.boolean(), encrypted: z.boolean(), runtimes: z.array(z.string()).default([]) }).optional()
  }).optional(),
  encrypted: encryptedConfigSecretsSchema.optional()
});

export type SpaceConfigBundle = z.infer<typeof spaceConfigBundleSchema>;
export type SpaceConfigRoom = z.infer<typeof spaceConfigRoomSchema>;

export const configSectionSchema = z.enum(["rooms", "userSettings", "userLinks", "clipboardItems", "taskItems", "cliRuntimeSettings", "providers", "apiKeys", "credentials"]);
export type ConfigSection = z.infer<typeof configSectionSchema>;

export const exportConfigOptionsSchema = z.object({
  userId: z.string().optional(),
  includeClosedPanes: z.boolean().optional().default(false),
  includeApiKeys: z.boolean().optional().default(false),
  includeCredentials: z.boolean().optional().default(false),
  passphrase: configBundlePassphraseSchema.optional(),
  /** CLI runtimes whose logins go into the encrypted blob (with includeCredentials). */
  cliAuthRuntimes: z.array(z.string().regex(/^cli:[a-z0-9-]{1,40}$/)).max(40).optional(),
  sections: z.array(configSectionSchema).optional()
});
export type ExportConfigOptions = z.input<typeof exportConfigOptionsSchema>;

export const importConfigModeSchema = z.enum(["replace", "merge"]);
export type ImportConfigMode = z.infer<typeof importConfigModeSchema>;

export const importConfigOptionsSchema = z.object({
  // Merge adds to what is here; Replace deletes the imported sections' rooms, links, clipboard and tasks first, so it
  // needs confirmReplace (Record Retention Invariant 2026-10-20).
  mode: importConfigModeSchema.optional().default("merge"),
  confirmReplace: z.boolean().optional(),
  targetUserId: z.string().optional(),
  importApiKeys: z.boolean().optional().default(true),
  importCredentials: z.boolean().optional().default(true),
  passphrase: z.string().max(1024).optional(),
  cliAuthRuntimes: z.array(z.string().regex(/^cli:[a-z0-9-]{1,40}$/)).max(40).optional(),
  cliAuthConflict: z.enum(["backup-and-replace", "skip-if-logged-in"]).optional().default("backup-and-replace"),
  /** CLI scripts only: the HTTP route never passes a caller-chosen directory. */
  secretsDir: z.string().optional(),
  pathRewrite: z.object({
    from: z.string(),
    to: z.string()
  }).optional(),
  /** The sections to import; all of them when absent. */
  sections: z.array(configSectionSchema).optional()
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
    providersImported: z.number().int().nonnegative(),
    apiKeysImported: z.number().int().nonnegative().optional(),
    credentialsImported: z.number().int().nonnegative().optional()
  }),
  warnings: z.array(z.string()).default([]),
  cliAuth: z.array(z.object({
    runtimeId: z.string(),
    result: z.enum(["imported", "skipped", "failed"]),
    reason: z.string().optional(),
    backup: z.string().optional(),
    detect: z.enum(["logged-in", "missing", "unknown"]).optional()
  })).optional()
});
export type ImportConfigResult = z.infer<typeof importConfigResultSchema>;

export type SpaceConfigData = z.infer<typeof spaceConfigDataSchema>;

/**
 * Keeps only what restores cleanly on any host: drops source-host runtime state
 * (pane status and task sessions, running plans and timers), test/proof providers,
 * provider health results and references to rooms/panes the bundle does not carry.
 * Runs on export and again on import, so older bundles get the same treatment.
 */
export function sanitizeConfigBundleData(data: SpaceConfigData, sourceInstance: string): SpaceConfigData {
  const roomIds = new Set(data.rooms.map((room) => room.id));
  const paneIds = new Set(data.rooms.flatMap((room) => room.panes.map((pane) => pane.id)));
  const keepRoomKeys = <T>(map: Record<string, T> | undefined) =>
    map && Object.fromEntries(Object.entries(map).filter(([roomId]) => roomIds.has(roomId)));
  const settings = data.userSettings;
  const widgets = settings?.desktopWidgets && Object.fromEntries(Object.entries(settings.desktopWidgets).map(([key, value]) => {
    if (!key.startsWith("config:") || !value || typeof value !== "object") return [key, value];
    const config = value as Record<string, unknown>;
    const initialSeconds = typeof config.durationSeconds === "number" ? config.durationSeconds
      : typeof config.intervalMinutes === "number" ? config.intervalMinutes * 60 : undefined;
    return [key, {
      ...config,
      ...("isRunning" in config ? { isRunning: false } : {}),
      ...("isAlertActive" in config ? { isAlertActive: false } : {}),
      ...("remainingSeconds" in config && initialSeconds !== undefined ? { remainingSeconds: initialSeconds } : {})
    }];
  }));
  return {
    ...data,
    userSettings: settings && {
      ...settings,
      ...(widgets ? { desktopWidgets: widgets } : {}),
      ...(settings.roomExtraEmptySlots ? { roomExtraEmptySlots: keepRoomKeys(settings.roomExtraEmptySlots) } : {}),
      ...(settings.roomWorktreeOverrides ? { roomWorktreeOverrides: keepRoomKeys(settings.roomWorktreeOverrides) } : {})
    },
    rooms: data.rooms.map((room) => ({
      ...room,
      panes: room.panes.map((pane) => ({
        ...pane,
        status: pane.status === "CLOSED" ? "CLOSED" : "IDLE",
        // Task metadata names the CLI session of the source host.
        taskMetadata: null
      }))
    })),
    clipboardItems: data.clipboardItems.map((item) => ({
      ...item,
      roomId: item.roomId && roomIds.has(item.roomId) ? item.roomId : null,
      paneId: item.paneId && paneIds.has(item.paneId) ? item.paneId : null,
      ...(item.executionStatus === "IN_PROGRESS" ? { executionStatus: "PLANNED" as const } : {}),
      activeAgent: null
    })),
    taskItems: data.taskItems.map((task) => ({
      ...task,
      roomId: task.roomId && roomIds.has(task.roomId) ? task.roomId : null,
      paneId: task.paneId && paneIds.has(task.paneId) ? task.paneId : null
    })),
    providers: data.providers
      .filter((provider) => !provider.id.startsWith("proof-provider-") && !isInvalidHostUrl(provider.baseUrl))
      .map((provider) => provider.isBuiltIn ? provider : {
        ...provider,
        status: "DISABLED" as const,
        statusReason: `Imported from ${sourceInstance}. Run validation before using it on this host.`,
        healthCheckedAt: null,
        maskedKeyPrefix: null
      })
  };
}

function isInvalidHostUrl(url: string | null): boolean {
  if (!url) return false;
  try { return new URL(url).hostname.endsWith(".invalid"); } catch { return false; }
}

const droppableBundleLists = new Set(["rooms", "userLinks", "clipboardItems", "taskItems", "cliRuntimeSettings", "providers"]);

/**
 * Reads a bundle from any SpaceApp version. A newer source can carry settings values, pane types or list
 * entries this version does not know; those parts are skipped (and named in `skipped`) instead of rejecting
 * the whole file. A file whose structure is wrong still fails.
 */
export function parseConfigBundleLeniently(raw: unknown):
  | { success: true; bundle: SpaceConfigBundle; skipped: string[] }
  | { success: false; error: z.ZodError } {
  let candidate: unknown = raw;
  const skipped: string[] = [];
  for (let pass = 0; pass < 50; pass += 1) {
    const parsed = spaceConfigBundleSchema.safeParse(candidate);
    if (parsed.success) return { success: true, bundle: parsed.data, skipped };
    if (pass === 0) candidate = structuredClone(raw);
    const data = (candidate as { data?: Record<string, unknown> } | null)?.data;
    // Entries to drop, per list, with the label used in `skipped`.
    const removals = new Map<unknown[], { label: string; indexes: Set<number> }>();
    const drop = (list: unknown[], label: string, index: number) => {
      if (!removals.has(list)) removals.set(list, { label, indexes: new Set() });
      removals.get(list)!.indexes.add(index);
    };
    let changed = false;
    for (const issue of parsed.error.issues) {
      const [root, section, index, child, childIndex] = issue.path;
      if (root !== "data" || !data || typeof section !== "string") return { success: false, error: parsed.error };
      const settings = data.userSettings as Record<string, unknown> | undefined;
      if (section === "userSettings" && typeof index === "string" && settings && index in settings) {
        delete settings[index];
        skipped.push(`setting ${index}`);
        changed = true;
      } else if (section === "userSettings" && "userSettings" in data) {
        // Settings this version cannot read as a whole are optional: keep this host's own instead.
        delete data.userSettings;
        skipped.push("settings");
        changed = true;
      } else if ((section === "codexCliModeDefaults" || section === "providerSettings") && section in data) {
        delete data[section];
        skipped.push(section);
        changed = true;
      } else if (section === "rooms" && typeof index === "number" && child === "panes" && typeof childIndex === "number") {
        const panes = (data.rooms as Array<{ panes?: unknown[] }>)[index]?.panes;
        if (!panes) return { success: false, error: parsed.error };
        drop(panes, "pane", childIndex);
      } else if (droppableBundleLists.has(section) && typeof index === "number" && Array.isArray(data[section])) {
        drop(data[section] as unknown[], section === "rooms" ? "room" : section, index);
      } else {
        return { success: false, error: parsed.error };
      }
    }
    const counts = new Map<string, number>();
    for (const [list, { label, indexes }] of removals) {
      for (const index of [...indexes].sort((a, b) => b - a)) list.splice(index, 1);
      counts.set(label, (counts.get(label) ?? 0) + indexes.size);
      changed = true;
    }
    for (const [label, count] of counts) skipped.push(`${count} ${label} entr${count === 1 ? "y" : "ies"}`);
    if (!changed) return { success: false, error: parsed.error };
  }
  return { success: false, error: spaceConfigBundleSchema.safeParse(candidate).error! };
}
