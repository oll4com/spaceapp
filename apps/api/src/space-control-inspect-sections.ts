import { SPACE_CONTROL_VERSION, isAgentFileArtifact, isRoomMediaArtifact, type AntigravityUsageAccountList, type CodexUsageAccountList, type ControlInspect } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { createCliVpnApplicationsReader } from "./cli-vpn-applications.js";
import { discoverAgentRuntimes } from "./cli-runtimes.js";
import type { SpaceApiConfig } from "./config.js";
import { pluginsService } from "./plugins-service.js";
import type { createSpaceControlPaneActions } from "./space-control-pane-actions.js";
import { controlSkillsPage } from "./space-control-resources.js";
import type { ControlActor } from "./space-control-settings.js";
import type { SystemHealthMonitor } from "./system-health-service.js";
import { buildVoiceTranscriptionSettings } from "./voice-settings.js";
import { getLiveAudioProvidersStatus, getLocalVoiceProviderStatus, isLocalSenseVoiceUp } from "./voice-transcription.js";

type SpaceControlInspectSectionDeps = {
  store: SpaceStore;
  config: SpaceApiConfig;
  controlUser: (id: string) => Promise<{ id: string }>;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  toolbarUsageProvider: () => Promise<CodexUsageAccountList>;
  readCliVpnApplications: ReturnType<typeof createCliVpnApplicationsReader>;
  healthMonitor: Pick<SystemHealthMonitor, "snapshot">;
  taskTitleRepository: { getSettings(): Promise<unknown> };
  spaceControl: { layout(roomId: string): Promise<{ mode?: unknown } | null> };
} & Pick<ReturnType<typeof createSpaceControlPaneActions>, "controlQuota">;

/**
 * Space Control's inspect sections beyond rooms and panes: rooms, skills, quota (a pane's native limits or the account totals),
 * runtimes, VPN egress, files and media, system health, plugins, modules, voice, links, tasks and the settings summary; any other
 * section answers unsupported.
 */
