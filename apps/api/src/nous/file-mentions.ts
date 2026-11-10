import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileMentionFolder, findFileMentions, type AgentFileRef, type Artifact } from "@space/contracts";
import { artifactFilename } from "../artifact-storage.js";

/**
 * Files always in Agent Files (operator 4/11 13:55 BKK, nous_msg:8e7e6c25): a workspace path an appointment, a card, a decision or a
 * Done record names is filed in Agent Files (the same file is filed once: an Agent File with its content is reused) and its id is
 * written beside it; the web's click on a path files it the same way and opens its preview.
 */
export interface FileMentionsDeps {
  /** Nous's guarded workspace read (files.publishable): inside the workspace, no secret, a pane's file copied and redacted first. */
  publishable(path: string): Promise<{ sourceRoot: string; sourcePath: string; shown: string; copiedFrom: string | null }>;
  add(owner: string, input: { roomId: string; sourceRoot: string; sourcePath: string; filename: string; folder: string; copiedFrom?: string | null }): Promise<Artifact>;
  rooms(owner: string): Promise<Array<{ id: string }>>;
  agentFiles(roomId: string): Promise<Artifact[]>;
  /** The host's workspace is the operator's: only an ADMIN or OPERATOR owner's texts and clicks reach it. */
  allowed(owner: string): Promise<boolean>;
}

export type FileMentions = ReturnType<typeof createFileMentions>;

/** An ASCII name (Agent File names stay ASCII since the 2026-10-25 storage fix), the content's hash when nothing ASCII is left. */
export function asciiFileName(name: string, sha256: string): string {
  const ext = extname(name).replace(/[^\x21-\x7e]/g, "");
  const stem = basename(name, extname(name)).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return `${stem || `file-${sha256.slice(0, 8)}`}${ext}`;
}

export function createFileMentions(deps: FileMentionsDeps) {
  const inFlight = new Map<string, Promise<Artifact>>();

  async function file(owner: string, path: string, folder: string): Promise<Artifact> {
    if (!(await deps.allowed(owner))) throw Object.assign(new Error("Only the operator's workspace files open as Agent Files."), { statusCode: 403 });
    const source = await deps.publishable(path);
    const sha256 = createHash("sha256").update(await readFile(source.sourcePath)).digest("hex");
    const rooms = await deps.rooms(owner);
    for (const room of rooms) {
      const found = (await deps.agentFiles(room.id)).find((artifact) => !artifact.deletedAt
        && (artifact.sha256 === sha256 || artifact.metadata.agentFileSourceSha256 === sha256));
      if (found) {
        // The copy publishable made of a pane's file is not needed: that content is filed already.
        if (source.copiedFrom) await unlink(source.sourcePath).catch(() => undefined);
        return found;
      }
    }
    if (!rooms[0]) throw new Error("There is no room for Agent Files yet.");
    const original = source.copiedFrom ? basename(source.copiedFrom) : basename(source.shown);
    return deps.add(owner, { roomId: rooms[0].id, sourceRoot: source.sourceRoot, sourcePath: source.sourcePath, filename: asciiFileName(original, sha256),
      folder, copiedFrom: source.copiedFrom });
  }

  /** The Agent File of a workspace path: the one with its content, or a new one in `folder`. One filing at a time per path. */
  function publish(owner: string, path: string, folder = fileMentionFolder(path)): Promise<Artifact> {
    const key = `${owner}\u0000${path}`;
    const running = inFlight.get(key);
    if (running) return running;
    const work = file(owner, path, folder).finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
  }

  /** The text with ` (artifact:<id>)` after each workspace path it names (a path already followed by an id is left); a path that
   *  cannot be filed (missing, private, a secret) stays as it is. `hint` (e.g. an appointment's kind) picks the folder too. */
  async function annotate(owner: string, text: string, hint = ""): Promise<string> {
    const paths = findFileMentions(text).filter((mention) => mention.kind === "path");
    if (!paths.length || !(await deps.allowed(owner).catch(() => false))) return text;
    let out = text;
    for (const mention of paths.reverse()) {
      if (/^\s*\(?artifact:/.test(text.slice(mention.end, mention.end + 16))) continue;
      const artifact = await publish(owner, mention.text, fileMentionFolder(mention.text, hint)).catch(() => null);
      if (artifact) out = `${out.slice(0, mention.end)} (${artifact.id})${out.slice(mention.end)}`;
    }
    return out;
  }

  /** Every Agent File of the owner's rooms, as a Needs you card's `payload.files` names them (nous_msg:0cb8d563). */
  async function files(owner: string): Promise<AgentFileRef[]> {
    const lists = await Promise.all((await deps.rooms(owner)).map((room) => deps.agentFiles(room.id)));
    return lists.flat().filter((artifact) => !artifact.deletedAt).map((artifact) => ({ artifactId: artifact.id, name: artifactFilename(artifact),
      folder: typeof artifact.metadata.folder === "string" ? artifact.metadata.folder : null, mime: artifact.mimeType }));
  }

  return { publish, annotate, files };
}
