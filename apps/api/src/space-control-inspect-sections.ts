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
import { getLiveAudioProvidersStatus, getLocalVoiceProviderStatus } from "./voice-transcription.js";

type SpaceControlInspectSectionDeps = {
  store: SpaceStore;
  config: SpaceApiConfig;
  controlUser: (id: string) => Promise<unknown>;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  toolbarUsageProvider: () => Promise<CodexUsageAccountList>;
  readCliVpnApplications: ReturnType<typeof createCliVpnApplicationsReader>;
  healthMonitor: Pick<SystemHealthMonitor, "snapshot">;
  taskTitleRepository: { getSettings(): Promise<unknown> };
  spaceControl: { layout(roomId: string): Promise<unknown> };
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
    await controlUser(actor.id);
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
      const transcription = buildVoiceTranscriptionSettings(config);
      const providers = await getLiveAudioProvidersStatus(config).catch(() => ({ providers: [] }));
      const local = await getLocalVoiceProviderStatus(config).catch(() => ({ status: "unavailable" }));
      return { transcription, providers, local };
    }
    if(input.section==="LINKS"){
      const query = { page: Math.floor(input.offset / input.limit) + 1, pageSize: input.limit, isQuick: undefined };
      const owner = await store.upsertUser(actor as any);
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
      const owner = await store.upsertUser(actor as any);
      const result = await store.listTaskItems(owner.id, query);
      return {
        items: result.items,
        total: result.total,
        page: query.page,
        pageSize: query.pageSize
      };
    }
    if(input.section==="SETTINGS"){
      let cli: any[] = [];
      try { cli = await store.listCliRuntimeSettings(); } catch {}
      let providers: any = null;
      try { providers = await store.getProviderSettings(); } catch {}
      let tools: any[] = [];
      try { tools = await store.listAgentToolAssignments(); } catch {}
      let taskTitles: any = null;
      try { taskTitles = await taskTitleRepository.getSettings(); } catch {}
      let plugins: any[] = [];
      try { plugins = await pluginsService.getPlugins(); } catch {}
      let voice: any = null;
      try { voice = buildVoiceTranscriptionSettings(config); } catch {}
      let room: any = null;
      if (input.roomId) { try { room = await store.getRoom(input.roomId); } catch {} }
      let layout: any = null;
      if (input.roomId) { try { layout = await spaceControl.layout(input.roomId); } catch {} }

      const sanitizedProviders = providers ? {
        defaultProviderId: providers.defaultProviderId,
        providers: (providers.providers || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          configured: Boolean(p.hasKey || p.configured || p.apiKeyConfigured),
          models: p.models ?? []
        }))
      } : null;

      return {
        cli,
        providers: sanitizedProviders,
        tools,
        taskTitles,
        plugins: plugins.map((p: any) => ({
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
          layoutMode: (layout as any)?.mode ?? null
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
