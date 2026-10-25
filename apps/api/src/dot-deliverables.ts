import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  dotIdSchema,
  dotWorkspacePath,
  dotWorkspaceRelativePathSchema,
  publishDotDeliverableInputSchema,
  type Artifact,
  type DotDeliverable,
  type DotWorkspaceEntry,
  type DotWorkspaceFolder
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { DotDeliverablesRepository, DotsRepository } from "@space/db";

/**
 * Space Dots Stage 5: deliverables.
 *
 * The owner browses a Dot's workspace, opens or downloads its files, and
 * publishes a file to Agent Files. Each publication of the same path is a new
 * numbered version; unchanged content is not published twice. A Dot can ask to
 * publish, but Agent Files receive only what the owner approves.
 */
export class DotDeliverableError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, readonly code: string, message: string) { super(message); }
}
export interface DotDeliverablesDeps {
  store: Pick<SpaceStore, "getRoom">;
  dots: Pick<DotsRepository, "get">;
  deliverables: DotDeliverablesRepository;
  workspaceRoot: string;
  maxBytes: number;
  /** Stores the bytes as an Agent File in the room and returns the artifact. */
  publishArtifact(input: { roomId: string; dotName: string; filename: string; mimeType: string; buffer: Buffer }): Promise<Artifact>;
  audit(request: FastifyRequest | null, action: string, metadata: Record<string, unknown>): Promise<void>;
}

const mimeTypes: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".html": "text/html", ".htm": "text/html",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm", ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
/** Types a browser may show inline without running anything; everything else downloads. */
const inlineTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json", "image/png", "image/jpeg", "image/gif", "image/webp",
  "application/pdf", "audio/mpeg", "audio/wav", "video/mp4", "video/webm"]);
export function workspaceMimeType(name: string): string { return mimeTypes[extname(name).toLowerCase()] ?? "application/octet-stream"; }

/** Resolves a workspace path without following links out of the workspace. */
export async function resolveWorkspacePath(root: string, path: string, kind: "file" | "directory"): Promise<string> {
  const base = await realpath(root).catch(() => { throw new DotDeliverableError(404, "DOT_WORKSPACE_EMPTY", "The workspace has not been created yet."); });
  const candidate = path ? join(base, ...dotWorkspaceRelativePathSchema.parse(path).split("/")) : base;
  const info = await lstat(candidate).catch(() => { throw new DotDeliverableError(404, "DOT_WORKSPACE_NOT_FOUND", "That file is not in the workspace."); });
  if (info.isSymbolicLink()) throw new DotDeliverableError(400, "DOT_WORKSPACE_LINK", "Links are not opened from the workspace.");
  const resolved = await realpath(candidate);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) throw new DotDeliverableError(400, "DOT_WORKSPACE_OUTSIDE", "Use a path inside the workspace.");
  if (kind === "file" ? !info.isFile() : !info.isDirectory()) {
    throw new DotDeliverableError(400, "DOT_WORKSPACE_KIND", kind === "file" ? "That path is a folder." : "That path is not a folder.");
  }
  return resolved;
}

