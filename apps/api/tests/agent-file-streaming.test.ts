import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { localArtifactFilePath, permanentlyDeleteLocalArtifact } from "../src/artifact-storage.js";
import { persistAgentFile } from "../src/cli-agent-files.js";
import { createNousFiles } from "../src/nous/files.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "space-agent-stream-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("persists staged bytes with their hash without requiring a whole-file buffer", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Streaming fixture", initialPaneCount: 0 });
  const sourcePath = path.join(root, "staged.txt");
  await writeFile(sourcePath, "streamed bytes");
  const result = await persistAgentFile({ store, artifactRoot: root, roomId: room.id, paneId: null, cliSessionId: null,
    runtimeId: "user", originalFilename: "notes.txt", declaredMimeType: "text/plain", sourcePath,
    traceId: "trace:stream-test", source: "USER_UPLOAD" });
  expect(result.artifact.byteSize).toBe(14);
  expect(result.artifact.sha256).toBe(createHash("sha256").update("streamed bytes").digest("hex"));
  expect(result.artifact.mimeType).toBe("text/plain");
  // Resolve through the URI path contract instead of guessing storage segments.
  const { agentFileStoragePath } = await import("../src/cli-agent-files.js");
  const destination = agentFileStoragePath({ artifactRoot: root, roomId: room.id, paneId: null, cliSessionId: null,
    day: new Date().toISOString().slice(0, 10), storedFilename: String(result.artifact.metadata.storedFilename) });
  expect(await readFile(destination, "utf8")).toBe("streamed bytes");
});

it("retains DOCX normalization when input was staged on disk", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "DOCX fixture", initialPaneCount: 0 });
  const sourcePath = path.join(root, "source.docx");
  await writeFile(sourcePath, Buffer.from("PK-original"));
  const result = await persistAgentFile({ store, artifactRoot: root, roomId: room.id, paneId: null, cliSessionId: null,
    runtimeId: "user", originalFilename: "document.docx", declaredMimeType: "application/octet-stream", sourcePath,
    traceId: "trace:docx-stream", docxNormalizer: async ({ buffer }) => {
      expect(buffer.toString()).toBe("PK-original");
      return Buffer.from("PK-rebuilt");
    } });
  expect(result.artifact.metadata.wordCompatibility).toBe("LIBREOFFICE_REBUILT");
  expect(result.artifact.byteSize).toBe(10);
});

it("does not persist through a symlink in artifact storage ancestors", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "space-agent-outside-"));
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Containment", initialPaneCount: 0 });
  try {
    await symlink(outside, path.join(root, "agent-files"));
    await expect(persistAgentFile({ store, artifactRoot: root, roomId: room.id, paneId: null, cliSessionId: null,
      runtimeId: "user", originalFilename: "notes.txt", declaredMimeType: "text/plain", buffer: Buffer.from("safe"),
      traceId: "trace:unsafe-storage" })).rejects.toMatchObject({ statusCode: 403 });
    expect(await readdir(outside)).toEqual([]);
  } finally { await rm(outside, { recursive: true, force: true }); }
});

it("reads an Agent File with a Greek name back, and one the old write path stored under its raw name (2026-10-25)", async () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Greek names", initialPaneCount: 0 });
  const result = await persistAgentFile({ store, artifactRoot: root, roomId: room.id, paneId: null, cliSessionId: null,
    runtimeId: "user", originalFilename: "1 - Κιτ (a@b.gr).md", declaredMimeType: "text/markdown",
    buffer: Buffer.from("# Κιτ"), traceId: "trace:greek-name", source: "USER_UPLOAD" });
  expect(result.artifact.metadata.originalFilename).toBe("1 - Κιτ (a@b.gr).md");
  const filePath = localArtifactFilePath({ artifactRoot: root, artifact: result.artifact });
  expect(path.basename(filePath)).toBe(String(result.artifact.metadata.storedFilename).replace(/[^A-Za-z0-9._-]/g, "_"));
  expect(await readFile(filePath, "utf8")).toBe("# Κιτ");
  const files = createNousFiles({ root, artifactRoot: root, rooms: async () => [room], listArtifacts: async () => [], getArtifact: async (id) => store.getArtifact(id) });
  expect(await files.decisionFiles("user:operator", [result.artifact.id])).toEqual([{ ref: result.artifact.id, text: "# Κιτ", total: 5, truncated: false }]);

  // 2026-10-03 to 2026-10-25 the write path kept the raw name: such a file opens as it lies on disk, and deletes.
  const raw = "agent_file_rawname01-2 - Πώληση (x@y.gr).md";
  await writeFile(path.join(path.dirname(filePath), raw), "old");
  const old = { ...result.artifact, id: "artifact:rawname01", storageUri: result.artifact.storageUri.replace(/[^/]+$/, encodeURIComponent(raw)) };
  expect(await readFile(localArtifactFilePath({ artifactRoot: root, artifact: old }), "utf8")).toBe("old");
  await permanentlyDeleteLocalArtifact({ store: { deleteArtifact: async () => old }, artifactRoot: root, artifact: old });
  expect(await readdir(path.dirname(filePath))).toEqual([path.basename(filePath)]);
});