export function createSpaceControlInspectSections(deps: SpaceControlInspectSectionDeps) {
  const { store, config, controlUser, controlQuota, antigravityUsageProvider, toolbarUsageProvider, readCliVpnApplications, healthMonitor,
    taskTitleRepository, spaceControl } = deps;
  async function inspectControlSection(actor: ControlActor, input: ControlInspect) {
    const owner = await controlUser(actor.id);
    if(input.section==="ROOMS")return store.listRooms();
    if(input.section==="SKILLS")return controlSkillsPage(await store.listSkills(),input);
    if(input.section==="QUOTA"){
      if(input.paneId){const pane=await store.getPane(input.paneId);if(pane.roomId!==input.roomId)throw new SpaceConflictError("Pane is outside this room.");return controlQuota(pane);}
      const antiUsage = await antigravityUsageProvider().catch(()=>({data:[]}));
      return {
        accounts:await toolbarUsageProvider(),
        antigravityAccounts:antiUsage.data,
        paneBinding:"Inspect QUOTA with paneId for native per-session limits. Account totals alone do not authorize automatic continuation."
      };
    }
    if(input.section==="RUNTIMES")return {settings:await store.listCliRuntimeSettings(),runtimes:await discoverAgentRuntimes(config)};
    if(input.section==="VPN")return (await readCliVpnApplications(await store.listCliRuntimeSettings())).egress;
    if(input.section==="FILES"||input.section==="MEDIA")return (await store.listArtifacts({roomId:input.roomId,page:Math.floor(input.offset/input.limit)+1,pageSize:input.limit,sortOrder:"desc"}))
      .filter(item=>input.section==="FILES"?isAgentFileArtifact(item):isRoomMediaArtifact(item))
      .map(item=>({id:item.id,kind:item.kind,mimeType:item.mimeType,createdAt:item.createdAt}));
    if(input.section==="SYSTEM_HEALTH"){
      const snapshot = await healthMonitor.snapshot();
      return {
        sampledAt: snapshot.sampledAt,
        uptimeSeconds: Math.round(process.uptime()),
        memoryHeapMiB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
        metrics: snapshot.metrics,
        services: snapshot.services,
        requests: snapshot.requests
      };
    }
    if(input.section==="PLUGINS"){
      const plugins = await pluginsService.getPlugins();
      return {
        count: plugins.length,
        plugins: plugins.map(p => ({
          id: p.id,
          name: p.displayName,
          description: p.description,
          connected: p.connection.status === "CONNECTED",
          status: p.connection.status,
          error: p.connection.error ?? null
        }))
      };
    }
    if(input.section==="MODULES"){
      return {
        version: SPACE_CONTROL_VERSION,
        navigationGroups: ["workspace", "create", "tools", "docks"],
        docks: [
          { id: "surface-health", label: "System Health", scope: "installation" },
          { id: "system-resources", label: "System Resources", scope: "installation" },
          { id: "surface-cli", label: "CLI Runtimes", scope: "installation" },
          { id: "quick-links", label: "Quick Links", scope: "room" },
          { id: "clip-tool", label: "Clipboard Dock", scope: "operator" },
          { id: "plugins", label: "Plugins Management", scope: "installation" },
          { id: "voice-input", label: "Voice Settings", scope: "browser" },
          { id: "appearance", label: "UI Theme & Scale", scope: "room" }
        ],
        features: {
          roomAgent: true,
          voiceAssistant: true,
          multiRuntimeCli: true,
          screenCapture: true,
          watches: true,
          dryRun: true,
          settingsRollback: true
        }
      };
    }
    if(input.section==="VOICE"){
      const transcription = buildVoiceTranscriptionSettings(config, await isLocalSenseVoiceUp(config));
      const providers = await getLiveAudioProvidersStatus(config).catch(() => ({ providers: [] }));
      const local = await getLocalVoiceProviderStatus(config).catch(() => ({ status: "unavailable" }));
      return { transcription, providers, local };
    }
    if(input.section==="LINKS"){
      const query = { page: Math.floor(input.offset / input.limit) + 1, pageSize: input.limit, isQuick: undefined };
      const result = await store.listUserLinks(owner.id, query);
      return {
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize
      };
    }
    if(input.section==="TASKS"){
      const query = { page: Math.floor(input.offset / input.limit) + 1, pageSize: input.limit, ...(input.query ? { q: input.query } : {}) };
      const result = await store.listTaskItems(owner.id, query);
      return {
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize
      };
    }
    if(input.section==="SETTINGS"){
      // One unreadable part leaves its default instead of failing the whole summary.
      const read = <T, F>(load: () => T | Promise<T>, fallback: F) => Promise.resolve().then(load).catch(() => fallback);
      const { roomId } = input;
      const [cli, providers, tools, taskTitles, plugins, voice, room, layout] = await Promise.all([
        read(() => store.listCliRuntimeSettings(), []),
        read(() => store.getProviderSettings(), null),
        read(() => store.listAgentToolAssignments(), []),
        read(() => taskTitleRepository.getSettings(), null),
        read(() => pluginsService.getPlugins(), []),
        read(() => buildVoiceTranscriptionSettings(config), null),
        roomId ? read(() => store.getRoom(roomId), null) : null,
        roomId ? read(() => spaceControl.layout(roomId), null) : null
      ]);

      return {
        cli,
        // Provider settings hold only the default id (no per-provider list or keys).
        providers: providers ? { defaultProviderId: providers.defaultProviderId } : null,
        tools,
        taskTitles,
        plugins: plugins.map((p) => ({
          id: p.id,
          name: p.displayName,
          connected: p.connection?.status === "CONNECTED",
          status: p.connection?.status ?? "disconnected"
        })),
        voice,
        voiceScope: "SERVER_TRANSCRIPTION_CAPABILITIES_NOT_BROWSER_PREFERENCES",
        appearance: {
          theme: null,
          themeStatus: "BROWSER_LOCAL_NOT_OBSERVED",
          layoutColumns: room?.paneLayoutColumns ?? null,
          layoutMode: layout?.mode ?? null
        },
        diagnostics: {
          appDebugEnabled: process.env.APP_DEBUG === "1",
          hasBrowserEvidence: Boolean(config.browserEvidenceTargetOrigin)
        }
      };
    }
    return {supported:false,section:input.section};
  }
  return { inspectControlSection };
}
