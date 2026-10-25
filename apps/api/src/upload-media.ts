/**
 * Upload media type detection and user upload storage layout shared by the upload routes (moved verbatim from the
 * composition root).
 */
import { join } from "node:path";
import { imageArtifactMimeTypeSchema } from "@space/contracts";
import { makeSpaceId } from "@space/runtime";
import { safeCliFilename, safeStorageSegment } from "./artifact-storage.js";

export const paneArtifactUploadMaxBytes = 100 * 1024 * 1024;

const imageExtensionByMime = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
} as const;

const inferredUploadMimeTypeByExtension = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm"
} as const;

export type ImageArtifactMimeType = keyof typeof imageExtensionByMime;

export function isAllowedImageMime(mimeType: string): mimeType is ImageArtifactMimeType {
  return imageArtifactMimeTypeSchema.safeParse(mimeType).success;
}

export function sniffImageMime(buffer: Buffer): ImageArtifactMimeType | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function buildUserUploadStorage(input: {
  artifactRoot: string;
  roomId: string;
  mimeType: ImageArtifactMimeType;
}): { filePath: string; storageUri: string } {
  const day = new Date().toISOString().slice(0, 10);
  const uploadId = makeSpaceId("upload");
  const extension = imageExtensionByMime[input.mimeType];
  const roomSegment = safeStorageSegment(input.roomId);
  const fileName = `${safeStorageSegment(uploadId)}.${extension}`;
  return {
    filePath: join(input.artifactRoot, "user-uploads", roomSegment, day, fileName),
    storageUri: `space-artifact://user-uploads/${encodeURIComponent(input.roomId)}/${day}/${fileName}`
  };
}

export function buildGenericUserUploadStorage(input: {
  artifactRoot: string;
  roomId: string;
  originalFilename: string;
}): { filePath: string; storageUri: string; storedFilename: string } {
  const day = new Date().toISOString().slice(0, 10);
  const uploadId = makeSpaceId("upload");
  const roomSegment = safeStorageSegment(input.roomId);
  const storedFilename = `${safeStorageSegment(uploadId)}-${safeCliFilename(input.originalFilename)}`;
  return {
    filePath: join(input.artifactRoot, "user-uploads", roomSegment, day, storedFilename),
    storageUri: `space-artifact://user-uploads/${encodeURIComponent(input.roomId)}/${day}/${encodeURIComponent(storedFilename)}`,
    storedFilename
  };
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

export function inferUploadMimeType(filename: string, declaredMimeType: string): string {
  const normalizedDeclared = declaredMimeType.trim().toLowerCase();
  if (normalizedDeclared && normalizedDeclared !== "application/octet-stream") {
    return normalizedDeclared;
  }
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  const inferred = inferredUploadMimeTypeByExtension[extension as keyof typeof inferredUploadMimeTypeByExtension];
  return inferred || normalizedDeclared || "application/octet-stream";
}
