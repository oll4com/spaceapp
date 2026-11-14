import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { idSchema, isAgentFileArtifact, type Artifact, type Room } from "@space/contracts";
import type { NousRepository } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
import { artifactFilename } from "../artifact-storage.js";

/**
 * Agent Files shared to the Nous app (plan clipboard:RQSrp1EczBbV, operator 31/10 00:25 BKK): Nous shares one of the owner's Agent
 * Files for a short time, so the operator sees it in the Nous app while approving there. A share is its own temporary row (class B);
 * removing it never touches the Agent File, which opens through the existing /api/artifacts/:id/file and /preview.
 */
export const NOUS_SHARE_DEFAULT_HOURS = 72;

export const shareFileArgsSchema = z.object({
  artifactId: idSchema.describe("The Agent File's artifact id (space_files_list with artifacts AGENT_FILES)."),
  note: z.string().trim().min(1).max(500).optional().describe("What the operator should look at or approve, one or two lines."),
  hours: z.number().positive().optional().describe(`How long it stays shared: ${NOUS_SHARE_DEFAULT_HOURS} by default, any length.`)
});

/** One row of GET /api/nous/shared-files (the Nous app's contract: keep these names). */
export interface NousSharedFile {
  shareId: string; artifactId: string; name: string; folder: string | null; mime: string; size: number; note: string | null; sharedAt: string; expiresAt: string;
}

export type NousSharedFiles = ReturnType<typeof createNousSharedFiles>;

export function createNousSharedFiles(deps: {
  repository: Pick<NousRepository, "addFileShare" | "listFileShares" | "removeFileShare">;
  getArtifact(id: string): Promise<Artifact>;
  rooms(owner: string): Promise<Room[]>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  /** The owner's Agent File, or null: Media, another owner's file and a deleted one are never shared. */
  const agentFile = async (rooms: Set<string>, id: string) => {
    const artifact = await deps.getArtifact(id).catch(() => null);
    return artifact && !artifact.deletedAt && isAgentFileArtifact(artifact) && artifact.roomId && rooms.has(artifact.roomId) ? artifact : null;
  };
  const roomIds = async (owner: string) => new Set((await deps.rooms(owner)).map((room) => room.id));
  async function list(owner: string): Promise<NousSharedFile[]> {
    const [shares, rooms] = await Promise.all([deps.repository.listFileShares(owner), roomIds(owner)]);
    const files = await Promise.all(shares.map(async (share) => {
      const artifact = await agentFile(rooms, share.artifactId);
      return artifact ? {
        shareId: share.id, artifactId: artifact.id, name: artifactFilename(artifact), folder: typeof artifact.metadata.folder === "string" ? artifact.metadata.folder : null,
        mime: artifact.mimeType, size: artifact.byteSize, note: share.note, sharedAt: share.sharedAt, expiresAt: share.expiresAt
      } : null;
    }));
    return files.filter((file): file is NousSharedFile => file !== null);
  }
  return {
    list,
    remove: (owner: string, shareId: string) => deps.repository.removeFileShare(owner, shareId),
    async share(owner: string, args: z.infer<typeof shareFileArgsSchema>): Promise<{ ok: boolean; display: string; result: string }> {
      // 13/11 15:40 (×2, then files_list): a bare id is the artifact's id without its "artifact:" prefix, as space_execute takes it.
      const id = /^[A-Za-z0-9_-]{6,80}$/.test(args.artifactId) ? `artifact:${args.artifactId}` : args.artifactId;
      const artifact = await agentFile(await roomIds(owner), id);
      if (!artifact) return { ok: false, display: "Not shared", result: `No Agent File ${id} in your rooms: only the operator's Agent Files are shared (list them with space_files_list artifacts AGENT_FILES).` };
      const hours = args.hours ?? NOUS_SHARE_DEFAULT_HOURS;
      const at = now();
      const share = await deps.repository.addFileShare({ ownerUserId: owner, artifactId: artifact.id, note: args.note ?? null, sharedBy: "nous",
        sharedAt: new Date(at).toISOString(), expiresAt: new Date(at + hours * 3_600_000).toISOString() });
      const name = artifactFilename(artifact);
      return { ok: true, display: `Shared ${name} to the Nous app`, result: `Shared ${name} (${artifact.id}) to the Nous app as ${share.id} until ${share.expiresAt}`
        + `. The operator opens it from the shared files icon; removing it there removes only the share.` };
    },
    async render(owner: string): Promise<string> {
      const files = await list(owner);
      return files.length ? files.map((file) => `- ${file.shareId} · ${file.name} (${file.artifactId})${file.note ? ` · ${file.note}` : ""} · until ${file.expiresAt}`).join("\n")
        : "No file is shared to the Nous app.";
    }
  };
}

/** The Nous app's view: the owner's shared files, and removing one share (a person's or the app's own device session only). */
export function registerNousSharedFileRoutes(app: FastifyInstance, deps: {
  files: NousSharedFiles; routeOptions: Record<string, unknown>; owner(request: FastifyRequest): Promise<string>; assertPerson(request: FastifyRequest): void;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
}): void {
  app.get("/api/nous/shared-files", deps.routeOptions, async (request) => deps.files.list(await deps.owner(request)));
  app.delete("/api/nous/shared-files/:shareId", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    deps.assertPerson(request);
    const { shareId } = deps.parseQuery(z.object({ shareId: idSchema }).strict(), request.params);
    if (!await deps.files.remove(owner, shareId)) throw new SpaceNotFoundError("This share does not exist or has expired.");
    return { removed: true };
  });
}
