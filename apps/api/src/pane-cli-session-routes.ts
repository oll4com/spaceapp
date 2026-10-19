import { mayCreateCliSessionDirectory } from "./project-paths.js";
import { WORKTREES_ROOT } from "./worktrees/worktree-service.js";
import type { CliPaneReopener } from "./cli-pane-reopen.js";
import type {} from "./request-context.js";
import { execFile } from "./safe-child-process.js";
import { existsSync } from "node:fs";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { type CliAccountBalancer, isCliBalancedRuntimeId } from "./cli-account-balancer.js";
import {
  createPaneCliSessionRequestSchema, type Pane, paneCliInterruptInputSchema, type PaneCliSession,
  paneCliUploadMaxBytes, paneCliUploadMaxCount, paneCliUploadResponseSchema, paneCliUploadSourceSchema,
  reasoningEffortSchema, resumePaneCliSessionRequestSchema, type ResumePaneCliSessionResponse
} from "@space/contracts";
import {
  abortOpenCodeSession, fetchOpenCodeSessionIsTurnActive, type OpenCodeServerControl
} from "@space/opencode-control";
import {
  makeSpaceId, nowIso, pathIsMissing, redactMemoryText, SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError,
  SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import { buildCliAgentBootstrapMarkdown, buildJobCopilotPersonaMarkdown, buildMailCopilotPersonaMarkdown, buildMarketingCopilotPersonaMarkdown, buildFreelanceCopilotPersonaMarkdown, buildDesignPersonaMarkdown } from "./agent-bootstrap.js";
import { pathInside, safeCliFilename, safeOriginalFilename, safeStorageSegment } from "./artifact-storage.js";
import { safeBrowserObservationUrl } from "./browser-observation.js";
import { claudeNativeSessionIdPattern, loadClaudeNativeTurns } from "./claude-native-turns.js";
import { isCliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import { parseCliHttpControlAuthority } from "./cli-http-control.js";
import {
  isCodexDirectParityRuntime, isDirectOperatorParityRuntime, isLegacyCodexCliCwd, isOpenCodeDirectParityRuntime,
  publicRoomWorkspacePath,
  resolveDirectOperatorParityCwd
} from "./cli-parity.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import {
  type createAgentRuntimeRegistryCache, discoverAgentRuntimes, findRuntime, isCliRuntimeTerminalLaunchable
} from "./cli-runtimes.js";
import { type CliTerminalManager, resolveCodexCliLaunchSettings, supportsNativeCliResume } from "./cli-terminal.js";
import type { CodexCliModeDefaultsService } from "./codex-cli-mode-defaults.js";
import type { SpaceApiConfig } from "./config.js";
import {
  clearGeminiPaneConversation, geminiNativeConversationIdPattern, readGeminiNativeConversationIdFromProcessTree,
  readGeminiPaneConversation, writeGeminiPaneConversation
} from "./gemini-native-session.js";
import { sendApiError } from "./http-errors.js";
import { withPersistedUpload, withStagedUploads } from "./multipart-upload.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import {
  assertAgentPaneCompatible, assertCliPaneCompatible, assertNormalCliSession, getPaneById
} from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import type { SpaceAgentAdapter } from "./space-agent.js";
import type { SpaceControl } from "./space-control.js";
import { isAllowedImageMime, sniffImageMime } from "./upload-media.js";
import { recordUploadedArtifact } from "./upload-record.js";
import { descriptorPath, openWorkspacePath } from "./workspace-filesystem.js";

const execFileAsync = promisify(execFile);

const cliUploadsQuerySchema = z.object({
  source: paneCliUploadSourceSchema.default("USER_UPLOAD")
});

// Reasonix CLI (Space's DeepSeek deepseek-vscode-parity runtime) accepts image
// input only when a pasted reference matches its `.reasonix/attachments`
// clipboard pattern. We mirror image uploads there so the pane passes them as
// real image attachments instead of a plain path.
const REASONIX_CLI_RUNTIME_ID = "cli:deepseek";

const clipboardDebugSeveritySchema = z.enum(["info", "good", "bad"]);

const cliClipboardDebugEntrySchema = z.object({
  severity: clipboardDebugSeveritySchema,
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(2_000),
  at: z.string().trim().min(1).max(80)
});

const cliClipboardDebugInputSchema = z.object({
  severity: clipboardDebugSeveritySchema,
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().min(1).max(4_000),
  trace: z.array(cliClipboardDebugEntrySchema).max(12).default([]),
  sessionId: z.string().trim().min(1).max(200).nullable().optional(),
  url: z.string().trim().max(1_000).nullable().optional(),
  userAgent: z.string().trim().max(600).nullable().optional(),
  activeElement: z.string().trim().max(200).nullable().optional(),
  documentHasFocus: z.boolean().optional(),
  visibilityState: z.string().trim().max(40).nullable().optional(),
  clipboardApi: z
    .object({
      read: z.boolean(),
      readText: z.boolean(),
      write: z.boolean(),
      writeText: z.boolean()
    })
    .optional()
});

