import { createHash } from "node:crypto";
import {
  CLI_PANE_TYPES, PANE_TYPES, PANE_CATALOG_VERSION, roomPaneCommandSchema, isAgentRuntimeReady,
  type AgentRuntimeRegistry, type CreatePaneInput, type PaneBatchClaim,
  type PaneType, type RoomPaneBatchItem, type RoomPaneCommand
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { WorktreeService } from "./worktrees/worktree-service.js";
import { defaultWorktreeBaseBranch } from "./worktrees/default-base-branch.js";

export interface SkippedPaneType { typeId: string; label: string; reason: string }

/**
 * Job Copilot runs long, tool-heavy application loops; Claude Code (native MCP, skills, account
 * profiles) is its default agent when ready. Otherwise the first ready CLI in catalog order.
 */
export const JOB_APPLY_PREFERRED_RUNTIME_ID = "cli:claude";
/** Copilot panes (Job, Mail, Marketing, Freelance), Design and App Studio panes run their agent in a CLI session of the pane. */
export function isCopilotPaneMode(mode: string): mode is "JOB_APPLY" | "MAIL_COPILOT" | "MARKETING_COPILOT" | "FREELANCE_COPILOT" | "DESIGN" | "APP_STUDIO" {
  return mode === "JOB_APPLY" || mode === "MAIL_COPILOT" || mode === "MARKETING_COPILOT" || mode === "FREELANCE_COPILOT" || mode === "DESIGN" || mode === "APP_STUDIO";
}
export function defaultJobApplyRuntimeId(readyCliRuntimeIds: readonly string[]): string | undefined {
  return readyCliRuntimeIds.includes(JOB_APPLY_PREFERRED_RUNTIME_ID) ? JOB_APPLY_PREFERRED_RUNTIME_ID : readyCliRuntimeIds[0];
}

export interface RoomPaneCatalogEntry {
  definition: PaneType;
  available: boolean;
  reason: string | null;
  // Zero until the adapter supplies measured, account/configuration-bound reservations.
  preparedCount: number;
}
export function createRoomPaneCommands(options: {
  store: SpaceStore;
  discover(): Promise<AgentRuntimeRegistry>;
  enabledRuntimeIds(): Promise<string[]>;
  harnessAvailable(): Promise<boolean>;
  checkGeminiQuota?(): Promise<{ allowed: boolean; reason?: string }>;
  worktreeService?: WorktreeService;
}) {
  async function catalog(opts?: { needGemini?: boolean; needHarness?: boolean }): Promise<RoomPaneCatalogEntry[]> {
    const needGemini = opts?.needGemini ?? true;
    const needHarness = opts?.needHarness ?? true;
    const [registry, enabledIds, harness, geminiQuota] = await Promise.all([
      options.discover(), options.enabledRuntimeIds(),
      needHarness ? options.harnessAvailable() : Promise.resolve(true),
      needGemini && options.checkGeminiQuota ? options.checkGeminiQuota().catch(() => ({ allowed: true })) : Promise.resolve({ allowed: true })
    ]);
    const runtimes = new Map(registry.data.map(runtime => [runtime.id, runtime]));
    const enabled = new Set(enabledIds);
    const readyCliRuntimeIds = CLI_PANE_TYPES.map(type => type.id).filter(id => {
      const runtime = runtimes.get(id);
      return enabled.has(id) && !!runtime?.capabilities.includes("CLI") && isAgentRuntimeReady(runtime);
    });
    return PANE_TYPES.map(definition => {
      let reason: string | null = null;
      if (definition.runtimeId) {
        const runtime = runtimes.get(definition.runtimeId);
        if (!enabled.has(definition.runtimeId)) reason = "Runtime is disabled.";
        else if (!runtime?.capabilities.includes("CLI") || !isAgentRuntimeReady(runtime))
          reason = runtime?.statusReason || "Runtime is not available.";
        else if (definition.typeId === "gemini" && geminiQuota && !geminiQuota.allowed)
          reason = ("reason" in geminiQuota && geminiQuota.reason) ? geminiQuota.reason : "Google account quota is exhausted.";
      } else if (definition.mode === "CHAT" && !enabled.has("cli:codex")) reason = "Chat runtime is disabled.";
      else if (definition.mode === "HARNESS" && !harness) reason = "DeepSeek Harness is unavailable.";
      else if (isCopilotPaneMode(definition.mode) && readyCliRuntimeIds.length === 0) reason = "No AI CLI runtime is available.";
      return { definition, available: reason === null, reason, preparedCount: 0 };
    });
  }

  async function resolve(roomId: string, items: RoomPaneBatchItem[]): Promise<CreatePaneInput[]> {
    const needGemini = items.some((item) => (item.mode === "TERMINAL" || isCopilotPaneMode(item.mode)) && "terminalRuntimeId" in item && item.terminalRuntimeId === "cli:gemini");
    const needHarness = items.some((item) => item.mode === "HARNESS");
    const entries = await catalog({ needGemini, needHarness });
    const readyCliRuntimeIds: string[] = entries.flatMap(({ definition, available }) =>
      definition.mode === "TERMINAL" && available && definition.runtimeId ? [definition.runtimeId] : []);
    let roomCwd = "/etc";
    try {
      const targetRoom = await options.store.getRoom(roomId);
      if (targetRoom?.projectPath) {
        roomCwd = targetRoom.projectPath;
      }
    } catch {
      // Default to /etc if room not found
    }
    // Validate the complete catalog selection before provisioning anything.
    const result: CreatePaneInput[] = items.map(item => {
      const entry = entries.find(({ definition }) => definition.mode === item.mode &&
        (item.mode !== "TERMINAL" || definition.runtimeId === item.terminalRuntimeId));
      if (!entry) throw new SpaceConflictError("Pane type is not in the room command catalog.");
      if (!entry.available) throw new SpaceConflictError(`${entry.definition.label}: ${entry.reason}`);
      if (isCopilotPaneMode(item.mode) && "terminalRuntimeId" in item && item.terminalRuntimeId && !readyCliRuntimeIds.includes(item.terminalRuntimeId)) {
        throw new SpaceConflictError(`${entry.definition.label}: ${item.terminalRuntimeId} is not available.`);
      }

      return {
        roomId,
        title: item.mode === "TERMINAL"
          ? `${entry.definition.label} CLI` : item.mode === "HARNESS" ? "Harness" : entry.definition.label,
        mode: item.mode,
        ...(item.mode === "TERMINAL" ? { terminalRuntimeId: item.terminalRuntimeId, cwd: roomCwd } : {}),
        // No cwd: the agent gets a managed per-session workspace with the Space bootstrap. Design and App Studio default to Claude Code too.
        ...(item.mode === "JOB_APPLY" || item.mode === "MAIL_COPILOT" || item.mode === "MARKETING_COPILOT" || item.mode === "FREELANCE_COPILOT" || item.mode === "DESIGN" || item.mode === "APP_STUDIO" ? { terminalRuntimeId: item.terminalRuntimeId ?? defaultJobApplyRuntimeId(readyCliRuntimeIds) } : {}),
        ...(item.mode === "FILES" || item.mode === "DATABASES" ? { cwd: roomCwd !== "/etc" ? roomCwd : undefined } : {}),
        ...(item.mode === "VNC" && item.vncTarget ? { vncTarget: item.vncTarget } : {})
      };
    });
    // Checkout dominates large cold batches. Keep disk/process pressure bounded
    // while assigning completed worktrees to their original pane positions.
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const index = nextIndex++;
        const item = items[index];
        if (!item) return;
        if ((item.mode !== "TERMINAL" && item.mode !== "T3CODE") || !item.useWorktree || !options.worktreeService) continue;
        try {
          const repoPath = roomCwd && roomCwd !== "/etc" ? roomCwd : "/opt/spaceapp";
          const wt = await options.worktreeService.createWorktree({
            repoPath,
            roomId,
            branchName: item.mode === "TERMINAL" ? item.worktreeBranch : undefined,
            baseBranch: defaultWorktreeBaseBranch(repoPath),
            linkModules: true
          });
          result[index]!.cwd = wt.worktreePath;
        } catch {
          // Preserve the existing room-directory fallback when checkout fails.
        }
      }
    }));
    return result;
  }

  async function execute(roomId: string, actorId: string, raw: RoomPaneCommand, traceId: string) {
    const command = roomPaneCommandSchema.parse(raw);
    if (!actorId) throw new SpaceConflictError("Authenticated command actor is required.");
    // Canonicalize counts; property order, trace IDs and mutable defaults are not the intent.
    const canonical = JSON.stringify({ catalogVersion: command.catalogVersion, type: command.action.type,
      counts: Object.entries(command.action.counts).sort(([left], [right]) => left.localeCompare(right)) });
    const claim: PaneBatchClaim = { actorId, requestId: command.requestId,
      payloadHash: createHash("sha256").update(canonical).digest("hex") };
    const previous = await options.store.getPaneBatchResult(roomId, claim);
    if (previous) return { roomId, requestId: command.requestId, data: previous };
    const items = PANE_TYPES.flatMap(definition => Array.from({ length: command.action.counts[definition.typeId] ?? 0 },
      (): RoomPaneBatchItem => definition.mode === "TERMINAL"
        ? { mode: "TERMINAL", terminalRuntimeId: definition.runtimeId }
        : { mode: definition.mode }));
    const inputs = await resolve(roomId, items);
    const panes = await options.store.createPanes(inputs, traceId, claim);
    return { roomId, requestId: command.requestId, data: panes, skipped: [] as SkippedPaneType[] };
  }
  return { catalog, resolve, execute, version: PANE_CATALOG_VERSION };
}
