import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, truncate, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { InstanceLinkReply } from "./client.js";

/** One request into the linked SpaceApp (its link session); the body is JSON or raw bytes. */
export type LinkCall = (method: "GET" | "POST", path: string, body?: unknown, headers?: Record<string, string>) => Promise<InstanceLinkReply>;

/**
 * Technical bounds (the link channel, apps/api/src/mobile/channel.ts): an answer over 64 MiB is refused and 64 MiB is also the whole
 * channel's buffer, so a 64 MiB piece would leave other requests "busy"; downloads use 32 MiB Range pieces. An upload body over 25 MiB is
 * refused, so uploads use the chunk route's 16 MiB pieces. A file of any size goes through in as many pieces as it needs.
 */
export const LINK_PULL_PIECE_BYTES = 32 * 1024 * 1024;
export const LINK_PUSH_PIECE_BYTES = 16 * 1024 * 1024;

export class LinkFileError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly refused?: boolean;
  constructor(message: string, options?: { status?: number; code?: string; refused?: boolean }) {
    super(message);
    this.status = options?.status;
    this.code = options?.code;
    this.refused = options?.refused;
  }
}

export type PullLinkFileResult =
  | { folder: true; path: string; entries: Array<{ name: string; folder: boolean }> }
  | { folder: false; shown: string; size: number; sha256: string; resumedFrom: number; already: boolean };

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const piece of createReadStream(file)) hash.update(piece as Buffer);
  return hash.digest("hex");
}

// A link sends path ids as they are (linkRoute refuses an encoded byte), so an id is checked here instead.
function linkId(value: string, what: string): string {
  if (!/^[A-Za-z0-9_:-]{1,200}$/.test(value)) throw new LinkFileError(`${value} is not ${what} id (letters, digits, _ : -).`, { status: 400, code: "INVALID_ID", refused: true });
  return value;
}

const answerText = (reply: InstanceLinkReply) => typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
const remoteErrorInfo = (reply: InstanceLinkReply): { code?: string; message?: string } => {
  const error = (reply.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!error || typeof error !== "object") return {};
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    message: typeof error.message === "string" ? error.message : undefined
  };
};
// Matches mobile/channel.ts pathProblem: reject traversal/backslashes/encoded separators before sending, and keep "/" unencoded so nested paths pass the channel gate.
const REMOTE_PATH_TRAVERSAL = /\.\.|\\|%2e|%2f|%5c/i;
const encodePathQuery = (value: string) => value.split("/").map(encodeURIComponent).join("/");

/**
 * Pulls a file of the linked SpaceApp (a workspace path or an Agent File/screenshot id) into `destination` (absolute, this side's own
 * folder): 32 MiB Range pieces appended to `<destination>.part`, so a pull cut off resumes where it stopped, then the SHA-256 the other
 * side named is checked before the file takes its name. `destinationFor` gets the other side's file name (untrusted, its base name only).
 * When the remote path is a folder, returns its directory listing instead of throwing.
 */
