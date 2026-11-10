import { PANE_TYPES, type AntigravityUsageAccountList, type Pane, type PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { fetchOpenCodeCurrentModel, type OpenCodeServerControl } from "@space/opencode-control";
import type { CliTerminalManager } from "./cli-terminal.js";
import { findRuntime, type createCliRuntimeRegistryCache } from "./cli-runtimes.js";
import type { createNativeCliModelCatalog } from "./cli-native-model-picker.js";
import { isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import { verifyGeminiPaneSession } from "./gemini-session-verification.js";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import type { YouTubePlaybackStore } from "./youtube-playback-state.js";

interface ControlPaneReadersDependencies {
  store: Pick<SpaceStore, "getRoom" | "getActivePaneCliSession" | "listPaneCliSessions">;
  roomPaneCommands: Pick<ReturnType<typeof createRoomPaneCommands>, "catalog">;
  cliTerminalManager: Pick<CliTerminalManager, "activeSessionPids">;
  youtubePlaybackStore: Pick<YouTubePlaybackStore, "getByPaneId">;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createCliRuntimeRegistryCache>, "read">;
  loadNativeCliModels: ReturnType<typeof createNativeCliModelCatalog>;
  resolveOpenCodeServerControl: (session: PaneCliSession) => Promise<OpenCodeServerControl>;
}

export function createControlPaneReaders({
  store, roomPaneCommands, cliTerminalManager, youtubePlaybackStore, antigravityUsageProvider,
  cliRuntimeRegistryCache, loadNativeCliModels, resolveOpenCodeServerControl
}: ControlPaneReadersDependencies) {
  const paneStateCache = new Map<string, { expires: number; data: Record<string, unknown> | null }>();
  return {
    describePaneTypes: async (roomId?: string) => {
      const entries = await roomPaneCommands.catalog();
      const types = PANE_TYPES.map((def) => {
        const entry = entries.find((e) => e.definition.typeId === def.typeId);
        return {
          typeId: def.typeId,
          label: def.label,
          kind: def.mode === "TERMINAL" ? `CLI:${(def as { runtimeId?: string }).runtimeId ?? def.typeId}` : def.mode,
          countsKey: def.typeId,
          available: entry?.available ?? false,
          ...(entry?.available ? {} : { reason: entry?.reason ?? "Unavailable." })
        };
      });
      let roomCap: number | null = null;
      if (roomId) {
        try { roomCap = (await store.getRoom(roomId)).paneCap; } catch {}
      }
      return { types, roomCap };
    },
    inspectPaneState: async(pane: Pane) => {
      const cached = paneStateCache.get(pane.id);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      const doInspect = async (): Promise<Record<string, unknown> | null> => {
        if (pane.mode === "YOUTUBE") {
          try {
            const pb = await youtubePlaybackStore.getByPaneId(pane.id);
            const effectiveTitle = pb?.title || (pane.title && !/^YouTube( \d+)?$/i.test(pane.title) ? pane.title : null);
            if (effectiveTitle || pb?.videoId) {
              return {
                mediaTitle: effectiveTitle,
                mediaVideoId: pb?.videoId || null,
                mediaSeconds: pb?.seconds || 0
              };
            }
          } catch {}
          return null;
        }
        if (pane.mode === "TERMINAL" && pane.terminalRuntimeId === "cli:gemini") {
          const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
          const pids = session ? await cliTerminalManager.activeSessionPids([session]).catch(() => null) : null;
          const rootPid = session ? (pids?.get(session.sessionId) ?? null) : null;
          const usageList = await Promise.race([
            antigravityUsageProvider(),
            new Promise<{ data: any[] }>((r) => setTimeout(() => r({ data: [] }), 1500))
          ]).catch(() => ({ data: [] }));
          let catalog: Array<{ id: string; displayName: string }> = [];
          const runtime = findRuntime(await cliRuntimeRegistryCache.read(), pane.terminalRuntimeId);
          if (runtime?.detectedCommandPath) {
            catalog = await Promise.race([
              loadNativeCliModels(runtime.detectedCommandPath, session?.accountProfileId),
              new Promise<Array<{ id: string; displayName: string }>>((r) => setTimeout(() => r([]), 2000))
            ]).catch(() => []);
          }
          const fallbackVerification = {
            configuredModelId: session?.modelId ?? pane.modelId ?? null,
            effectiveModelId: null,
            modelVerificationStatus: "UNVERIFIED",
            accountProfileId: session?.accountProfileId ?? "main",
            accountEmail: null,
            accountVerificationStatus: "UNVERIFIED",
            verificationEvidence: {}
          };
          const verified = await Promise.race([
            verifyGeminiPaneSession({
              pane,
              session,
              rootPid,
              catalog,
              usageAccounts: usageList.data
            }),
            new Promise<typeof fallbackVerification>((r) => setTimeout(() => r(fallbackVerification), 2000))
          ]).catch(() => fallbackVerification);
          return {
            configuredModelId: verified.configuredModelId,
            effectiveModelId: verified.effectiveModelId,
            modelVerificationStatus: verified.modelVerificationStatus,
            accountProfileId: verified.accountProfileId,
            accountEmail: verified.accountEmail,
            accountVerificationStatus: verified.accountVerificationStatus,
            verificationEvidence: verified.verificationEvidence as unknown as Record<string, unknown>
          };
        }
        if (pane.mode === "TERMINAL" && isOpenCodeDirectParityRuntime(pane.terminalRuntimeId)) {
          const session = await store.getActivePaneCliSession(pane.id) ?? (await store.listPaneCliSessions(pane.id, 1))[0] ?? null;
          if (session) {
            const control = await resolveOpenCodeServerControl(session).catch(() => null);
            if (control) {
              const currentModel = await fetchOpenCodeCurrentModel(control, control.nativeSessionId).catch(() => null);
              if (currentModel) {
                const liveModelId = `${currentModel.providerID}/${currentModel.id}`;
                return {
                  configuredModelId: session.modelId ?? pane.modelId ?? liveModelId,
                  effectiveModelId: liveModelId,
                  modelVerificationStatus: "VERIFIED"
                };
              }
            }
          }
          return {
            configuredModelId: session?.modelId ?? pane.modelId ?? null,
            effectiveModelId: null,
            modelVerificationStatus: "UNKNOWN"
          };
        }
        return null;
      };
      const data = await Promise.race([
        doInspect(),
        new Promise<null>((r) => setTimeout(() => r(null), 2500))
      ]).catch(() => null);
      paneStateCache.set(pane.id, { expires: Date.now() + 15_000, data });
      return data;
    },
  };
}
