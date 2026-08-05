import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import sanitizeHtml from "sanitize-html";
import { idSchema, isAgentFileArtifact, type Artifact } from "@space/contracts";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { z } from "zod";
import type { SpaceApiConfig } from "./config.js";

export const cliAgentFilesTokenHeader = "x-space-cli-agent-files-token";
export const agentFileMaxBytes = 100 * 1024 * 1024;
export const agentFileMaxCount = 8;
export const agentFileMaxRequestBytes = 250 * 1024 * 1024;
export const agentFileTextPreviewMaxBytes = 512 * 1024;
export const agentFileDocxPreviewMaxBytes = 20 * 1024 * 1024;
export const agentFileDocxNormalizationTimeoutMs = 30_000;
export const agentFileStorageMode = 0o644;
export const agentFileDirectoryMode = 0o750;

const tokenPrefix = "cliagentfiles.v1";
const defaultTokenTtlMs = 12 * 60 * 60 * 1000;
const execFileAsync = promisify(execFile);
const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const textExtensions = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env.example",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);
const mimeByExtension: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".docx": docxMimeType,
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp"
};
const cliAgentFilesTokenPayloadSchema = z.object({
  roomId: idSchema,
  paneId: idSchema,
  cliSessionId: idSchema,
  iat: z.number().int().min(0),
  exp: z.number().int().min(0)
});

export type CliAgentFilesTokenPayload = z.infer<typeof cliAgentFilesTokenPayloadSchema>;

export interface CliAgentFilesContext {
  roomId?: string | null;
  paneId?: string | null;
  cliSessionId?: string | null;
}

export interface PersistAgentFileInput {
  store: SpaceStore;
  artifactRoot: string;
  roomId: string;
  paneId: string;
  cliSessionId: string;
  runtimeId: string;
  originalFilename: string;
  declaredMimeType: string;
  buffer: Buffer;
  traceId: string;
  docxNormalizer?: AgentFileDocxNormalizer;
  source?: "AGENT_OUTPUT" | "AGENT_OUTPUT_BACKFILL";
  backfillProvenance?: {
    sourceStorageUri: string;
    sourceArtifactId: string | null;
  };
}

export type AgentFilePreviewKind = "IMAGE" | "VIDEO" | "AUDIO" | "PDF" | "TEXT" | "DOCX" | "NONE";

export interface AgentFileDocxNormalizerInput {
  buffer: Buffer;
  originalFilename: string;
}

export type AgentFileDocxNormalizer = (input: AgentFileDocxNormalizerInput) => Promise<Buffer>;

export interface NormalizeAgentFileDocxOptions {
  command?: string;
  brokerCommand?: string;
  temporaryRoot?: string;
  timeoutMs?: number;
}

export class AgentFileDocxNormalizationError extends Error {
  constructor(message = "The DOCX could not be rebuilt into a Word-compatible file.") {
    super(message);
    this.name = "AgentFileDocxNormalizationError";
  }
}

function signingSecret(config: Pick<SpaceApiConfig, "internalApiToken">): string | null {
  return config.internalApiToken ? `cli-agent-files:${config.internalApiToken}` : null;
}

function signPayload(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "item";
}

function safeOriginalFilename(value: string): string {
  const leaf = value.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").slice(0, 220);
  return sanitized || "agent-file";
}

function startsWithBytes(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function sniffKnownMime(buffer: Buffer): string | null {
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8192));
  return !sample.includes(0);
}

export function resolveAgentFileMimeType(originalFilename: string, declaredMimeType: string, buffer: Buffer): string {
  const extension = extname(originalFilename).toLowerCase();
  const sniffed = sniffKnownMime(buffer);
  if (sniffed) return sniffed;
  if (extension === ".docx" && startsWithBytes(buffer, [0x50, 0x4b])) return docxMimeType;
  if (extension === ".html" || extension === ".htm" || extension === ".svg") return "text/plain";
  if (textExtensions.has(extension) && looksLikeText(buffer)) {
    return mimeByExtension[extension] ?? "text/plain";
  }
  const extensionMime = mimeByExtension[extension];
  if (extensionMime) return extensionMime;
  const normalizedDeclared = declaredMimeType.trim().toLowerCase();
  if (normalizedDeclared.startsWith("text/") && looksLikeText(buffer)) return normalizedDeclared;
  return "application/octet-stream";
}