export async function pullLinkFile(call: LinkCall, source: { path?: string; artifactId?: string }, destinationFor: (name: string) => { absolute: string; shown: string }): Promise<PullLinkFileResult> {
  const artifactId = source.artifactId ? linkId(source.artifactId, "an artifact") : null;
  const remotePath = (source.path ?? "").trim();
  if (!artifactId && REMOTE_PATH_TRAVERSAL.test(remotePath)) {
    throw new LinkFileError(`Invalid remote path "${remotePath}": path traversal (.., \\, or encoded separators) is not allowed. Give a path relative to the remote agent workspace, e.g. "reports/file.md".`,
      { status: 400, code: "MOBILE_BAD_PATH", refused: true });
  }
  const encodedPath = artifactId ? "" : encodePathQuery(remotePath);
  const info = artifactId
    ? await call("GET", `/api/artifacts/${artifactId}/metadata`)
    : await call("GET", `/api/nous/files/stat?path=${encodedPath}`);
  if (info.status >= 400) {
    const { code, message } = remoteErrorInfo(info);
    const detail = message || answerText(info);
    if (info.status === 400) {
      throw new LinkFileError(`Remote path rejected (400${code ? ` ${code}` : ""}): ${detail} Give a valid path relative to the remote agent workspace without traversal (.. or \\).`,
        { status: 400, code, refused: true });
    }
    if (info.status === 404) {
      throw new LinkFileError(`Remote file not found (404): ${detail}`, { status: 404, code, refused: true });
    }
    throw new LinkFileError(`It answered ${info.status}: ${answerText(info)}`, { status: info.status, code });
  }
  const body = (source.artifactId ? (info.body as { artifact?: unknown })?.artifact : info.body) as Record<string, unknown> | null;
  if (body?.folder === true) {
    const entries = Array.isArray(body.entries)
      ? (body.entries as Array<{ name?: unknown; folder?: unknown }>).map((entry) => ({ name: String(entry.name ?? ""), folder: entry.folder === true }))
      : [];
    return { folder: true, path: String(body.path ?? (remotePath || ".")), entries };
  }
  const size = Number(source.artifactId ? body?.byteSize : body?.size);
  const sha256 = typeof body?.sha256 === "string" && /^[a-f0-9]{64}$/.test(body.sha256) ? body.sha256 : null;
  const name = basename(String((source.artifactId ? body?.filename : body?.path) ?? "")).replace(/[\0/\\]/g, "") || "file";
  if (!Number.isSafeInteger(size) || size < 0) throw new LinkFileError(`It named no size for that file: ${answerText(info)}`);
  const destination = destinationFor(name);
  if (sha256 && await stat(destination.absolute).then((one) => one.size === size, () => false) && await fileSha256(destination.absolute) === sha256) {
    return { folder: false, shown: destination.shown, size, sha256, resumedFrom: size, already: true };
  }
  await mkdir(dirname(destination.absolute), { recursive: true });
  const part = `${destination.absolute}.part`;
  let offset = await stat(part).then((one) => one.size, () => 0);
  if (offset > size) { await truncate(part, 0); offset = 0; }
  const resumedFrom = offset;
  const contentPath = artifactId ? `/api/artifacts/${artifactId}/file` : `/api/nous/files/content?path=${encodedPath}`;
  const handle = await open(part, "a", 0o600);
  try {
    while (offset < size) {
      const end = Math.min(size, offset + LINK_PULL_PIECE_BYTES) - 1;
      const piece = await call("GET", contentPath, undefined, { range: `bytes=${offset}-${end}` });
      if (piece.status !== 206 || piece.headers["content-range"] !== `bytes ${offset}-${end}/${size}` || piece.bytes.length !== end - offset + 1) {
        throw new LinkFileError(`The piece at byte ${offset} came back as ${piece.status} ${piece.headers["content-range"] ?? ""} (${piece.bytes.length} bytes); `
          + `the file there may have changed. ${offset} of ${size} bytes are kept and the next pull resumes from them.`);
      }
      await handle.write(piece.bytes);
      offset = end + 1;
    }
    await handle.sync();
  } finally { await handle.close(); }
  const got = await fileSha256(part);
  if (sha256 && got !== sha256) {
    await unlink(part).catch(() => undefined);
    throw new LinkFileError(`The pieces add up to SHA-256 ${got}, not the ${sha256} it named (the file changed there while it was read); nothing kept, pull it again.`);
  }
  await rename(part, destination.absolute);
  return { folder: false, shown: destination.shown, size, sha256: got, resumedFrom, already: false };
}

/**
 * Pushes a file of this side into a room's Agent Files on the linked SpaceApp: 16 MiB pieces through its chunk route with the file's
 * SHA-256. The upload id comes from the file's SHA-256 and the room, so a push cut off and asked again resumes from what arrived (the
 * route answers how much it holds) and a push that already finished answers its Agent File again instead of a second copy.
 */
export async function pushLinkFile(call: LinkCall, source: { file: string; name: string; mimeType?: string }, roomId: string, folder?: string) {
  const size = (await stat(source.file)).size;
  if (size === 0) throw new LinkFileError("That file is empty; Agent Files keep no empty file.");
  const sha256 = await fileSha256(source.file);
  const uploadId = createHash("sha256").update(`${sha256}:${roomId}`).digest("base64url").slice(0, 43);
  const room = linkId(roomId, "a room");
  const query = (offset: number) => `/api/rooms/${room}/agent-files/chunks?${new URLSearchParams({ uploadId, offset: String(offset), total: String(size),
    name: source.name, sha256, ...(source.mimeType ? { type: source.mimeType } : {}), ...(folder ? { folder } : {}) })}`;
  const handle = await open(source.file, "r");
  try {
    let offset = 0;
    let resumedFrom: number | null = null;
    for (;;) {
      const length = Math.min(LINK_PUSH_PIECE_BYTES, size - offset);
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, offset);
      const reply = await call("POST", query(offset), new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      if (reply.status >= 400) throw new LinkFileError(`It answered ${reply.status} at byte ${offset}: ${answerText(reply)}`);
      const answer = reply.body as { received?: unknown; artifact?: { id?: string; filename?: string } } | null;
      const received = Number(answer?.received);
      if (answer?.artifact?.id) return { artifactId: answer.artifact.id, name: answer.artifact.filename ?? source.name, size, sha256, resumedFrom: resumedFrom ?? 0 };
      if (!Number.isSafeInteger(received) || received < 0 || received > size) throw new LinkFileError(`It answered no received size: ${answerText(reply)}`);
      // The first answer says what it already held (the piece at 0 writes nothing then): the push goes on from there.
      resumedFrom ??= received === bytesRead ? 0 : received;
      if (received <= offset && received !== 0) throw new LinkFileError(`It holds ${received} bytes after the piece at ${offset}; nothing more was sent.`);
      if (received === 0 && offset > 0) throw new LinkFileError("It dropped the pieces it held (a stale or finished upload); push it again.");
      offset = received;
    }
  } finally { await handle.close(); }
}
