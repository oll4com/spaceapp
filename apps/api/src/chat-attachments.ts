import { turnArtifactMaxCount, type Artifact, type AgentRunExecutionContext, type Pane } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";

// Resolve the exact submitted IDs, never a room listing or a partial best effort.
export async function resolveChatAttachments(
  store: Pick<SpaceStore, "getArtifact">,
  pane: Pick<Pane, "id" | "roomId">,
  artifactIds: string[] = []
): Promise<Artifact[]> {
  if (artifactIds.length > turnArtifactMaxCount) {
    throw new SpaceConflictError(`A message can include up to ${turnArtifactMaxCount} attachments. Remove extra files and try again.`);
  }
  const unavailable = () => new SpaceConflictError("One or more attachments are unavailable for this Chat. Remove or upload them again before sending.");
  const checkedAt = Date.now();
  return Promise.all([...new Set(artifactIds)].map(async id => {
    let artifact: Artifact;
    try {
      artifact = await store.getArtifact(id);
    } catch (error) {
      if (error instanceof SpaceNotFoundError) throw unavailable();
      throw error;
    }
    if (artifact.roomId !== pane.roomId || (artifact.paneId !== null && artifact.paneId !== pane.id) ||
        artifact.deletedAt !== null ||
        (artifact.pinnedAt === null && artifact.expiresAt !== null && Date.parse(artifact.expiresAt) <= checkedAt)) {
      throw unavailable();
    }
    return artifact;
  }));
}

export function chatAttachmentReceipts(artifacts: Artifact[]): NonNullable<AgentRunExecutionContext["attachments"]> {
  return artifacts.map(artifact => ({
    artifactId: artifact.id,
    name: (typeof artifact.metadata.originalFilename === "string"
      ? artifact.metadata.originalFilename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 512) : "") || "Attached file",
    mimeType: artifact.mimeType,
    byteSize: artifact.byteSize,
    sha256: artifact.sha256
  }));
}
