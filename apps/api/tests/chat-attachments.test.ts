import { describe, expect, it, vi } from "vitest";
import { type Artifact } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { chatAttachmentReceipts, resolveChatAttachments } from "../src/chat-attachments.js";

const pane = { id: "pane:owner", roomId: "room:owner" };
const file: Artifact = {
  id: "artifact:owned", roomId: pane.roomId, paneId: pane.id, turnId: null, workflowId: null,
  kind: "IMAGE", mimeType: "image/png", storageUri: "space-artifact://user-uploads/owned.png",
  sha256: "a".repeat(64), byteSize: 1200, metadata: { originalFilename: "Δοκιμή.png" },
  createdAt: "2020-01-01T00:00:00Z", deletedAt: null, expiresAt: null, pinnedAt: null
};

describe("Chat attachment resolution", () => {
  it.each([
    { roomId: "room:foreign" }, { roomId: null }, { paneId: "pane:foreign" },
    { deletedAt: "2020-01-01T00:00:00Z" }, { expiresAt: "2020-01-01T00:00:00Z" }
  ])("rejects the entire set when one attachment is unavailable (%j)", async fields => {
    const getArtifact = vi.fn(async (id: string) => id === file.id ? file : { ...file, id, ...fields });
    await expect(resolveChatAttachments({ getArtifact }, pane, [file.id, "artifact:unavailable"]))
      .rejects.toThrow("One or more attachments are unavailable for this Chat.");
  });

  it("does not leak missing IDs or hide infrastructure failures", async () => {
    await expect(resolveChatAttachments({ getArtifact: () => { throw new SpaceNotFoundError("private record"); } }, pane, ["artifact:missing"]))
      .rejects.toThrow(SpaceConflictError);
    const infrastructure = new Error("database unavailable");
    await expect(resolveChatAttachments({ getArtifact: () => { throw infrastructure; } }, pane, [file.id])).rejects.toBe(infrastructure);
  });

  it("accepts room-level files and respects the existing pinned retention exception", async () => {
    const retained = { ...file, paneId: null, expiresAt: "2020-01-01T00:00:00Z", pinnedAt: "2020-01-01T00:00:00Z" };
    await expect(resolveChatAttachments({ getArtifact: () => retained }, pane, [file.id])).resolves.toEqual([retained]);
  });

  it("keeps selection order with concurrent reads and removes duplicate IDs", async () => {
    let release!: (value: Artifact) => void;
    const slow = new Promise<Artifact>(resolve => { release = resolve; });
    const second = { ...file, id: "artifact:second" };
    const getArtifact = vi.fn((id: string) => id === file.id ? slow : Promise.resolve(second));
    const result = resolveChatAttachments({ getArtifact }, pane, [file.id, second.id, file.id]);
    release(file);
    await expect(result).resolves.toEqual([file, second]);
    expect(getArtifact).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized submissions before looking up any file", async () => {
    const getArtifact = vi.fn(() => file);
    await expect(resolveChatAttachments({ getArtifact }, pane, Array.from({ length: 9 }, (_, i) => `artifact:${i}`))).rejects.toThrow("up to 8");
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it("creates an independent bounded receipt without internal storage paths", () => {
    const input = { ...file, metadata: { originalFilename: "\n" + "x".repeat(600) } };
    const [receipt] = chatAttachmentReceipts([input]);
    input.metadata.originalFilename = "changed";
    expect(receipt?.name).toHaveLength(512);
    expect(receipt?.name).not.toContain("\n");
    expect(receipt).toMatchObject({ artifactId: file.id, sha256: file.sha256, byteSize: 1200 });
    expect(receipt).not.toHaveProperty("storageUri");
    expect(chatAttachmentReceipts([{ ...file, metadata: {} }])[0]?.name).toBe("Attached file");
  });
});
