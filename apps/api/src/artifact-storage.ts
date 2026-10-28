import { join, resolve, sep } from "node:path";
import type { Artifact } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { agentFileReadPath } from "./cli-agent-files.js";
import { FilesystemError } from "./filesystem-error.js";
import { unlinkWorkspaceFile } from "./workspace-filesystem.js";

export function safeStorageSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140) || "item";
}

export function safeOriginalFilename(value: string): string {
  return value.replace(/[^\w .@-]/g, "_").slice(0, 180) || "image";
}

export function safeCliFilename(value: string): string {
  return value
    .replace(/[^\w .@-]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 160) || "upload";
}

export function safeBrowserEvidenceSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 140) || "item";
}

function decodeStorageSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function artifactFilename(artifact: Artifact): string {
  const metadataName = artifact.metadata.originalFilename ?? artifact.metadata.storedFilename ?? artifact.metadata.artifactFile;
  if (typeof metadataName === "string" && metadataName.trim()) {
    return safeOriginalFilename(metadataName);
  }
  const extension = artifact.mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "bin";
  return `${safeStorageSegment(artifact.id)}.${extension}`;
}

export function localArtifactFilePath(input: { artifactRoot: string; artifact: Artifact }): string {
  let parsed: URL;
  try {
    parsed = new URL(input.artifact.storageUri);
  } catch {
    throw new SpaceConflictError(`Artifact ${input.artifact.id} does not have a local file-backed storage URI.`);
  }
  if (parsed.protocol !== "space-artifact:") {
    throw new SpaceConflictError(`Artifact ${input.artifact.id} does not have a local file-backed storage URI.`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeStorageSegment);
  let candidate: string | null = null;
  if (parsed.hostname === "user-uploads" && segments.length === 3) {
    const [roomId, day, filename] = segments as [string, string, string];
    candidate = join(input.artifactRoot, "user-uploads", safeStorageSegment(roomId), safeStorageSegment(day), safeCliFilename(filename));
  }
  if (parsed.hostname === "cli-uploads" && segments.length === 5) {
    const [roomId, paneId, sessionId, day, filename] = segments as [string, string, string, string, string];
    candidate = join(
      input.artifactRoot,
      "cli-uploads",
      safeStorageSegment(roomId),
      safeStorageSegment(paneId),
      safeStorageSegment(sessionId),
      safeStorageSegment(day),
      safeCliFilename(filename)
    );
  }
  if (parsed.hostname === "agent-files" && segments.length === 5) {
    const [roomId, paneId, sessionId, day, filename] = segments as [string, string, string, string, string];
    candidate = agentFileReadPath({
      artifactRoot: input.artifactRoot,
      roomId,
      paneId,
      cliSessionId: sessionId,
      day,
      storedFilename: filename
    });
  }
  if (parsed.hostname === "browser-evidence" && segments.length === 2) {
    const [captureId, filename] = segments as [string, string];
    candidate = join(input.artifactRoot, "browser-evidence", safeBrowserEvidenceSegment(captureId), safeCliFilename(filename));
  }

  if (!candidate || !pathInside(input.artifactRoot, candidate)) {
    throw new SpaceConflictError(`Artifact ${input.artifact.id} does not have a supported local file-backed storage URI.`);
  }
  return candidate;
}

export async function permanentlyDeleteLocalArtifact(input: {
  store: Pick<SpaceStore, "deleteArtifact">;
  artifactRoot: string;
  artifact: Artifact;
}): Promise<Artifact> {
  const filePath = localArtifactFilePath({ artifactRoot: input.artifactRoot, artifact: input.artifact });
  try {
    await unlinkWorkspaceFile(input.artifactRoot, filePath);
  } catch (error) {
    if (!(error instanceof FilesystemError && error.code === "NOT_FOUND")) {
      throw error;
    }
  }
  return input.store.deleteArtifact(input.artifact.id);
}

export interface BrowserArtifactRetentionSweepResult {
  softDeleted: number;
  filesRemoved: number;
  fileErrors: Array<{ artifactId: string; message: string }>;
}

export async function sweepExpiredBrowserArtifacts(input: {
  store: Pick<SpaceStore, "deleteExpiredBrowserArtifacts">;
  artifactRoot: string;
  at?: string;
  removeFile?: (path: string) => Promise<void>;
}): Promise<BrowserArtifactRetentionSweepResult> {
  const expired = await input.store.deleteExpiredBrowserArtifacts(input.at);
  const removeFile = input.removeFile ?? ((filePath: string) => unlinkWorkspaceFile(input.artifactRoot, filePath));
  let filesRemoved = 0;
  const fileErrors: Array<{ artifactId: string; message: string }> = [];
  for (const artifact of expired) {
    try {
      await removeFile(localArtifactFilePath({ artifactRoot: input.artifactRoot, artifact }));
      filesRemoved += 1;
    } catch (error) {
      if (error instanceof FilesystemError && error.code === "NOT_FOUND") continue;
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      fileErrors.push({
        artifactId: artifact.id,
        message: error instanceof Error ? error.message.slice(0, 500) : "Artifact file cleanup failed."
      });
    }
  }
  return { softDeleted: expired.length, filesRemoved, fileErrors };
}

export function pathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}