export function createDotDeliverablesService(deps: DotDeliverablesDeps) {
  async function dotFor(owner: string, dotId: string) {
    const dot = await deps.dots.get(owner, dotId);
    if (!dot) throw new DotDeliverableError(404, "DOT_NOT_FOUND", "Dot was not found.");
    return dot;
  }
  const root = (dotId: string) => dotWorkspacePath(dotId, deps.workspaceRoot);
  async function folder(owner: string, dotId: string, path: string): Promise<DotWorkspaceFolder> {
    await dotFor(owner, dotId);
    let directory: string;
    try { directory = await resolveWorkspacePath(root(dotId), path, "directory"); }
    catch (error) {
      if (error instanceof DotDeliverableError && error.code === "DOT_WORKSPACE_EMPTY" && !path) return { dotId, folder: "", exists: false, entries: [], totalEntries: 0, sortedAll: true };
      throw error;
    }
    const names = await readdir(directory);
    const entries: DotWorkspaceEntry[] = [];
    for (const name of names.slice(0, 5000)) {
      const info = await lstat(join(directory, name)).catch(() => null);
      if (!info) continue;
      entries.push({ name: name.slice(0, 255), kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        bytes: info.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() });
    }
    entries.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
    return { dotId, folder: path, exists: true, entries: entries.slice(0, 200), totalEntries: names.length, sortedAll: names.length <= 5000 };
  }
  /**
   * Opens a workspace file for reading. The checked path is opened without following links and must be
   * the same inode, a regular file with a single link, so a swap after the check is refused.
   */
  async function file(owner: string, dotId: string, path: string) {
    await dotFor(owner, dotId);
    const absolute = await resolveWorkspacePath(root(dotId), path, "file");
    const checked = await lstat(absolute);
    let handle: FileHandle;
    try { handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
    catch { throw new DotDeliverableError(400, "DOT_WORKSPACE_LINK", "Links are not opened from the workspace."); }
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.ino !== checked.ino || info.dev !== checked.dev) {
      await handle.close();
      throw new DotDeliverableError(409, "DOT_WORKSPACE_CHANGED", "The file changed while it was being opened. Try again.");
    }
    return { handle, absolute, name: basename(absolute), size: info.size, mimeType: workspaceMimeType(absolute) };
  }
  /** Reads an open file, never more than its checked size or the limit. */
  async function readBounded(target: Awaited<ReturnType<typeof file>>, limit: number): Promise<Buffer> {
    if (target.size > limit) throw new DotDeliverableError(413, "DOT_DELIVERABLE_TOO_LARGE", "The file is larger than Agent Files accept.");
    const buffer = Buffer.alloc(target.size);
    let offset = 0;
    while (offset < target.size) {
      const { bytesRead } = await target.handle.read(buffer, offset, target.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  }
  /** The workspace file's sha256, pinned when a Dot asks to publish it. */
  async function fingerprint(owner: string, dotId: string, path: string): Promise<string> {
    const target = await file(owner, dotId, path);
    try { return createHash("sha256").update(await readBounded(target, deps.maxBytes)).digest("hex"); }
    finally { await target.handle.close(); }
  }
  async function publish(owner: string, dotId: string, raw: unknown, publishedBy: "USER" | "DOT", request: FastifyRequest | null,
    expectedSha256: string | null = null): Promise<{ deliverable: DotDeliverable; unchanged: boolean }> {
    const input = publishDotDeliverableInputSchema.parse(raw);
    const dot = await dotFor(owner, dotId);
    const room = await Promise.resolve().then(() => deps.store.getRoom(input.roomId)).catch(() => null);
    if (!room || room.ownerUserId !== owner) throw new DotDeliverableError(404, "DOT_ROOM_NOT_FOUND", "Room was not found.");
    const target = await file(owner, dotId, input.path);
    let buffer: Buffer;
    try { buffer = await readBounded(target, deps.maxBytes); } finally { await target.handle.close(); }
    const sourceSha256 = createHash("sha256").update(buffer).digest("hex");
    // What the owner approved is exactly what is published.
    if (expectedSha256 && expectedSha256 !== sourceSha256) {
      throw new DotDeliverableError(409, "DOT_DELIVERABLE_CHANGED", "The file changed after the publication was requested. Ask again to publish the new content.");
    }
    const name = relative(await realpath(root(dotId)), target.absolute).split(sep).join("/");
    const existing = await deps.deliverables.bySource(dotId, name, sourceSha256);
    if (existing) return { deliverable: existing, unchanged: true };
    const artifact = await deps.publishArtifact({ roomId: room.id, dotName: dot.name, filename: target.name, mimeType: target.mimeType, buffer });
    const deliverable = await deps.deliverables.addVersion({ dotId, ownerUserId: owner, roomId: room.id, name, artifactId: artifact.id,
      sha256: artifact.sha256, sourceSha256, byteSize: artifact.byteSize, mimeType: artifact.mimeType, publishedBy });
    await deps.audit(request, "dot.deliverable.publish", { dotId, roomId: room.id, deliverableId: deliverable.deliverableId, version: deliverable.version,
      artifactId: artifact.id, publishedBy });
    return { deliverable, unchanged: false };
  }
  async function list(owner: string, dotId: string): Promise<DotDeliverable[]> {
    await dotFor(owner, dotId);
    return deps.deliverables.list(owner, dotId, 200);
  }
  return { folder, file, publish, list, fingerprint };
}
export type DotDeliverablesService = ReturnType<typeof createDotDeliverablesService>;

export function registerDotDeliverableRoutes(app: FastifyInstance, service: DotDeliverablesService | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const user = (action: (request: FastifyRequest, reply: FastifyReply, owner: string, service: DotDeliverablesService) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!service) return reply.code(503).send({ error: { code: "DOT_DELIVERABLES_UNAVAILABLE", message: "Deliverables are unavailable." } });
      try { return await action(request, reply, await options.authenticatedOwner(request), service); }
      catch (error) {
        if (error instanceof DotDeliverableError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "DOT_WORKSPACE_INVALID", message: "Workspace request is invalid." } });
        throw error;
      }
    };
  app.get("/api/dots/:dotId/workspace", options.routeOptions, user(async (request, _reply, owner, service) => {
    const { dotId } = params.parse(request.params);
    const { folder } = z.object({ folder: z.string().max(500).optional() }).strict().parse(request.query);
    return service.folder(owner, dotId, folder?.trim() ?? "");
  }));
  app.get("/api/dots/:dotId/workspace/file", options.routeOptions, user(async (request, reply, owner, service) => {
    const { dotId } = params.parse(request.params);
    const { path, download } = z.object({ path: z.string().min(1).max(500), download: z.enum(["1"]).optional() }).strict().parse(request.query);
    const target = await service.file(owner, dotId, path);
    const inline = !download && inlineTypes.has(target.mimeType);

    // Workspace files are untrusted: never run them in Space's origin.
    reply.header("content-type", target.mimeType.startsWith("text/") ? `${target.mimeType}; charset=utf-8` : target.mimeType)
      .header("content-length", String(target.size))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
      .header("cache-control", "private, no-store")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(target.name)}`);
    if (target.size === 0) { await target.handle.close(); return reply.send(""); }
    return reply.send(target.handle.createReadStream({ start: 0, end: target.size - 1, autoClose: true }));
  }));
  app.get("/api/dots/:dotId/deliverables", options.routeOptions, user(async (request, _reply, owner, service) => {
    const { dotId } = params.parse(request.params);
    return { dotId, items: await service.list(owner, dotId) };
  }));
  app.post("/api/dots/:dotId/deliverables", options.routeOptions, user(async (request, _reply, owner, service) => {
    const { dotId } = params.parse(request.params);
    return service.publish(owner, dotId, request.body ?? {}, "USER", request);
  }));
}
