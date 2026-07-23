import type { Artifact } from "@space/contracts";

export const ARTIFACTS_UPDATED_EVENT = "space:artifacts-updated";

export interface ArtifactsUpdatedDetail {
  roomId: string;
  artifacts: Artifact[];
}

export function dispatchArtifactsUpdated(roomId: string, artifacts: Artifact[]) {
  if (typeof window === "undefined" || artifacts.length === 0) return;
  window.dispatchEvent(new CustomEvent<ArtifactsUpdatedDetail>(ARTIFACTS_UPDATED_EVENT, { detail: { roomId, artifacts } }));
}

export function isArtifactsUpdatedDetail(detail: unknown): detail is ArtifactsUpdatedDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const maybeDetail = detail as { roomId?: unknown; artifacts?: unknown };
  return typeof maybeDetail.roomId === "string" && Array.isArray(maybeDetail.artifacts);
}
