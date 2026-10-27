import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { sanitizeConfigBundleData, type ConfigSection, type SpaceConfigBundle, type SpaceConfigData } from "@space/contracts";

export interface PreparedConfigImport {
  data: SpaceConfigData;
  warnings: string[];
  /** Room project folders (after mapping) that do not exist here. */
  missingProjectRoots: string[];
  /** The bundle's default provider is one of its own custom providers, which arrive unvalidated. */
  keepTargetDefaultProvider: boolean;
}

/** Whether an import takes a section: all of them when none are named. */
export function configImportIncludes(sections: readonly ConfigSection[] | undefined, section: ConfigSection): boolean {
  return !sections?.length || sections.includes(section);
}

export const CONFIG_REPLACE_UNCONFIRMED = "Replace deletes this account's rooms, links, clipboard and tasks of the imported sections before importing: confirm Replace, or import with Merge.";

/** Replace deletes durable records before it imports, so it runs only on an explicit, confirmed choice (Record Retention Invariant). */
export function assertConfigReplaceConfirmed(options: { mode?: string; confirmReplace?: boolean }): void {
  if (options.mode === "replace" && options.confirmReplace !== true) throw new Error(CONFIG_REPLACE_UNCONFIRMED);
}

/** Merge keeps the settings the bundle does not name; room-keyed maps keep this host's rooms too. */
export function mergeImportedUserSettings<T extends { roomExtraEmptySlots?: Record<string, number>; roomWorktreeOverrides?: Record<string, boolean> }>(existing: T | null | undefined, imported: T): T {
  if (!existing) return imported;
  return {
    ...existing,
    ...imported,
    ...(existing.roomExtraEmptySlots || imported.roomExtraEmptySlots ? { roomExtraEmptySlots: { ...existing.roomExtraEmptySlots, ...imported.roomExtraEmptySlots } } : {}),
    ...(existing.roomWorktreeOverrides || imported.roomWorktreeOverrides ? { roomWorktreeOverrides: { ...existing.roomWorktreeOverrides, ...imported.roomWorktreeOverrides } } : {})
  };
}

/** Only a confirmed absence counts: a folder this process may not read can still exist for the CLI user. */
export async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function rewritePathPrefix(path: string, rewrite: { from: string; to: string } | undefined): string;
export function rewritePathPrefix(path: string | null | undefined, rewrite: { from: string; to: string } | undefined): string | null | undefined;
export function rewritePathPrefix(path: string | null | undefined, rewrite: { from: string; to: string } | undefined) {
  if (!path || !rewrite) return path;
  const from = rewrite.from.replace(/\/+$/, "");
  const to = rewrite.to.replace(/\/+$/, "");
  return path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

function hostOnlyEndpoint(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (isIP(host) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host);
    return isIP(host) === 6 && (host === "::1" || /^f[cd]/i.test(host));
  } catch {
    return false;
  }
}

/**
 * Fits a bundle to this host before anything is written: runtime state and dangling references are dropped,
 * paths are mapped (or cleared when the folder does not exist here), and settings that name accounts or
 * endpoints of the source host are reported. Reads the filesystem and the store; writes nothing.
 */
