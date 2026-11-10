import { api, SpaceApiError } from "../../api.js";

export interface TerminalUploadPreview {
  id: string;
  name: string;
  path: string;
  objectUrl: string;
}

// Artifact IDs and authenticated URLs survive browser reloads and API restarts.
// Read every page: the thumbnail setting limits rendering, never retention.
export async function loadCliPhotoHistory(
  roomId: string,
  paneId: string,
  isCurrent: () => boolean
): Promise<TerminalUploadPreview[]> {
  const photos = new Map<string, TerminalUploadPreview>();
  for (let page = 1; isCurrent(); page += 1) {
    const read = () => api.artifacts({ roomId, paneId, kind: "IMAGE", page, pageSize: 100, sortOrder: "asc" });
    // One retry: a request in flight when nginx rolls the HTTP/2 connection over fails before any response (UPSTREAM_UNAVAILABLE).
    const response = await read().catch((error: unknown) => {
      if (!(error instanceof SpaceApiError && error.code === "UPSTREAM_UNAVAILABLE") || !isCurrent()) throw error;
      return read();
    });
    if (!isCurrent()) return [];
    for (const artifact of response.data) {
      if (artifact.roomId !== roomId || artifact.paneId !== paneId || artifact.kind !== "IMAGE" ||
          artifact.deletedAt || !artifact.storageUri.startsWith("space-artifact://cli-uploads/") ||
          !artifact.mimeType.startsWith("image/")) continue;
      photos.set(artifact.id, {
        id: artifact.id,
        name: typeof artifact.metadata.originalFilename === "string" ? artifact.metadata.originalFilename : "Image",
        path: artifact.storageUri,
        objectUrl: api.artifactFileUrl(artifact.id)
      });
    }
    if (page >= response.pagination.totalPages) break;
  }
  return [...photos.values()];
}