export async function normalizeAgentFileDocx(
  input: AgentFileDocxNormalizerInput,
  options: NormalizeAgentFileDocxOptions = {}
): Promise<Buffer> {
  if (!startsWithBytes(input.buffer, [0x50, 0x4b])) {
    throw new AgentFileDocxNormalizationError("The DOCX source is not a valid Office package.");
  }
  const directCommand = options.command ?? process.env.SPACE_LIBREOFFICE_PATH;
  const temporaryRoot = options.temporaryRoot ??
    (directCommand ? tmpdir() : process.env.SPACE_AGENT_FILE_DOCX_WORK_ROOT ?? "/opt/spaceapp/var/agent-docx-work");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const workingRoot = await mkdtemp(join(temporaryRoot, "request-"));
  const inputDirectory = join(workingRoot, "input");
  const outputDirectory = join(workingRoot, "output");
  const homeDirectory = join(workingRoot, "home");
  const cacheDirectory = join(workingRoot, "cache");
  const temporaryDirectory = join(workingRoot, "tmp");
  const profileDirectory = join(workingRoot, "profile");
  const sourcePath = join(inputDirectory, "document.docx");
  const outputPath = join(outputDirectory, "document.docx");

  try {
    await Promise.all([
      mkdir(inputDirectory, { mode: 0o700 }),
      mkdir(outputDirectory, { mode: 0o700 }),
      mkdir(homeDirectory, { mode: 0o700 }),
      mkdir(cacheDirectory, { mode: 0o700 }),
      mkdir(temporaryDirectory, { mode: 0o700 })
    ]);
    await writeFile(sourcePath, input.buffer, { flag: "wx", mode: 0o600 });
    if (directCommand) {
      await execFileAsync(
        directCommand,
        [
          "--headless",
          "--nologo",
          "--nodefault",
          "--nolockcheck",
          "--norestore",
          "--nofirststartwizard",
          `-env:UserInstallation=${pathToFileURL(profileDirectory).href}`,
          "--convert-to",
          "docx:Office Open XML Text",
          "--outdir",
          outputDirectory,
          sourcePath
        ],
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? agentFileDocxNormalizationTimeoutMs,
          maxBuffer: 256 * 1024,
          env: {
            ...process.env,
            HOME: homeDirectory,
            XDG_CACHE_HOME: cacheDirectory,
            TMPDIR: temporaryDirectory,
            SAL_USE_VCLPLUGIN: "svp"
          }
        }
      );
    } else {
      await writeFile(
        join(workingRoot, "request.json"),
        `${JSON.stringify({ contract: "SpaceAgentDocxNormalizationRequestV1" })}\n`,
        { flag: "wx", mode: 0o600 }
      );
      await execFileAsync(
        options.brokerCommand ?? "/usr/bin/sudo",
        ["-n", "/opt/spaceapp/bin/space-docx-normalizer"],
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? agentFileDocxNormalizationTimeoutMs + 15_000,
          maxBuffer: 256 * 1024
        }
      );
      const result = JSON.parse(await readFile(join(workingRoot, "result.json"), "utf8")) as {
        contract?: string;
        ok?: boolean;
      };
      if (result.contract !== "SpaceAgentDocxNormalizationResultV1" || result.ok !== true) {
        throw new AgentFileDocxNormalizationError();
      }
    }
    const normalized = await readFile(outputPath);
    if (
      normalized.byteLength <= 0 ||
      normalized.byteLength > agentFileMaxBytes ||
      !startsWithBytes(normalized, [0x50, 0x4b])
    ) {
      throw new AgentFileDocxNormalizationError("The Word-compatible DOCX rebuild produced an invalid package.");
    }
    const sourceSha256 = createHash("sha256").update(input.buffer).digest("hex");
    const normalizedSha256 = createHash("sha256").update(normalized).digest("hex");
    if (sourceSha256 === normalizedSha256) {
      throw new AgentFileDocxNormalizationError("The Word-compatible DOCX rebuild did not rewrite the package.");
    }
    return normalized;
  } catch (error) {
    if (error instanceof AgentFileDocxNormalizationError) throw error;
    throw new AgentFileDocxNormalizationError();
  } finally {
    await rm(workingRoot, { recursive: true, force: true });
  }
}