function shellQuotePath(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const CLI_UPLOAD_FILE_MODE = 0o644;

const CLI_UPLOAD_TRAVERSE_MODE_BITS = 0o001;

function buildCliUploadStorage(input: {
  artifactRoot: string;
  roomId: string;
  paneId: string;
  sessionId: string;
  originalFilename: string;
}): { filePath: string; storageUri: string; storedFilename: string } {
  const day = new Date().toISOString().slice(0, 10);
  const uploadId = makeSpaceId("upload");
  const roomSegment = safeStorageSegment(input.roomId);
  const paneSegment = safeStorageSegment(input.paneId);
  const sessionSegment = safeStorageSegment(input.sessionId);
  const storedFilename = `${safeStorageSegment(uploadId)}-${safeCliFilename(input.originalFilename)}`;
  return {
    filePath: join(input.artifactRoot, "cli-uploads", roomSegment, paneSegment, sessionSegment, day, storedFilename),
    storageUri:
      `space-artifact://cli-uploads/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.paneId)}/` +
      `${encodeURIComponent(input.sessionId)}/${day}/${encodeURIComponent(storedFilename)}`,
    storedFilename
  };
}

/**
 * Reasonix resolves `@.reasonix/attachments/...` references relative to the
 * session workspace root (`<cwd>/.reasonix/attachments`). For image uploads on
 * a Reasonix (cli:deepseek) pane we write a copy there with the exact
 * clipboard-file naming pattern Reasonix auto-attaches, and return the
 * `@.reasonix/attachments/<name>` reference as the terminal path so the model
 * receives the image as image input (not as a plain path with a title).
 */
function buildReasonixAttachmentUpload(input: {
  workspaceRoot: string;
  mimeType: string;
}): { terminalPath: string; absoluteDir: string; absolutePath: string } {
  const extension = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType === "image/webp" ? "webp" : "png";
  const now = new Date();
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const millis = pad(now.getMilliseconds(), 3);
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `clipboard-${timestamp}.${millis}.${extension}`;
  const absoluteDir = join(input.workspaceRoot, ".reasonix", "attachments");
  const absolutePath = join(absoluteDir, filename);
  return { terminalPath: `@.reasonix/attachments/${filename}`, absoluteDir, absolutePath };
}

async function ensureMinimumModeBits(path: string, modeBits: number): Promise<void> {
  const currentMode = (await stat(path)).mode & 0o777;
  const nextMode = currentMode | modeBits;
  if (nextMode !== currentMode) {
    await chmod(path, nextMode);
  }
}

async function ensureCliUploadPathReadable(input: { artifactRoot: string; filePath: string }): Promise<void> {
  const uploadRoot = join(input.artifactRoot, "cli-uploads");
  const targetDir = dirname(input.filePath);
  if (!pathInside(uploadRoot, targetDir)) {
    throw new Error("CLI upload path escaped cli-uploads root");
  }

  const grantTraverse = async (directory: string) => {
    const handle = await openWorkspacePath(input.artifactRoot, directory, true);
    try { await ensureMinimumModeBits(descriptorPath(handle), CLI_UPLOAD_TRAVERSE_MODE_BITS); }
    finally { await handle.close(); }
  };
  await grantTraverse(input.artifactRoot);
  for (let currentDir = targetDir; pathInside(uploadRoot, currentDir); currentDir = dirname(currentDir)) {
    await grantTraverse(currentDir);
    if (resolve(currentDir) === resolve(uploadRoot)) break;
  }
}

function buildCliWorkspacePath(input: { workspaceRoot: string; roomId: string; paneId: string; sessionId: string }): string {
  return join(
    input.workspaceRoot,
    safeStorageSegment(input.roomId),
    safeStorageSegment(input.paneId),
    safeStorageSegment(input.sessionId)
  );
}

async function writeCliWorkspaceBootstrap(
  sessionCwd: string,
  input: { roomId: string; paneId: string; sessionId: string; runtimeId: string; paneMode?: Pane["mode"] | null }
): Promise<void> {
  await writeFile(
    join(sessionCwd, "AGENTS.md"),
    buildCliAgentBootstrapMarkdown({
      roomId: input.roomId,
      paneId: input.paneId,
      cliSessionId: input.sessionId,
      runtimeId: input.runtimeId,
      paneMode: input.paneMode ?? null
    }),
    { encoding: "utf8", mode: 0o640 }
  );
  // Copilot panes also get their persona as CLAUDE.md (Claude Code reads it natively; others through AGENTS.md).
  if (input.paneMode === "JOB_APPLY") {
    await writeFile(
      join(sessionCwd, "CLAUDE.md"),
      buildJobCopilotPersonaMarkdown({ roomId: input.roomId, paneId: input.paneId, runtimeId: input.runtimeId }),
      { encoding: "utf8", mode: 0o640 }
    );
  } else if (input.paneMode === "MAIL_COPILOT") {
    await writeFile(
      join(sessionCwd, "CLAUDE.md"),
      buildMailCopilotPersonaMarkdown({ roomId: input.roomId, paneId: input.paneId, runtimeId: input.runtimeId }),
      { encoding: "utf8", mode: 0o640 }
    );
  } else if (input.paneMode === "MARKETING_COPILOT") {
    await writeFile(
      join(sessionCwd, "CLAUDE.md"),
      buildMarketingCopilotPersonaMarkdown({ roomId: input.roomId, paneId: input.paneId, runtimeId: input.runtimeId }),
      { encoding: "utf8", mode: 0o640 }
    );
  } else if (input.paneMode === "FREELANCE_COPILOT") {
    await writeFile(
      join(sessionCwd, "CLAUDE.md"),
      buildFreelanceCopilotPersonaMarkdown({ roomId: input.roomId, paneId: input.paneId, runtimeId: input.runtimeId }),
      { encoding: "utf8", mode: 0o640 }
    );
  } else if (input.paneMode === "DESIGN") {
    await writeFile(
      join(sessionCwd, "CLAUDE.md"),
      buildDesignPersonaMarkdown({ roomId: input.roomId, paneId: input.paneId, runtimeId: input.runtimeId }),
      { encoding: "utf8", mode: 0o640 }
    );
  }
}

function shouldUseManagedCliWorkspace(cwd: string | null | undefined, workspaceRoot: string): boolean {
  if (!cwd) return true;
  const resolved = resolve(cwd);
  return resolved === "/opt/spaceapp" || resolved === resolve(workspaceRoot);
}

function isLegacyCliWorkspace(cwd: string | null | undefined, workspaceRoot: string, runtimeId: string): boolean {
  if (isDirectOperatorParityRuntime(runtimeId)) {
    return isLegacyCodexCliCwd(cwd, workspaceRoot);
  }
  return !cwd || resolve(cwd) === "/opt/spaceapp";
}

/**
 * Pane CLI session start (serialized per pane), resume, uploads, clipboard debug, interrupt, turn abort and the
 * pane agent session view; moved verbatim, the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerPaneCliSessionRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  deletingCliAccountProfileKeys: Set<string>;
  cliAccountProfileKey: (runtimeId: string, profileId: string) => string;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  codexCliModeDefaultsService: CodexCliModeDefaultsService;
  spaceAgentAdapter: SpaceAgentAdapter;
  cliRuntimeRegistryCache: ReturnType<typeof createAgentRuntimeRegistryCache>;
  cliTerminalManager: CliTerminalManager;
  assertCliHttpMutationControl: (request: FastifyRequest, session: PaneCliSession) => Promise<void>;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  resolveOpenCodeServerControl: (session: PaneCliSession) => Promise<OpenCodeServerControl>;
  resumePaneCliTask: (
    pane: Pane, input: { taskId?: string; threadId?: string }, traceId: string, request?: FastifyRequest, requireNative?: boolean
  ) => Promise<ResumePaneCliSessionResponse>;
  spaceControl: SpaceControl;
  assertRootAdmin: (request: FastifyRequest, runtimeId: string | null | undefined) => void;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  cliAccountBalancer?: Pick<CliAccountBalancer, "pick" | "isAuto" | "setAuto">;
  /** A pending resume (reopened pane, new Job Copilot pane) finishes before a fresh session can start. */
  cliPaneReopener?: Pick<CliPaneReopener, "settled">;
  /** Multi-user: true when the pane's CLI runs in its user's own container (cli-user-hosts.ts). */
  onUserCliHost?: (paneId: string) => Promise<boolean>;
}) {
  const { config, deletingCliAccountProfileKeys, cliAccountProfileKey, store, eventBus, codexCliModeDefaultsService,
    spaceAgentAdapter, cliRuntimeRegistryCache, cliTerminalManager, assertCliHttpMutationControl,
    cliRuntimeVisibility, resolveOpenCodeServerControl, resumePaneCliTask, spaceControl, assertRootAdmin,
    assertPaneCliRuntimeEnabled, routeOptions: defaultRouteRateLimitOptions, cliAccountBalancer, cliPaneReopener, onUserCliHost } = options;
  const paneCliSessionStartTails = new Map<string, Promise<void>>();
  function serializePaneCliSessionStart<T>(
    operation: (request: FastifyRequest) => Promise<T>
  ): (request: FastifyRequest) => Promise<T> {
    return async (request) => {
      const paneId = parseQuery(idParamSchema, request.params).id;
      const previous = paneCliSessionStartTails.get(paneId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => current);
      paneCliSessionStartTails.set(paneId, tail);
      await previous;
      try {
        return await operation(request);
      } finally {
        release();
        if (paneCliSessionStartTails.get(paneId) === tail) paneCliSessionStartTails.delete(paneId);
      }
    };
  }
  /** Tells a balanced CLI's pane whether it is on Auto, so its account picker shows Auto rather than the account Space chose. */
  function withAccountMode<T extends { session: PaneCliSession }>(
    operation: (request: FastifyRequest) => Promise<T>
  ): (request: FastifyRequest) => Promise<T | (T & { accountMode: "AUTO" | "PROFILE" })> {
    return async (request) => {
      const response = await operation(request);
      if (!cliAccountBalancer || !isCliBalancedRuntimeId(response.session.runtimeId)) return response;
      return { ...response, accountMode: await cliAccountBalancer.isAuto(response.session.paneId) ? "AUTO" : "PROFILE" };
    };
  }
  app.post("/api/panes/:id/cli/session", defaultRouteRateLimitOptions, serializePaneCliSessionStart(withAccountMode(async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(createPaneCliSessionRequestSchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    assertRootAdmin(request, pane.terminalRuntimeId);
    assertRootAdmin(request, input.runtimeId);
    await cliRuntimeVisibility.assertEnabled(input.runtimeId);
    if (pane.terminalRuntimeId && input.runtimeId !== pane.terminalRuntimeId) {
      throw new SpaceConflictError(`Terminal pane requires runtime ${pane.terminalRuntimeId}.`);
    }
    await cliPaneReopener?.settled(pane.id);
    const active = await store.getActivePaneCliSession(pane.id);
    if (input.accountMode === "AUTO") {
      if (!cliAccountBalancer || !isCliBalancedRuntimeId(input.runtimeId)) {
        throw new SpaceConflictError(`Runtime ${input.runtimeId} does not balance accounts.`);
      }
      // A running session keeps its account (Space moves an Auto pane on when that account runs out); a new or
      // restarted session starts on the account with the most room.
      const running = active && active.purpose === "NORMAL" && active.runtimeId === input.runtimeId && active.status !== "EXITED" &&
        active.status !== "ERROR" && !input.forceRestart;
      const profileId = running ? active.accountProfileId ?? "main" : await cliAccountBalancer.pick(input.runtimeId);
      if (!profileId) {
        throw new SpaceConflictError("Every account of this CLI is out of quota or signed out. Choose an account for this pane.");
      }
      input.accountProfileId = profileId;
      await cliAccountBalancer.setAuto(pane.id, input.runtimeId);
    } else if (cliAccountBalancer && input.accountProfileId !== undefined) {
      // Naming an account for the pane ends Auto.
      await cliAccountBalancer.setAuto(pane.id, null);
    }
    const requestedProfileForAttach = isCliAccountProfileRuntimeId(input.runtimeId) && input.accountProfileId !== "main"
      ? input.accountProfileId ?? null : null;
    const attachingExisting = active?.purpose === "NORMAL" && active.isActive &&
      !input.forceRestart && !input.resume && active.runtimeId === input.runtimeId &&
      active.accountProfileId === requestedProfileForAttach &&
      active.status !== "EXITED" && active.status !== "ERROR";
    let registry = await cliRuntimeRegistryCache.readStaleWhileRefreshing();
    let runtime = findRuntime(registry, input.runtimeId);
    if (!runtime) {
      registry = await discoverAgentRuntimes(config);
      runtime = findRuntime(registry, input.runtimeId);
    }
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${input.runtimeId} was not found.`);
    }
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    if (!isCliRuntimeTerminalLaunchable(runtime)) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, {
        runtimeId: runtime.id,
        status: runtime.status
      });
    }
    if (!isCliAccountProfileRuntimeId(runtime.id) && input.accountProfileId !== undefined && input.accountProfileId !== null) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support account profiles.`);
    }
    if (isCliAccountProfileRuntimeId(runtime.id) && input.accountProfileId) {
      if (deletingCliAccountProfileKeys.has(cliAccountProfileKey(runtime.id, input.accountProfileId))) {
        throw new SpaceConflictError(`Account profile ${input.accountProfileId} is being removed.`);
      }
      const profile = await store.getCliAccountProfile(runtime.id, input.accountProfileId);
      if (!profile) throw new SpaceNotFoundError(`CLI account profile ${runtime.id}/${input.accountProfileId} was not found.`);
    }
    const requestedAccountProfileId = isCliAccountProfileRuntimeId(runtime.id) && input.accountProfileId !== "main"
      ? input.accountProfileId ?? null
      : null;
    if (input.resume && (!input.forceRestart || !supportsNativeCliResume(runtime.id))) {
      throw new SpaceConflictError(
        input.forceRestart
          ? `Runtime ${runtime.id} does not support native task resume.`
          : "Native task resume requires an explicit CLI session restart."
      );
    }

    if (active?.purpose === "LOGIN") {
      throw new SpaceConflictError("Cancel or complete CLI login before starting a normal CLI session in this pane.");
    }
    const rejoinableSession =
      active &&
      !input.forceRestart &&
      !input.resume &&
      active.runtimeId === runtime.id &&
      active.accountProfileId === requestedAccountProfileId &&
      active.status !== "EXITED" &&
      active.status !== "ERROR"
        ? active
        : null;
    if (rejoinableSession) {
      // A rejoined Codex session keeps running with its own settings; repair stale pane labels the
      // same way a reused session is repaired below.
      const rejoinedCodexReasoningEffort = isCodexDirectParityRuntime(runtime.id)
        ? reasoningEffortSchema.safeParse(rejoinableSession.reasoningEffort).data
        : undefined;
      if (
        rejoinedCodexReasoningEffort &&
        (pane.modelId !== rejoinableSession.modelId || pane.reasoningEffort !== rejoinedCodexReasoningEffort)
      ) {
        await store.updatePane(
          pane.id,
          {
            modelId: rejoinableSession.modelId,
            reasoningEffort: rejoinedCodexReasoningEffort
          },
          request.requestIdForSpace
        );
      }
      await recordAudit(store, request, {
        action: "pane.cli.session",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          runtimeId: runtime.id,
          providerId: runtime.providerId,
          agentId: runtime.agentId,
          resume: false,
          reused: true
        }
      });
      return buildPaneCliSessionResponse({
        store,
        runtime,
        sessionId: rejoinableSession.sessionId,
        includeWebsocket: true,
        includeTranscript: input.includeTranscript,
        tokenTtlMs: config.cliTokenTtlMs,
        issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
      });
    }
    // Reissuing an existing session above is read-only. Replacement requires the current controller.
    if (active) await assertCliHttpMutationControl(request, active);
    let requestedCwd = input.cwd ?? pane.cwd ?? null;
    if (!requestedCwd || requestedCwd === "/etc") {
      try {
        const room = await store.getRoom(pane.roomId);
        if (room?.projectPath) {
          requestedCwd = room.projectPath;
        }
      } catch {
        // Best effort
      }
    }
    // Public installations run CLIs as an unprivileged user who can write neither the operator
    // default (/etc) nor the private checkout (/opt/spaceapp, absent there), so a room without a
    // project of its own starts in its own folder under the workspace root.
    if (config.publicDistribution && (!requestedCwd || requestedCwd === "/etc" || requestedCwd === "/opt/spaceapp")) {
      requestedCwd = publicRoomWorkspacePath(config.cliWorkspaceRoot, pane.roomId);
    }
    // Multi-user: a user's own CLI container sees only its own /workspaces, never the folders this core makes (room
    // and session folders), so the CLI starts in the workspace root unless the pane names one of the user's folders.
    const onUserHost = await onUserCliHost?.(pane.id) === true;
    if (onUserHost && (!requestedCwd || !pathInside(config.cliWorkspaceRoot, requestedCwd)
      || requestedCwd === publicRoomWorkspacePath(config.cliWorkspaceRoot, pane.roomId))) {
      requestedCwd = config.cliWorkspaceRoot;
    }
    const directCodexParity = isCodexDirectParityRuntime(runtime.id);
    const directOperatorParity = isDirectOperatorParityRuntime(runtime.id);
    // Status reasons name the runtime that actually restarted (e.g. "Qoder CLI"), never a hard-coded fallback.
    const runtimeAgentName = runtime.displayName.endsWith(" CLI") ? runtime.displayName : `${runtime.displayName} CLI`;
    const runtimeProductName = runtimeAgentName.slice(0, -" CLI".length);
    const activeUsesLegacyWorkspace =
      active &&
      active.runtimeId === runtime.id &&
      active.status !== "EXITED" &&
      active.status !== "ERROR" &&
      isLegacyCliWorkspace(active.cwd, config.cliWorkspaceRoot, runtime.id);
    const reusableSession =
      active &&
      !input.forceRestart &&
      active.runtimeId === runtime.id &&
      active.accountProfileId === requestedAccountProfileId &&
      active.status !== "EXITED" &&
      active.status !== "ERROR"
        ? active
        : null;
    if (
      active &&
      !input.forceRestart &&
      active.status !== "EXITED" &&
      active.status !== "ERROR" &&
      active.runtimeId !== runtime.id
    ) {
      throw new SpaceConflictError(
        `Pane ${pane.id} already has an active ${active.runtimeId} session; changing runtimes requires an explicit restart.`
      );
    }
    // Session creation parameters describe a fresh launch. Once a session is active, reconnects
    // must never reinterpret stale pane/model state as permission to terminate that process.
    const preserveActiveCodex = Boolean(reusableSession && directCodexParity);
    const rollingClientGenericReasoningEcho = input.modelId === undefined && input.reasoningEffort === "medium";
    // Public installs have no Codex app-server to ask for its defaults: Codex resolves them itself at launch.
    const codexChoosesDefaults = config.publicDistribution === true;
    const codexBuildDefaults = directCodexParity && !preserveActiveCodex && !codexChoosesDefaults
      ? await codexCliModeDefaultsService.build()
      : null;
    const resolvedCodexSettings = directCodexParity && !preserveActiveCodex
      ? resolveCodexCliLaunchSettings({
          cliCodexDefaultModel: codexBuildDefaults?.modelId ?? null,
          cliCodexDefaultReasoningEffort: codexBuildDefaults?.reasoningEffort ?? null
        }, pane, {
          modelId: input.modelId,
          reasoningEffort: rollingClientGenericReasoningEcho ? undefined : input.reasoningEffort
        })
      : null;
    if (directCodexParity && !preserveActiveCodex && !resolvedCodexSettings && !codexChoosesDefaults) {
      throw new SpaceFeatureDisabledError(
        "CLI_CODEX_DEFAULTS_UNRESOLVED",
        "Codex CLI launch defaults could not be resolved."
      );
    }
    const requestedModelId = directCodexParity
      ? resolvedCodexSettings?.modelId
      : input.modelId === undefined
        ? undefined
        : input.modelId ?? runtime.defaultModelId ?? null;
    const requestedManagedWorkspace = directOperatorParity || onUserHost ? false : shouldUseManagedCliWorkspace(requestedCwd, config.cliWorkspaceRoot);
    const activeCodexReasoningEffort = active
      ? reasoningEffortSchema.safeParse(active.reasoningEffort).data
      : undefined;
    if (
      active &&
      reusableSession &&
      preserveActiveCodex &&
      activeCodexReasoningEffort &&
      (pane.modelId !== active.modelId || pane.reasoningEffort !== activeCodexReasoningEffort)
    ) {
      await store.updatePane(
        pane.id,
        {
          modelId: active.modelId,
          reasoningEffort: activeCodexReasoningEffort
        },
        request.requestIdForSpace
      );
    }
    await cliRuntimeVisibility.assertEnabled(runtime.id);
    let geminiResumeConversationId: string | null = null;
    if (input.resume && (runtime.id === "cli:gemini" || active?.runtimeId === "cli:gemini")) {
      const taskRevision = active?.cliTaskRevisionId
        ? await store.getCliTaskRevision(active.cliTaskRevisionId)
        : null;
      if (taskRevision?.nativeTaskRef && geminiNativeConversationIdPattern.test(taskRevision.nativeTaskRef)) {
        geminiResumeConversationId = taskRevision.nativeTaskRef;
      }
      if (!geminiResumeConversationId) {
        geminiResumeConversationId = await readGeminiPaneConversation(pane.id);
      }
      if (!geminiResumeConversationId && active?.codexThreadId && geminiNativeConversationIdPattern.test(active.codexThreadId)) {
        geminiResumeConversationId = active.codexThreadId;
      }
      if (!geminiResumeConversationId && active) {
        const pids = await cliTerminalManager.activeSessionPids([active]);
        const rootPid = pids.get(active.sessionId) ?? null;
        if (rootPid) {
          geminiResumeConversationId = await readGeminiNativeConversationIdFromProcessTree(rootPid);
        }
      }
      if (geminiResumeConversationId) {
        await writeGeminiPaneConversation(pane.id, geminiResumeConversationId);
      }
    } else if (!input.resume && input.forceRestart && runtime.id === "cli:gemini") {
      await clearGeminiPaneConversation(pane.id);
    }
    // Claude account profiles share one transcript store, so an account switch continues the same
    // conversation under the new account. A pane without a written turn switches to a fresh session
    // instead of opening Claude's session picker.
    const claudeAccountSwitch = runtime.id === "cli:claude" && active?.runtimeId === "cli:claude" &&
      active.accountProfileId !== requestedAccountProfileId;
    let claudeResumeRevision: Awaited<ReturnType<typeof store.getCliTaskRevision>> = null;
    let claudeResumeNativeSessionId: string | null = null;
    if (input.resume && claudeAccountSwitch && active?.cliTaskId) {
      claudeResumeRevision = active.cliTaskRevisionId ? await store.getCliTaskRevision(active.cliTaskRevisionId) : null;
      if (claudeResumeRevision?.nativeTaskRef && claudeNativeSessionIdPattern.test(claudeResumeRevision.nativeTaskRef)) {
        claudeResumeNativeSessionId = claudeResumeRevision.nativeTaskRef;
      } else {
        const pids = await cliTerminalManager.activeSessionPids([active]).catch(() => null);
        const native = await loadClaudeNativeTurns({
          paneId: pane.id, sessionId: active.sessionId, rootPid: pids?.get(active.sessionId) ?? null
        }, { fresh: true }).catch(() => null);
        if (native?.tasks.length) claudeResumeNativeSessionId = native.nativeSessionId;
      }
    }
    if (active && !reusableSession) {
      await assertCliHttpMutationControl(request, active);
      await cliTerminalManager.interrupt(active.sessionId);
      await store.updatePaneCliSession(
        active.sessionId,
        {
          status: "EXITED",
          statusReason: directOperatorParity
            ? activeUsesLegacyWorkspace
              ? directCodexParity
                ? "CLI session replaced with direct VS Code/Codex parity workspace."
                : `CLI session replaced with direct ${runtimeProductName} operator parity workspace.`
              : input.forceRestart
                ? "CLI session restarted by operator request."
                : `CLI session replaced to apply updated ${runtimeAgentName} session settings.`
            : activeUsesLegacyWorkspace
              ? "CLI session replaced with a managed writable workspace."
              : input.forceRestart
                ? "CLI session restarted by operator request."
                : "CLI session replaced to apply updated CLI session settings.",
          isActive: false,
          endedAt: nowIso()
        },
        request.requestIdForSpace
      );
    }
    const nextSessionId = reusableSession?.sessionId ?? makeSpaceId("cli_session");
    let sessionCwd = directOperatorParity
      ? resolveDirectOperatorParityCwd(requestedCwd, config.cliWorkspaceRoot)
      : requestedManagedWorkspace
        ? buildCliWorkspacePath({
            workspaceRoot: config.cliWorkspaceRoot,
            roomId: pane.roomId,
            paneId: pane.id,
            sessionId: nextSessionId
          })
        : requestedCwd;
    // This core's filesystem says nothing about a user's own container (multi-user), so it neither creates nor checks there.
    if (!reusableSession && sessionCwd && !onUserHost) {
      try {
        if (!existsSync(sessionCwd) && await mayCreateCliSessionDirectory({
          cwd: sessionCwd, role: request.user?.role, projectsRoot: config.projectsRoot, installRoot: config.installRoot,
          worktreesRoot: WORKTREES_ROOT, workspaceRoot: config.cliWorkspaceRoot
        })) await mkdir(sessionCwd, { recursive: true, mode: 0o750 });
        if (sessionCwd.startsWith("/opt/spaceapp/projects/") && existsSync(sessionCwd) && !existsSync(join(sessionCwd, ".git"))) {
          await execFileAsync("git", ["init", "-b", "main", sessionCwd]);
        }
      } catch {}
      // A folder that could not be created here (a worktree or project of another host) would fail chdir at spawn.
      if (await pathIsMissing(sessionCwd)) {
        const missingCwd = sessionCwd;
        const room = await Promise.resolve(store.getRoom(pane.roomId)).catch(() => null);
        let fallbackCwd = homedir();
        for (const candidate of [room?.projectPath, config.cliWorkspaceRoot]) {
          if (candidate && candidate !== missingCwd && !await pathIsMissing(candidate)) {
            fallbackCwd = candidate;
            break;
          }
        }
        sessionCwd = fallbackCwd;
        request.log.warn({ paneId: pane.id, missingCwd, sessionCwd }, "CLI pane folder does not exist on this host; starting in a fallback folder");
      }
      if (requestedManagedWorkspace) {
        await writeCliWorkspaceBootstrap(sessionCwd, {
          roomId: pane.roomId,
          paneId: pane.id,
          sessionId: nextSessionId,
          runtimeId: runtime.id,
          paneMode: pane.mode
        });
      }
    }
    if (reusableSession?.cwd && pathInside(config.cliWorkspaceRoot, reusableSession.cwd)) {
      await writeCliWorkspaceBootstrap(reusableSession.cwd, {
        roomId: reusableSession.roomId,
        paneId: reusableSession.paneId,
        sessionId: reusableSession.sessionId,
        runtimeId: reusableSession.runtimeId,
        paneMode: pane.mode
      });
    }
    if (
      !reusableSession &&
      directCodexParity &&
      resolvedCodexSettings &&
      (pane.modelId !== resolvedCodexSettings.modelId || pane.reasoningEffort !== resolvedCodexSettings.reasoningEffort)
    ) {
      await store.updatePane(
        pane.id,
        {
          modelId: resolvedCodexSettings.modelId,
          reasoningEffort: resolvedCodexSettings.reasoningEffort
        },
        request.requestIdForSpace
      );
    }
    if (!reusableSession && sessionCwd && pane.cwd !== sessionCwd) {
      await store.updatePane(
        pane.id,
        { cwd: sessionCwd },
        request.requestIdForSpace
      );
    }
    await cliRuntimeVisibility.assertEnabled(runtime.id);
    assertCliPaneCompatible(await getPaneById(store, pane.id));
    const allocatedAtNs = reusableSession ? null : process.hrtime.bigint();
    const session = reusableSession
      ? reusableSession
      : await store.createPaneCliSession(
          {
            sessionId: nextSessionId,
            paneId: pane.id,
            roomId: pane.roomId,
            runtimeId: runtime.id,
            providerId: runtime.providerId,
            agentId: runtime.agentId,
            modelId: directCodexParity
              ? resolvedCodexSettings?.modelId ?? null
              : input.modelId === undefined
                ? (active?.runtimeId === runtime.id && active?.modelId ? active.modelId : (pane.modelId ?? runtime.defaultModelId))
                : requestedModelId ?? null,
            reasoningEffort: directCodexParity
              ? resolvedCodexSettings?.reasoningEffort ?? pane.reasoningEffort
              : runtime.id === "cli:gemini"
                ? (input.reasoningEffort && !rollingClientGenericReasoningEcho
                    ? input.reasoningEffort
                    : (active?.runtimeId === runtime.id && active?.reasoningEffort
                        ? active.reasoningEffort
                        : (pane.reasoningEffort && pane.reasoningEffort !== "medium"
                            ? pane.reasoningEffort
                            : "high")))
                : input.reasoningEffort ?? (active?.runtimeId === runtime.id && active?.reasoningEffort ? active.reasoningEffort : pane.reasoningEffort),
            launchMode: input.resume && (
              runtime.id === "cli:gemini" ? geminiResumeConversationId
                : claudeAccountSwitch ? claudeResumeNativeSessionId
                  : true
            ) ? "RESUME" : "FRESH",
            cwd: sessionCwd,
            codexThreadId: null,
            ...(claudeResumeNativeSessionId && active?.cliTaskId ? { cliTaskId: active.cliTaskId } : {}),
            accountProfileId: requestedAccountProfileId,
            status: "IDLE",
            statusReason: "CLI session allocated; waiting for terminal transport attach."
          },
          request.requestIdForSpace
        );
    if (allocatedAtNs !== null) cliTerminalManager.recordSessionAllocation(session.sessionId, allocatedAtNs);
    if (!reusableSession && claudeResumeNativeSessionId && session.cliTaskRevisionId) {
      await store.updateCliTaskRevision(
        session.cliTaskRevisionId,
        {
          nativeTaskRef: claudeResumeNativeSessionId,
          ...(claudeResumeRevision
            ? {
                displayTitle: claudeResumeRevision.displayTitle,
                firstUserMessage: claudeResumeRevision.firstUserMessage,
                preview: claudeResumeRevision.preview
              }
            : {})
        },
        request.requestIdForSpace
      );
    }

    if (runtime.id === "cli:gemini") {
      const nextModelId = session.modelId ?? runtime.defaultModelId;
      const parsedReasoningEffort = session.reasoningEffort
        ? reasoningEffortSchema.safeParse(session.reasoningEffort).data
        : undefined;
      const nextReasoningEffort = parsedReasoningEffort ?? (pane.reasoningEffort !== "medium" ? pane.reasoningEffort : "high");
      if (pane.modelId !== nextModelId || pane.reasoningEffort !== nextReasoningEffort) {
        await store.updatePane(pane.id, { modelId: nextModelId, reasoningEffort: nextReasoningEffort }, request.requestIdForSpace);
      }
      try {
        const cleanPaneId = pane.id.replace(/^pane:/, "");
        const modelRecord = JSON.stringify({ modelId: nextModelId, reasoningEffort: nextReasoningEffort ?? session.reasoningEffort });
        await mkdir("/opt/spaceapp/var/gemini-pane-conversations", { recursive: true, mode: 0o777 });
        await writeFile(`/opt/spaceapp/var/gemini-pane-conversations/pane-${cleanPaneId}-model.json`, modelRecord, { mode: 0o666 });
        await chmod(`/opt/spaceapp/var/gemini-pane-conversations/pane-${cleanPaneId}-model.json`, 0o666).catch(() => {});
      } catch {}
    }

    if (!reusableSession) {
      await store.appendPaneCliTranscriptChunk(
        {
          sessionId: session.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          sequence: 0,
          stream: "system",
          content: `${runtime.displayName} session allocated by Space. Terminal transport is gated behind runtime attach.`
        },
        request.requestIdForSpace
      );
    }

    await recordAudit(store, request, {
      action: "pane.cli.session",
      targetType: "pane",
      targetId: pane.id,
      metadata: {
        roomId: pane.roomId,
        runtimeId: runtime.id,
        providerId: runtime.providerId,
        agentId: runtime.agentId,
        accountProfileId: session.accountProfileId,
        resume: input.resume,
        reused: Boolean(reusableSession)
      }
    });
    return buildPaneCliSessionResponse({
      store,
      runtime,
      sessionId: session.sessionId,
      includeWebsocket: true,
      includeTranscript: input.includeTranscript,
      tokenTtlMs: config.cliTokenTtlMs,
      issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
    });
  })));
  app.post("/api/panes/:id/cli/resume", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(resumePaneCliSessionRequestSchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (active) await assertCliHttpMutationControl(request, active);
    return resumePaneCliTask(pane, input, request.requestIdForSpace, request);
  });
  app.post("/api/panes/:id/cli/uploads", defaultRouteRateLimitOptions, async (request, reply) => {
    const params = parseQuery(idParamSchema, request.params);
    const query = parseQuery(cliUploadsQuerySchema, request.query);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const authority = parseCliHttpControlAuthority(request);
    let targetSession: PaneCliSession | null = null;
    if (authority?.leaseId) {
      const lease = await store.getPaneCliTerminalControlLease(authority.leaseId);
      if (lease && lease.paneId === pane.id && lease.status === "ACTIVE") {
        targetSession = await store.getPaneCliSession(lease.sessionId);
      }
    }
    const active = targetSession ?? await store.getActivePaneCliSession(pane.id);
    if (!active || (!active.isActive && !targetSession) || active.status === "EXITED" || active.status === "ERROR") {
      return sendApiError(reply, 409, "CLI_SESSION_REQUIRED", "Attach or reconnect a CLI session before uploading files to the terminal.");
    }
    if (active.purpose !== "NORMAL") {
      return sendApiError(reply, 409, "CLI_LOGIN_SESSION_RESTRICTED", "CLI login sessions cannot persist terminal uploads.");
    }
    if (targetSession && !targetSession.isActive) {
      await store.updatePaneCliSession(targetSession.sessionId, { isActive: true }, request.requestIdForSpace);
      active.isActive = true;
    }
    await assertCliHttpMutationControl(request, active);
    await cliRuntimeVisibility.assertEnabled(active.runtimeId);

    return withStagedUploads(request, config.browserEvidenceArtifactRoot,
      { maxFiles: paneCliUploadMaxCount, fileBytes: paneCliUploadMaxBytes }, async uploads => {
      for (const upload of uploads) {
        if (upload.declaredMimeType.startsWith("image/") && (!isAllowedImageMime(upload.declaredMimeType) || sniffImageMime(upload.sample) !== upload.declaredMimeType)) {
          return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", "Uploaded image bytes do not match a supported PNG, JPEG, or WebP image type.");
        }
      }
      const files = [];
      for (const upload of uploads) {
        const { byteSize, sha256, declaredMimeType } = upload;
        const sniffedMimeType = sniffImageMime(upload.sample);
        const declaredImage = declaredMimeType.startsWith("image/");
        const originalFilename = safeOriginalFilename(upload.filename);
        const storage = buildCliUploadStorage({
          artifactRoot: config.browserEvidenceArtifactRoot,
          roomId: pane.roomId,
          paneId: pane.id,
          sessionId: active.sessionId,
          originalFilename
        });
        const artifactRecord = await withPersistedUpload(config.browserEvidenceArtifactRoot, upload, storage.filePath, async pinnedPath => {
          await ensureCliUploadPathReadable({ artifactRoot: config.browserEvidenceArtifactRoot, filePath: storage.filePath });
          return recordUploadedArtifact(store,
          {
            roomId: pane.roomId,
            paneId: pane.id,
            kind: declaredImage ? "IMAGE" : "EXPORT",
            mimeType: declaredMimeType,
            storageUri: storage.storageUri,
            sha256,
            byteSize,
            metadata: {
              source: query.source,
              cliSessionId: active.sessionId,
              runtimeId: active.runtimeId,
              originalFilename,
              storedFilename: storage.storedFilename,
              fieldName: upload.fieldname,
              sniffedMimeType,
              uploadedBy: request.user?.id ?? null
            }
          },
          request.requestIdForSpace, pinnedPath
        );
        }, CLI_UPLOAD_FILE_MODE);
        eventBus.publish(artifactRecord.event);

        let terminalPath = storage.filePath;
        let shellQuoted = shellQuotePath(storage.filePath);
        if (declaredImage && active.runtimeId === REASONIX_CLI_RUNTIME_ID) {
          const workspaceRoot = pane.cwd ?? (("cwd" in active && active.cwd) ? active.cwd : null);
          if (!workspaceRoot) {
            return sendApiError(reply, 409, "REASONIX_WORKSPACE_ROOT_MISSING", "Reasonix pane has no workspace root; cannot attach image as an image input.");
          }
          const reasonixAttachment = buildReasonixAttachmentUpload({ workspaceRoot, mimeType: declaredMimeType });
          try {
            await withPersistedUpload(workspaceRoot, upload, reasonixAttachment.absolutePath, async () => undefined, CLI_UPLOAD_FILE_MODE, config.browserEvidenceArtifactRoot);
            terminalPath = reasonixAttachment.terminalPath;
            shellQuoted = reasonixAttachment.terminalPath;
          } catch (error) {
            request.log.warn(
              { err: error, requestId: request.requestIdForSpace, paneId: pane.id, sessionId: active.sessionId },
              "reasonix image attachment mirror failed; falling back to plain CLI-upload path"
            );
          }
        }

        files.push({
          artifactId: artifactRecord.artifact.id,
          sessionId: active.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          originalFilename,
          storedFilename: storage.storedFilename,
          mimeType: declaredMimeType,
          byteSize,
          sha256,
          storageUri: storage.storageUri,
          terminalPath,
          shellQuotedPath: shellQuoted,
          isImage: declaredImage
        });
      }

      if (!files.length) {
        return sendApiError(reply, 422, "EMPTY_UPLOAD", "Upload at least one file.");
      }

      await recordAudit(store, request, {
        action: "pane.cli.upload",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          sessionId: active.sessionId,
          runtimeId: active.runtimeId,
          source: query.source,
          fileCount: files.length,
          artifactIds: files.map((file) => file.artifactId)
        }
      });
      if (query.source === "CLIPBOARD") {
        request.log.info(
          {
            requestId: request.requestIdForSpace,
            paneId: pane.id,
            roomId: pane.roomId,
            sessionId: active.sessionId,
            runtimeId: active.runtimeId,
            source: query.source,
            files: files.map((file) => ({
              artifactId: file.artifactId,
              originalFilename: file.originalFilename,
              mimeType: file.mimeType,
              byteSize: file.byteSize,
              isImage: file.isImage
            }))
          },
          "CLI clipboard upload accepted"
        );
      }
      return paneCliUploadResponseSchema.parse({
        sessionId: active.sessionId,
        paneId: pane.id,
        roomId: pane.roomId,
        files
      });
    });
  });
  app.post("/api/panes/:id/cli/clipboard-debug", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(cliClipboardDebugInputSchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (active?.purpose === "LOGIN") {
      throw new SpaceConflictError("CLI login sessions cannot persist clipboard diagnostics.");
    }
    const logPayload = {
      requestId: request.requestIdForSpace,
      paneId: pane.id,
      roomId: pane.roomId,
      sessionId: input.sessionId ?? active?.sessionId ?? null,
      runtimeId: active?.runtimeId ?? null,
      severity: input.severity,
      title: input.title,
      detail: input.detail,
      trace: input.trace,
      url: safeBrowserObservationUrl(input.url ?? null),
      userAgent: input.userAgent ?? null,
      activeElement: input.activeElement ?? null,
      documentHasFocus: input.documentHasFocus ?? null,
      visibilityState: input.visibilityState ?? null,
      clipboardApi: input.clipboardApi ?? null,
      reportedByUserId: request.user?.id ?? null
    };
    if (input.severity === "bad") {
      request.log.warn(logPayload, "CLI clipboard debug report");
    } else {
      request.log.info(logPayload, "CLI clipboard debug report");
    }
    return {
      ok: true as const,
      requestId: request.requestIdForSpace
    };
  });
  app.post("/api/panes/:id/cli/interrupt", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(paneCliInterruptInputSchema, request.body ?? {});
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active) {
      throw new SpaceNotFoundError(`Active CLI session for pane ${pane.id} was not found.`);
    }
    await assertCliHttpMutationControl(request, active);
    const registry = await discoverAgentRuntimes(config);
    const runtime = findRuntime(registry, active.runtimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${active.runtimeId} was not found.`);
    }
    const loginSession = active.purpose === "LOGIN";
    const interruptReason = loginSession
      ? "CLI login cancelled by operator."
      : input.reason ? redactMemoryText(input.reason) : "Interrupted by operator.";
    await spaceControl.withOperatorMutation(pane,()=>cliTerminalManager.interrupt(active.sessionId, {
      content: "Interrupt requested by operator.",
      traceId: request.requestIdForSpace
    }));
    if (loginSession) {
      // LOGIN lifecycle status and its minimal audit are owned by the terminal manager.
    } else {
      await store.updatePaneCliSession(
        active.sessionId,
        {
          status: "EXITED",
          statusReason: interruptReason,
          exitCode: null,
          isActive: false
        },
        request.requestIdForSpace
      );
      await recordAudit(store, request, {
        action: "pane.cli.interrupt",
        targetType: "pane",
        targetId: pane.id,
        metadata: { roomId: pane.roomId, runtimeId: active.runtimeId, sessionId: active.sessionId }
      });
    }
    return buildPaneCliSessionResponse({
      store,
      runtime,
      sessionId: active.sessionId,
      includeWebsocket: false,
      tokenTtlMs: config.cliTokenTtlMs,
      issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
    });
  });
  app.post("/api/panes/:id/cli/turn-abort", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertCliPaneCompatible(pane);
    await assertPaneCliRuntimeEnabled(pane);
    const active = await store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status === "EXITED" || active.status === "ERROR") {
      throw new SpaceConflictError("Attach a CLI session before interrupting its turn.");
    }
    assertNormalCliSession(active);
    assertRootAdmin(request, active.runtimeId);
    await assertCliHttpMutationControl(request, active);
    let isTurnActive = false;
    if (isOpenCodeDirectParityRuntime(active.runtimeId)) {
      const control = await resolveOpenCodeServerControl(active);
      try {
        await abortOpenCodeSession(control, control.nativeSessionId);
      } catch (error) {
        throw new SpaceConflictError("OpenCode rejected the turn abort; the running turn was left unchanged.");
      }
      isTurnActive = await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId).catch(() => false);
    } else {
      throw new SpaceConflictError("Turn abort is only available for OpenCode CLI sessions.");
    }
    await recordAudit(store, request, {
      action: "pane.cli.turn-abort",
      targetType: "pane",
      targetId: pane.id,
      metadata: { roomId: pane.roomId, runtimeId: active.runtimeId, sessionId: active.sessionId }
    });
    return { ok: true as const, isTurnActive };
  });
  app.get("/api/panes/:id/agent-session", defaultRouteRateLimitOptions, async (request) => {
    const params = parseQuery(idParamSchema, request.params);
    const pane = await getPaneById(store, params.id);
    assertAgentPaneCompatible(pane);
    return spaceAgentAdapter.loadSession({ pane });
  });
}
