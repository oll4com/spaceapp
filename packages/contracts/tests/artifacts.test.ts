import { describe, expect, it } from "vitest";
import {
  deleteRoomAgentFilesResponseSchema,
  deleteRoomMediaResponseSchema,
  isAgentFileArtifact,
  isRoomMediaArtifact,
  type Artifact
} from "../src/index.js";

function artifact(input: Pick<Artifact, "kind" | "storageUri">): Artifact {
  return {
    id: "artifact:test",
    roomId: "room:test",
    paneId: null,
    turnId: null,
    workflowId: null,
    kind: input.kind,
    mimeType: "application/octet-stream",
    storageUri: input.storageUri,
    sha256: "a".repeat(64),
    byteSize: 1,
    metadata: {},
    expiresAt: null,
    pinnedAt: null,
    deletedAt: null,
    createdAt: "2026-07-17T00:00:00.000Z"
  };
}

describe("room media artifacts", () => {
  it("includes room and CLI uploads plus visual browser evidence", () => {
    expect(isRoomMediaArtifact(artifact({ kind: "IMAGE", storageUri: "space-artifact://user-uploads/room/2026-07-17/image.png" }))).toBe(true);
    expect(isRoomMediaArtifact(artifact({ kind: "EXPORT", storageUri: "space-artifact://cli-uploads/room/pane/session/2026-07-17/file.txt" }))).toBe(true);
    expect(isRoomMediaArtifact(artifact({ kind: "SCREENSHOT", storageUri: "space-artifact://browser-evidence/capture/screenshot.png" }))).toBe(true);
    expect(isRoomMediaArtifact(artifact({ kind: "VIDEO", storageUri: "space-artifact://browser-evidence/capture/video.mp4" }))).toBe(true);
  });

  it("excludes non-visual browser evidence and unrelated artifact storage", () => {
    expect(isRoomMediaArtifact(artifact({ kind: "DOM_SNAPSHOT", storageUri: "space-artifact://browser-evidence/capture/dom.json" }))).toBe(false);
    expect(isRoomMediaArtifact(artifact({ kind: "SCREENSHOT", storageUri: "cas://sha256/test" }))).toBe(false);
  });

  it("keeps Agent Files out of the Media Dock collection", () => {
    const agentFile = artifact({
      kind: "IMAGE",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/final.png"
    });
    expect(isAgentFileArtifact(agentFile)).toBe(true);
    expect(isRoomMediaArtifact(agentFile)).toBe(false);
    expect(isAgentFileArtifact(artifact({
      kind: "EXPORT",
      storageUri: "space-artifact://cli-uploads/room/pane/session/2026-07-29/input.docx"
    }))).toBe(false);
  });
});

describe("deleteRoomAgentFilesResponseSchema", () => {
  it("accepts consistent clear results and rejects mismatched failures", () => {
    expect(deleteRoomAgentFilesResponseSchema.parse({
      ok: true,
      roomId: "room:test",
      matchedCount: 1,
      deletedCount: 1,
      failedCount: 0,
      failedArtifactIds: []
    })).toMatchObject({ ok: true, deletedCount: 1 });

    expect(() => deleteRoomAgentFilesResponseSchema.parse({
      ok: true,
      roomId: "room:test",
      matchedCount: 1,
      deletedCount: 0,
      failedCount: 1,
      failedArtifactIds: ["artifact:failed"]
    })).toThrow();
  });
});

describe("deleteRoomMediaResponseSchema", () => {
  it("accepts a complete success result", () => {
    expect(deleteRoomMediaResponseSchema.parse({
      ok: true,
      roomId: "room:test",
      matchedCount: 3,
      deletedCount: 3,
      failedCount: 0,
      failedArtifactIds: []
    })).toMatchObject({ ok: true, deletedCount: 3 });
  });

  it("rejects inconsistent counts and success flags", () => {
    expect(() => deleteRoomMediaResponseSchema.parse({
      ok: true,
      roomId: "room:test",
      matchedCount: 3,
      deletedCount: 2,
      failedCount: 1,
      failedArtifactIds: ["artifact:failed"]
    })).toThrow();
  });
});
