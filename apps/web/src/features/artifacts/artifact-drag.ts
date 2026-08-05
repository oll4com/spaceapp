import type { Artifact } from "@space/contracts";
import { api } from "../../api.js";

export const SPACE_ARTIFACT_MIME = "application/x-space-artifact";

export interface ArtifactDragPayload {
  id: string;
  name: string;
  mimeType: string;
}

function artifactMimeExtension(mimeType: string): string {
  const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") ?? "";
  return extension || "bin";
}

export function artifactDisplayName(artifact: Artifact): string {
  const metadataName = artifact.metadata.originalFilename ?? artifact.metadata.storedFilename ?? artifact.metadata.artifactFile;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  return `space-artifact-${artifact.id}.${artifactMimeExtension(artifact.mimeType)}`;
}

export function artifactDragPayload(artifact: Artifact): ArtifactDragPayload {
  return { id: artifact.id, name: artifactDisplayName(artifact), mimeType: artifact.mimeType };
}

export function readArtifactDragPayload(dataTransfer: DataTransfer | null | undefined): ArtifactDragPayload | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(SPACE_ARTIFACT_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ArtifactDragPayload>;
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.mimeType !== "string" || !parsed.mimeType) return null;
    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : `space-artifact-${parsed.id}.${artifactMimeExtension(parsed.mimeType)}`;
    return { id: parsed.id, name, mimeType: parsed.mimeType };
  } catch {
    return null;
  }
}

export function setArtifactDragData(event: { dataTransfer: DataTransfer | null }, artifact: Artifact): void {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;
  const payload = artifactDragPayload(artifact);
  const fileUrl = api.artifactFileUrl(artifact.id);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(SPACE_ARTIFACT_MIME, JSON.stringify(payload));
  dataTransfer.setData("text/uri-list", fileUrl);
  dataTransfer.setData("text/plain", fileUrl);
}

export async function resolveArtifactDragFile(payload: ArtifactDragPayload): Promise<File> {
  const response = await fetch(api.artifactFileUrl(payload.id));
  if (!response.ok) {
    throw new Error(`Artifact file "${payload.name || payload.id}" could not be read for drop.`);
  }
  const blob = await response.blob();
  return new File([blob], payload.name, { type: payload.mimeType || blob.type });
}
