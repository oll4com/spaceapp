import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { t3CodeBindingBootstrapSchema, t3CodeBindingUpdateSchema, t3CodeServiceStatusSchema,
  t3CodeSelectionSchema, type Pane, type T3CodePaneMetadata, type T3CodeSelection, type T3CodeServiceStatus } from "@space/contracts";
import { authorizeT3Pane, type T3PaneAccessOptions, type T3PaneScope } from "./access.js";
import { T3GatewayError } from "./gateway-policy.js";
import { installedT3Version, T3Upstream, type T3Shell } from "./upstream.js";
import { publishT3AgentTokens, type T3AgentTokenOptions } from "./agent-tokens.js";
import { t3RoomProjectWorkspace, t3WorktreeWorkspace } from "./worktree-workspace.js";

export interface T3BindingOptions extends T3PaneAccessOptions {
  store: T3PaneAccessOptions["store"] & {
    compareAndSetT3CodeMetadata(paneId: string, expectedRevision: number, metadata: T3CodePaneMetadata): Pane | null | Promise<Pane | null>;
  };
  socketPath?: string;
  healthTimeoutMs?: number;
  // Explicit server policy, never supplied by a browser. The managed service
  // currently exposes its owned workspace tree; no permission widening here.
  workspaceRoot?: string;
  // Space-managed worktrees and CLI-writable roots T3 may also use (tests override them).
  worktreesRoot?: string;
  writableRoots?: string[];
  // Pane-bound tool tokens (space_browser, Agent Files) for the pane's T3 agents.
  agentTokens?: T3AgentTokenOptions | null;
}

const RECOVERABLE_SELECTION = new Set(["T3_THREAD_NOT_FOUND", "T3_THREAD_PROJECT_MISMATCH", "T3_PROJECT_NOT_FOUND", "T3_ENVIRONMENT_MISMATCH"]);

// Sidebar label for a pane-owned project: which room and pane it belongs to.
function projectTitle(scope: T3PaneScope) {
  const clean = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  const title = [clean(scope.room.name), clean(scope.pane.paneName ?? scope.pane.title)].filter(Boolean).join(" · ");
  return (title || "Space project").slice(0, 120);
}