export async function prepareConfigImport(
  bundle: SpaceConfigBundle,
  options: { pathRewrite?: { from: string; to: string }; sections?: readonly ConfigSection[] },
  host: { profileExists(runtimeId: string, profileId: string): Promise<boolean> }
): Promise<PreparedConfigImport> {
  const data = sanitizeConfigBundleData(bundle.data, bundle.source.instance);
  const take = (section: ConfigSection) => configImportIncludes(options.sections, section);
  if (!take("rooms")) data.rooms = [];
  if (!take("userSettings")) delete data.userSettings;
  if (!take("userLinks")) data.userLinks = [];
  if (!take("clipboardItems")) data.clipboardItems = [];
  if (!take("taskItems")) data.taskItems = [];
  if (!take("cliRuntimeSettings")) { data.cliRuntimeSettings = []; delete data.codexCliModeDefaults; }
  if (!take("providers")) { data.providers = []; delete data.providerSettings; }
  if (!take("apiKeys")) delete data.apiKeys;
  const warnings: string[] = [];
  const rewrite = options.pathRewrite;

  let movedPanes = 0;
  const missingRoots = new Set<string>();
  for (const room of data.rooms) {
    let projectPath = rewritePathPrefix(room.projectPath, rewrite) ?? null;
    if (projectPath && await pathIsMissing(projectPath)) {
      missingRoots.add(projectPath);
      projectPath = null;
    }
    room.projectPath = projectPath;
    for (const pane of room.panes) {
      const cwd = rewritePathPrefix(pane.cwd, rewrite) ?? null;
      if (cwd && !await pathIsMissing(cwd)) {
        pane.cwd = cwd;
      } else {
        if (cwd && cwd !== projectPath) movedPanes += 1;
        pane.cwd = projectPath;
      }
    }
  }
  if (missingRoots.size) {
    warnings.push(`Project folder ${[...missingRoots].join(", ")} does not exist on this host; those rooms have no project folder until you choose one.`);
  }
  if (movedPanes) {
    warnings.push(`${movedPanes} pane folder(s), such as worktrees of the source host, do not exist here; those panes start in their room's project folder.`);
  }
  if (data.userSettings?.projectPresets) {
    data.userSettings.projectPresets = data.userSettings.projectPresets.map((preset) => ({ ...preset, path: rewritePathPrefix(preset.path, rewrite) }));
  }

  for (const provider of data.providers) {
    if (!provider.isBuiltIn && hostOnlyEndpoint(provider.baseUrl)) {
      warnings.push(`Provider ${provider.displayName} points to ${provider.baseUrl}, an address of the source host's network. It stays disabled until you validate it here.`);
    }
  }
  const defaultProviderId = data.providerSettings?.defaultProviderId;
  const defaultProvider = data.providers.find((provider) => provider.id === defaultProviderId);
  const keepTargetDefaultProvider = Boolean(defaultProviderId) && !defaultProvider?.isBuiltIn;
  if (keepTargetDefaultProvider) {
    warnings.push(`The backup's default provider ${defaultProviderId} is not validated on this host, so the current default provider stays.`);
  }

  const settings = data.userSettings;
  for (const [key, label] of [["jobCopilot", "Job Copilot"], ["mailCopilot", "Mail Copilot"], ["marketingCopilot", "Marketing Copilot"]] as const) {
    const launch = settings?.[key];
    if (launch?.accountProfileId && launch.accountProfileId !== "main" && !await host.profileExists(launch.runtimeId, launch.accountProfileId)) {
      warnings.push(`${label} used account profile ${launch.accountProfileId}, which this host does not have; it now starts on the CLI's default account.`);
      settings![key] = { ...launch, accountProfileId: null };
    }
  }

  if (data.credentials && Object.keys(data.credentials).length) {
    warnings.push("Login files saved by older backups are not restored; sign in to those CLIs on this host.");
  }
  delete data.credentials;
  return { data, warnings, keepTargetDefaultProvider, missingProjectRoots: [...missingRoots] };
}

/** Room-keyed user settings follow the rooms when a merge import gives them new ids. */
export function remapRoomKeyedSettings<T extends { roomExtraEmptySlots?: Record<string, number>; roomWorktreeOverrides?: Record<string, boolean> }>(settings: T, roomIdMap: Map<string, string>): T {
  const remap = <V>(map: Record<string, V> | undefined) =>
    map && Object.fromEntries(Object.entries(map).flatMap(([roomId, value]) => roomIdMap.has(roomId) ? [[roomIdMap.get(roomId)!, value]] : []));
  return {
    ...settings,
    ...(settings.roomExtraEmptySlots ? { roomExtraEmptySlots: remap(settings.roomExtraEmptySlots) } : {}),
    ...(settings.roomWorktreeOverrides ? { roomWorktreeOverrides: remap(settings.roomWorktreeOverrides) } : {})
  };
}