function agentFilePreviewKindFor(mimeTypeValue: string, filename: string): AgentFilePreviewKind {
  const mimeType = mimeTypeValue.toLowerCase();
  const extension = extname(filename).toLowerCase();
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType === docxMimeType || extension === ".docx") return "DOCX";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    textExtensions.has(extension)
  ) {
    return "TEXT";
  }
  return "NONE";
}

export function agentFilePreviewKind(artifact: Artifact): AgentFilePreviewKind {
  const filename = typeof artifact.metadata.originalFilename === "string" ? artifact.metadata.originalFilename : "";
  return agentFilePreviewKindFor(artifact.mimeType, filename);
}

export function cliAgentFilesEnabled(config: Pick<SpaceApiConfig, "internalApiToken">): boolean {
  return Boolean(config.internalApiToken);
}

export function issueCliAgentFilesToken(
  config: Pick<SpaceApiConfig, "internalApiToken">,
  context: CliAgentFilesContext,
  nowMs = Date.now()
): string | null {
  const secret = signingSecret(config);
  if (!secret || !context.roomId || !context.paneId || !context.cliSessionId) return null;
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = cliAgentFilesTokenPayloadSchema.parse({
    roomId: context.roomId,
    paneId: context.paneId,
    cliSessionId: context.cliSessionId,
    iat: issuedAt,
    exp: Math.floor((nowMs + defaultTokenTtlMs) / 1000)
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${tokenPrefix}.${encodedPayload}.${signPayload(secret, encodedPayload)}`;
}

export function verifyCliAgentFilesToken(
  config: Pick<SpaceApiConfig, "internalApiToken">,
  token: string | null | undefined,
  nowMs = Date.now()
): CliAgentFilesTokenPayload | null {
  const secret = signingSecret(config);
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [prefix, version, encodedPayload, signature] = parts;
  if (`${prefix}.${version}` !== tokenPrefix || !encodedPayload || !signature) return null;
  const expected = signPayload(secret, encodedPayload);
  if (!secureEqual(expected, signature)) return null;
  try {
    const payload = cliAgentFilesTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"))
    );
    if (payload.exp <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function cliAgentFilesApiBaseUrl(
  config: Pick<SpaceApiConfig, "host" | "port" | "browserEvidenceTargetOrigin">
): string {
  if (config.browserEvidenceTargetOrigin) return config.browserEvidenceTargetOrigin.replace(/\/+$/, "");
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}`;
}

export function agentFileStoragePath(input: {
  artifactRoot: string;
  roomId: string;
  paneId: string;
  cliSessionId: string;
  day: string;
  storedFilename: string;
}): string {
  return join(
    input.artifactRoot,
    "agent-files",
    safeStorageSegment(input.roomId),
    safeStorageSegment(input.paneId),
    safeStorageSegment(input.cliSessionId),
    safeStorageSegment(input.day),
    safeStorageSegment(input.storedFilename)
  );
}

export async function persistAgentFile(input: PersistAgentFileInput) {
  const originalFilename = safeOriginalFilename(input.originalFilename);
  const sourceMimeType = resolveAgentFileMimeType(originalFilename, input.declaredMimeType, input.buffer);
  const sourceSha256 = createHash("sha256").update(input.buffer).digest("hex");
  const shouldNormalizeDocx = sourceMimeType === docxMimeType;
  const persistedBuffer = shouldNormalizeDocx
    ? await (input.docxNormalizer ?? normalizeAgentFileDocx)({
        buffer: input.buffer,
        originalFilename
      })
    : input.buffer;
  if (shouldNormalizeDocx && (persistedBuffer.byteLength <= 0 || persistedBuffer.byteLength > agentFileMaxBytes)) {
    throw new AgentFileDocxNormalizationError("The Word-compatible DOCX rebuild produced an invalid file size.");
  }
  if (
    shouldNormalizeDocx &&
    createHash("sha256").update(persistedBuffer).digest("hex") === sourceSha256
  ) {
    throw new AgentFileDocxNormalizationError("The Word-compatible DOCX rebuild did not rewrite the package.");
  }
  const mimeType = resolveAgentFileMimeType(originalFilename, input.declaredMimeType, persistedBuffer);
  if (shouldNormalizeDocx && mimeType !== docxMimeType) {
    throw new AgentFileDocxNormalizationError("The Word-compatible DOCX rebuild produced an invalid package.");
  }
  const day = new Date().toISOString().slice(0, 10);
  const fileId = safeStorageSegment(makeSpaceId("agent_file"));
  const storedFilename = `${fileId}-${originalFilename}`;
  const filePath = agentFileStoragePath({
    artifactRoot: input.artifactRoot,
    roomId: input.roomId,
    paneId: input.paneId,
    cliSessionId: input.cliSessionId,
    day,
    storedFilename
  });
  const partialPath = `${filePath}.partial-${safeStorageSegment(makeSpaceId("write"))}`;
  const storageUri =
    `space-artifact://agent-files/${encodeURIComponent(input.roomId)}/${encodeURIComponent(input.paneId)}/` +
    `${encodeURIComponent(input.cliSessionId)}/${day}/${encodeURIComponent(storedFilename)}`;
  const sha256 = createHash("sha256").update(persistedBuffer).digest("hex");
  const kind: Artifact["kind"] = mimeType.startsWith("image/")
    ? "IMAGE"
    : mimeType.startsWith("video/")
      ? "VIDEO"
      : "EXPORT";

  const storageDirectory = dirname(filePath);
  await mkdir(storageDirectory, { recursive: true, mode: agentFileDirectoryMode });
  await chmod(storageDirectory, agentFileDirectoryMode);
  let persisted = false;
  try {
    await writeFile(partialPath, persistedBuffer, { flag: "wx", mode: agentFileStorageMode });
    await rename(partialPath, filePath);
    persisted = true;
    await chmod(filePath, agentFileStorageMode);
    await verifyFileHash(filePath, sha256, persistedBuffer.byteLength);
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    if (persisted) await unlink(filePath).catch(() => undefined);
    throw error;
  }

  try {
    return await input.store.createArtifact(
      {
        roomId: input.roomId,
        paneId: input.paneId,
        kind,
        mimeType,
        storageUri,
        sha256,
        byteSize: persistedBuffer.byteLength,
        metadata: {
          source: input.source ?? "AGENT_OUTPUT",
          originalFilename,
          storedFilename,
          cliSessionId: input.cliSessionId,
          runtimeId: input.runtimeId,
          previewKind: agentFilePreviewKindFor(mimeType, originalFilename),
          ...(shouldNormalizeDocx
            ? {
                wordCompatibility: "LIBREOFFICE_REBUILT",
                agentFileSourceSha256: sourceSha256,
                agentFileSourceByteSize: input.buffer.byteLength
              }
            : {}),
          ...(input.backfillProvenance
            ? {
                backfillSourceStorageUri: input.backfillProvenance.sourceStorageUri,
                backfillSourceArtifactId: input.backfillProvenance.sourceArtifactId
              }
            : {})
        }
      },
      input.traceId
    );
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

export interface BackfillAgentFileInput {
  store: SpaceStore;
  artifactRoot: string;
  sourcePath: string;
  roomId: string;
  paneId: string;
  cliSessionId: string;
  traceId: string;
  docxNormalizer?: AgentFileDocxNormalizer;
}

export interface BackfillAgentFileResult {
  artifact: Artifact;
  alreadyImported: boolean;
  sourceStorageUri: string;
  sourceArtifactId: string | null;
  sourceSha256: string;
  byteSize: number;
}

async function listAllRoomArtifacts(store: SpaceStore, roomId: string): Promise<Artifact[]> {
  const artifacts = await store.listArtifacts({ roomId, page: 1, pageSize: 100, sortOrder: "desc" });
  if (artifacts.length > 10_000) {
    throw new Error("Agent File backfill refused to scan more than 10,000 room artifacts.");
  }
  return artifacts;
}

function sourceStorageUriFromRelativePath(
  relativePath: string,
  provenance: { roomId: string; paneId: string; cliSessionId: string }
): string {
  const segments = relativePath.split(sep);
  if (segments.length !== 6 || segments[0] !== "cli-uploads") {
    throw new Error("Agent File backfill source must use the canonical cli-uploads room/pane/session/day/file layout.");
  }
  return (
    `space-artifact://cli-uploads/${encodeURIComponent(provenance.roomId)}/${encodeURIComponent(provenance.paneId)}/` +
    `${encodeURIComponent(provenance.cliSessionId)}/${encodeURIComponent(segments[4]!)}/${encodeURIComponent(segments[5]!)}`
  );
}

function localAgentFilePath(artifactRoot: string, artifact: Artifact): string {
  const parsed = new URL(artifact.storageUri);
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parsed.protocol !== "space-artifact:" || parsed.hostname !== "agent-files" || segments.length !== 5) {
    throw new Error(`Artifact ${artifact.id} does not use the Agent Files storage namespace.`);
  }
  const [roomId, paneId, cliSessionId, day, storedFilename] = segments as [string, string, string, string, string];
  return agentFileStoragePath({ artifactRoot, roomId, paneId, cliSessionId, day, storedFilename });
}

async function verifyFileHash(filePath: string, expectedSha256: string, expectedByteSize: number): Promise<void> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size !== expectedByteSize) {
    throw new Error("Agent File integrity verification failed: stored file size does not match.");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error("Agent File integrity verification failed: stored file hash does not match.");
  }
}

export async function backfillAgentFile(input: BackfillAgentFileInput): Promise<BackfillAgentFileResult> {
  if (!isAbsolute(input.sourcePath)) {
    throw new Error("Agent File backfill requires an absolute source path.");
  }
  const sourceStat = await lstat(input.sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error("Agent File backfill source must be a regular, non-symlink file.");
  }
  if (sourceStat.size <= 0 || sourceStat.size > agentFileMaxBytes) {
    throw new Error("Agent File backfill source must be between 1 byte and 100 MiB.");
  }

  const resolvedArtifactRoot = await realpath(input.artifactRoot);
  const resolvedSourcePath = await realpath(input.sourcePath);
  const relativeSourcePath = relative(resolvedArtifactRoot, resolvedSourcePath);
  if (!relativeSourcePath || relativeSourcePath.startsWith(`..${sep}`) || isAbsolute(relativeSourcePath)) {
    throw new Error("Agent File backfill source must stay inside the configured artifact root.");
  }
  const sourceSegments = relativeSourcePath.split(sep);
  const expectedSegments = [
    "cli-uploads",
    safeStorageSegment(input.roomId),
    safeStorageSegment(input.paneId),
    safeStorageSegment(input.cliSessionId)
  ];
  if (!expectedSegments.every((segment, index) => sourceSegments[index] === segment)) {
    throw new Error("Agent File backfill source provenance does not match the requested room, pane, and CLI session.");
  }

  await input.store.getRoom(input.roomId);
  const pane = await input.store.getPane(input.paneId);
  if (pane.roomId !== input.roomId) {
    throw new Error("Agent File backfill pane does not belong to the requested room.");
  }
  const cliSession = await input.store.getPaneCliSession(input.cliSessionId);
  if (!cliSession || cliSession.roomId !== input.roomId || cliSession.paneId !== input.paneId) {
    throw new Error("Agent File backfill CLI session provenance was not found.");
  }
  if (cliSession.purpose !== "NORMAL") {
    throw new Error("Agent File backfill does not accept CLI login sessions.");
  }

  const buffer = await readFile(resolvedSourcePath);
  const sourceSha256 = createHash("sha256").update(buffer).digest("hex");
  const sourceStorageUri = sourceStorageUriFromRelativePath(relativeSourcePath, input);
  const roomArtifacts = await listAllRoomArtifacts(input.store, input.roomId);
  const sourceArtifact = roomArtifacts.find((artifact) => artifact.storageUri === sourceStorageUri) ?? null;
  const existing = roomArtifacts.find(
    (artifact) =>
      isAgentFileArtifact(artifact) &&
      artifact.deletedAt === null &&
      artifact.paneId === input.paneId &&
      (
        (
          artifact.metadata.agentFileSourceSha256 === sourceSha256 &&
          artifact.metadata.agentFileSourceByteSize === buffer.byteLength
        ) ||
        (
          artifact.sha256 === sourceSha256 &&
          artifact.byteSize === buffer.byteLength
        )
      ) &&
      artifact.metadata.source === "AGENT_OUTPUT_BACKFILL" &&
      artifact.metadata.cliSessionId === input.cliSessionId &&
      artifact.metadata.originalFilename === basename(resolvedSourcePath)
  );
  if (existing) {
    const existingPath = localAgentFilePath(resolvedArtifactRoot, existing);
    await chmod(existingPath, agentFileStorageMode);
    await verifyFileHash(existingPath, existing.sha256, existing.byteSize);
    await verifyFileHash(resolvedSourcePath, sourceSha256, buffer.byteLength);
    return {
      artifact: existing,
      alreadyImported: true,
      sourceStorageUri,
      sourceArtifactId: typeof existing.metadata.backfillSourceArtifactId === "string"
        ? existing.metadata.backfillSourceArtifactId
        : sourceArtifact?.id ?? null,
      sourceSha256,
      byteSize: buffer.byteLength
    };
  }

  const record = await persistAgentFile({
    store: input.store,
    artifactRoot: resolvedArtifactRoot,
    roomId: input.roomId,
    paneId: input.paneId,
    cliSessionId: input.cliSessionId,
    runtimeId: cliSession.runtimeId,
    originalFilename: basename(resolvedSourcePath),
    declaredMimeType: "application/octet-stream",
    buffer,
    traceId: input.traceId,
    docxNormalizer: input.docxNormalizer,
    source: "AGENT_OUTPUT_BACKFILL",
    backfillProvenance: {
      sourceStorageUri,
      sourceArtifactId: sourceArtifact?.id ?? null
    }
  });
  try {
    await verifyFileHash(
      localAgentFilePath(resolvedArtifactRoot, record.artifact),
      record.artifact.sha256,
      record.artifact.byteSize
    );
    await verifyFileHash(resolvedSourcePath, sourceSha256, buffer.byteLength);
  } catch (error) {
    await unlink(localAgentFilePath(resolvedArtifactRoot, record.artifact)).catch(() => undefined);
    await Promise.resolve(input.store.deleteArtifact(record.artifact.id)).catch(() => undefined);
    throw error;
  }
  await input.store.recordAuditEvent({
    actorUserId: null,
    traceId: input.traceId,
    action: "agent_file.backfill",
    targetType: "artifact",
    targetId: record.artifact.id,
    metadata: {
      roomId: input.roomId,
      paneId: input.paneId,
      cliSessionId: input.cliSessionId,
      runtimeId: cliSession.runtimeId,
      sourceStorageUri,
      sourceArtifactId: sourceArtifact?.id ?? null,
      sourceSha256,
      byteSize: buffer.byteLength
    }
  });
  return {
    artifact: record.artifact,
    alreadyImported: false,
    sourceStorageUri,
    sourceArtifactId: sourceArtifact?.id ?? null,
    sourceSha256,
    byteSize: buffer.byteLength
  };
}

export async function readAgentFileTextPreview(filePath: string): Promise<{ content: string; truncated: boolean }> {
  const fileStat = await stat(filePath);
  const byteCount = Math.min(fileStat.size, agentFileTextPreviewMaxBytes);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteCount);
    const result = await handle.read(buffer, 0, byteCount, 0);
    return {
      content: buffer.subarray(0, result.bytesRead).toString("utf8"),
      truncated: fileStat.size > result.bytesRead
    };
  } finally {
    await handle.close();
  }
}

export function sanitizeAgentFileDocxHtml(unsafeHtml: string): string {
  const sanitized = sanitizeHtml(unsafeHtml, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "s",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "pre",
      "code",
      "img"
    ],
    allowedAttributes: {
      img: ["src", "alt"]
    },
    allowedSchemes: ["data"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard"
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:28px;background:#fff;color:#171717;font:15px/1.55 system-ui,sans-serif}
img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #bbb;padding:6px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
</head>
<body>${sanitized}</body>
</html>`;
}

export async function renderAgentFileDocxPreview(
  filePath: string,
  options: { workerPath?: string; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size > agentFileDocxPreviewMaxBytes) {
    throw new Error("DOCX preview is limited to 20 MiB.");
  }
  const workerPath = options.workerPath ?? fileURLToPath(new URL("./agent-file-preview-worker.js", import.meta.url));
  const result = await execFileAsync(
    process.execPath,
    ["--max-old-space-size=128", workerPath, filePath],
    {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: options.maxOutputBytes ?? 2 * 1024 * 1024
    }
  );
  return sanitizeAgentFileDocxHtml(result.stdout);
}