export async function registerT3Bindings(app: FastifyInstance, options: T3BindingOptions) {
  const upstream = new T3Upstream(options.socketPath, options.healthTimeoutMs);
  const workspaceRoot = options.workspaceRoot ?? "/opt/spaceapp/var/t3code/workspace";
  const locks = new Map<string, Promise<unknown>>();
  const serialize = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work); locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  };
  // What a CLI pane of the room would open is checked here: its own Space
  // worktree (room worktree isolation) or the room's project directory.
  // Everything else goes through the policy inside the private T3 tree.
  const allowedWorkspace = async (scope: T3PaneScope, candidate: string) =>
    await t3WorktreeWorkspace(candidate, options.worktreesRoot) ??
    await t3RoomProjectWorkspace(candidate, scope.room.projectPath, options.writableRoots) ??
    upstream.workspace(scope, candidate);
  const validateSelection = async (scope: T3PaneScope, selection: T3CodeSelection, snapshot?: T3Shell) => {
    const descriptor = await upstream.descriptor(scope);
    if (descriptor.environmentId !== selection.environmentId) throw new T3GatewayError(409, "T3_ENVIRONMENT_MISMATCH");
    const model = snapshot ?? await upstream.shell(scope);
    const project = model.projects.find(p => p.id === selection.projectId);
    if (!project) throw new T3GatewayError(409, "T3_PROJECT_NOT_FOUND");
    const workspace = await allowedWorkspace(scope, project.workspaceRoot);
    if (selection.threadId !== null) {
      const thread = model.threads.find(t => t.id === selection.threadId);
      if (!thread) throw new T3GatewayError(409, "T3_THREAD_NOT_FOUND");
      if (thread.projectId !== selection.projectId) throw new T3GatewayError(409, "T3_THREAD_PROJECT_MISMATCH");
    }
    return { descriptor, workspace };
  };
  // The pane's T3 agents work in its selected workspace: give them the pane's
  // tool tokens there, as a CLI pane's session gets them. Never fails the pane.
  const publishAgentTokens = async (scope: T3PaneScope, workspace: string) => {
    if (!options.agentTokens) return;
    try { await publishT3AgentTokens(options.agentTokens, { roomId: scope.room.id, paneId: scope.paneId, workspaceRoot: workspace }); }
    catch { /* The tools report the bridge as unavailable instead. */ }
  };
  const validateAndPublish = async (scope: T3PaneScope, selection: T3CodeSelection) =>
    publishAgentTokens(scope, (await validateSelection(scope, selection)).workspace);
  // A room's default folder is not a T3 workspace: /opt/spaceapp for workspace rooms, /etc for Agent Proof rooms (5627772ffc).
  const roomDefaultFolder = (room: T3PaneScope["room"]) =>
    room.projectPath === "/opt/spaceapp" || (room.kind === "AGENT_PROOF" && room.projectPath === "/etc");
  const workspaceCandidates = (scope: T3PaneScope) =>
    [scope.pane.cwd, roomDefaultFolder(scope.room) ? null : scope.room.projectPath].filter((v): v is string => Boolean(v?.trim()));
  // Same rule as initialSelection, without creating anything upstream.
  const unboundWorkspaceAllowed = async (scope: T3PaneScope) => {
    const candidates = workspaceCandidates(scope);
    if (scope.pane.t3CodeMetadata || !candidates.length) return true;
    for (const candidate of candidates) {
      try { await allowedWorkspace(scope, candidate); return true; }
      catch (error) { if (!(error instanceof T3GatewayError) || error.code !== "T3_WORKSPACE_FORBIDDEN") return true; }
    }
    return false;
  };
  const status = async (scope: T3PaneScope): Promise<T3CodeServiceStatus> => {
    let environmentId: string | null = null;
    try { environmentId = (await upstream.descriptor(scope)).environmentId; } catch {}
    const runtime = await installedT3Version(), ready = options.enabled && environmentId !== null;
    const workspaceAllowed = ready ? await unboundWorkspaceAllowed(scope) : true;
    return t3CodeServiceStatusSchema.parse({ version: 1, enabled: options.enabled, state: !options.enabled ? "disabled" : ready ? "ready" : "unavailable",
      runtime, environmentId, workspaceAllowed, checkedAt: new Date().toISOString(), capabilities: {
        paneBindings: ready, selectionMessages: ready && (runtime?.integrationRevision ?? 0) >= 3,
        draftIsolation: ready && (runtime?.integrationRevision ?? 0) >= 3, orchestration: ready, serviceControl: false
      } });
  };
  const initialSelection = async (scope: T3PaneScope): Promise<T3CodeSelection> => {
    const candidates = workspaceCandidates(scope);
    let workspace: string | undefined;
    for (const candidate of candidates) {
      try { workspace = await allowedWorkspace(scope, candidate); break; }
      catch (error) { if (!(error instanceof T3GatewayError) || error.code !== "T3_WORKSPACE_FORBIDDEN") throw error; }
    }
    if (candidates.length && !workspace) throw new T3GatewayError(403, "T3_WORKSPACE_FORBIDDEN");
    const root = await allowedWorkspace(scope, workspaceRoot);
    // Stable id makes a crash/retry re-use the real project already created.
    // It is only an id seed until the upstream confirms its existence.
    const projectId = "space-" + createHash("sha256").update(workspace ?? scope.paneId).digest("hex").slice(0, 32);
    const newWorkspace = workspace ?? await upstream.workspace(scope, join(root, "projects", projectId), true);
    const project = await serialize(`project:${newWorkspace}`, async () => {
      let existing = (await upstream.shell(scope)).projects.find(p => resolve(p.workspaceRoot) === newWorkspace);
      if (existing) return existing;
      try {
        await upstream.createProject(scope, { type: "project.create", commandId: randomUUID(), projectId, title: projectTitle(scope),
          workspaceRoot: newWorkspace, createWorkspaceRootIfMissing: workspace === undefined, createdAt: new Date().toISOString() });
      } catch (error) {
        // Another API process may win project creation. Only a confirmed real
        // project with the exact deterministic id/path can recover that race.
        existing = (await upstream.shell(scope)).projects.find(p => p.id === projectId && resolve(p.workspaceRoot) === newWorkspace);
        if (!existing) throw error;
      }
      existing ??= (await upstream.shell(scope)).projects.find(p => p.id === projectId && resolve(p.workspaceRoot) === newWorkspace);
      if (!existing) throw new T3GatewayError(502, "T3_PROJECT_CREATION_FAILED");
      return existing;
    });
    const selection = { environmentId: (await upstream.descriptor(scope)).environmentId, projectId: project.id, threadId: null, draftId: randomUUID() };
    await validateSelection(scope, selection); return selection;
  };
  // Opens (or restores) the pane binding: a fresh generation over a validated
  // selection. Used by binding/open and by the gateway's inline bootstrap.
  const open = (request: FastifyRequest, access: T3PaneScope) => serialize(access.paneId, async () => {
    const current = await options.store.getPane(access.paneId) as Pane;
    const metadata = current.t3CodeMetadata ?? null;
    let selection = metadata?.selection ?? null;
    if (selection) {
      try { await validateSelection(access, selection); }
      catch (error) {
        // A deleted thread/project or a restored environment can never be
        // reopened; start a fresh draft instead of leaving the pane unusable.
        // Another real thread is never substituted; workspace denials stay closed.
        if (!(error instanceof T3GatewayError) || !RECOVERABLE_SELECTION.has(error.code)) throw error;
        selection = error.code.startsWith("T3_THREAD_") ? { ...selection, threadId: null, draftId: randomUUID() } : null;
        if (selection) await validateSelection(access, selection).catch(() => { selection = null; });
      }
    }
    selection ??= await initialSelection({ ...access, pane: current });
    await validateAndPublish(access, selection);
    await authorizeT3Pane(request, options, access.paneId); // Revocation during upstream work fails closed.
    const next: T3CodePaneMetadata = { version: 1, revision: (metadata?.revision ?? 0) + 1, generation: randomUUID(), lastSequence: 0, selection };
    if (!await options.store.compareAndSetT3CodeMetadata(access.paneId, metadata?.revision ?? 0, next)) throw new T3GatewayError(409, "T3_SELECTION_STALE");
    return t3CodeBindingBootstrapSchema.parse({ version: 1, paneId: access.paneId,
      basePath: `/api/t3code/panes/${access.paneId}/app/`, metadata: next, service: await status(access) });
  });
  await app.register(async child => {
    child.setErrorHandler((cause, _request, reply) => {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      const name = cause instanceof Error ? cause.name : "";
      const error = cause instanceof T3GatewayError ? cause :
        name === "SpaceConflictError" ? new T3GatewayError(409, "T3_PANE_UNAVAILABLE") :
        name === "SpaceNotFoundError" ? new T3GatewayError(404, "T3_PANE_NOT_FOUND") :
        code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? new T3GatewayError(415, "T3_SELECTION_INVALID") :
        code === "FST_ERR_CTP_INVALID_JSON_BODY" ? new T3GatewayError(400, "T3_SELECTION_INVALID") :
        code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new T3GatewayError(413, "T3_SELECTION_INVALID") :
        new T3GatewayError(502, "T3_UPSTREAM_UNAVAILABLE");
      reply.code(error.status).header("cache-control", "no-store").send({ error: { code: error.code, message: "T3 Code selection could not be restored." } });
    });
    const scope = async (request: FastifyRequest) => {
      const paneId = (request.params as { paneId: string }).paneId;
      if (!/^pane:[A-Za-z0-9_-]{6,80}$/.test(paneId)) throw new T3GatewayError(400, "T3_PATH_INVALID");
      return authorizeT3Pane(request, options, paneId);
    };
    const base = "/api/t3code/panes/:paneId/app/__space/";
    child.get(base + "status", async (request, reply) => reply.header("cache-control", "no-store").send(await status(await scope(request))));
    child.get(base + "binding", async (request, reply) => {
      const access = await scope(request), metadata = access.pane.t3CodeMetadata ?? null;
      if (metadata) await validateAndPublish(access, metadata.selection);
      return reply.header("cache-control", "no-store").send({ version: 1, paneId: access.paneId, metadata });
    });
    child.post(base + "binding/validate", { bodyLimit: 4096 }, async (request, reply) => {
      const access = await scope(request);
      const body = request.body as { version?: unknown; generation?: unknown; selection?: unknown };
      if (!body || typeof body !== "object" || Object.keys(body).length !== 3 || body.version !== 1 || body.generation !== access.pane.t3CodeMetadata?.generation)
        throw new T3GatewayError(409, "T3_SELECTION_STALE");
      const parsed = t3CodeSelectionSchema.safeParse(body.selection);
      if (!parsed.success) throw new T3GatewayError(400, "T3_SELECTION_INVALID");
      await validateAndPublish(access, parsed.data);
      if ((await scope(request)).pane.t3CodeMetadata?.generation !== body.generation) throw new T3GatewayError(409, "T3_SELECTION_STALE");
      return reply.header("cache-control", "no-store").send({ version: 1, selection: parsed.data });
    });
    child.post(base + "binding/open", { bodyLimit: 1024 }, async (request, reply) => {
      const access = await scope(request);
      if (request.body && (typeof request.body !== "object" || Object.keys(request.body).length)) throw new T3GatewayError(400, "T3_SELECTION_INVALID");
      return reply.header("cache-control", "no-store").send(await open(request, access));
    });
    child.post(base + "binding/selection", { bodyLimit: 4096 }, async (request, reply) => {
      const access = await scope(request), parsed = t3CodeBindingUpdateSchema.safeParse(request.body);
      if (!parsed.success) throw new T3GatewayError(400, "T3_SELECTION_INVALID");
      return serialize(access.paneId, async () => {
        const current = await options.store.getPane(access.paneId) as Pane, metadata = current.t3CodeMetadata;
        const input = parsed.data;
        if (!metadata || metadata.generation !== input.generation || input.sequence <= metadata.lastSequence) throw new T3GatewayError(409, "T3_SELECTION_STALE");
        await validateAndPublish(access, input.selection); await scope(request);
        const next = { ...metadata, revision: metadata.revision + 1, lastSequence: input.sequence, selection: input.selection };
        if (!await options.store.compareAndSetT3CodeMetadata(access.paneId, metadata.revision, next)) throw new T3GatewayError(409, "T3_SELECTION_STALE");
        return reply.header("cache-control", "no-store").send({ version: 1, paneId: access.paneId, metadata: next });
      });
    });
  });
  return {
    // Gateway inline bootstrap for a same-origin pane document navigation: the
    // same open as binding/open, whose browser POST it replaces.
    async openForDocument(request: FastifyRequest, paneId: string): Promise<{ binding: unknown; bindingError: string | null }> {
      try { return { binding: await open(request, await authorizeT3Pane(request, options, paneId)), bindingError: null }; }
      catch (error) {
        if (error instanceof T3GatewayError && error.code === "T3_WORKSPACE_FORBIDDEN") return { binding: null, bindingError: error.code };
        return { binding: null, bindingError: null };
      }
    },
  };
}
