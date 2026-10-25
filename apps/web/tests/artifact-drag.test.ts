import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@space/contracts";
import {
  SPACE_ARTIFACT_MIME,
  artifactDisplayName,
  artifactDragPayload,
  readArtifactDragPayload,
  resolveArtifactDragFile
} from "../src/features/artifacts/artifact-drag.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

function artifact(input: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact:test",
    roomId: "room:test",
    paneId: null,
    turnId: null,
    workflowId: null,
    kind: "EXPORT",
    mimeType: "text/plain",
    storageUri: "space-artifact://agent-files/room/pane/session/2026-08-04/test.txt",
    sha256: "a".repeat(64),
    byteSize: 3,
    metadata: {},
    expiresAt: null,
    pinnedAt: null,
    deletedAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    ...input
  };
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("artifact drag payload", () => {
  it("prefers the original filename for the drop name", () => {
    const entry = artifact({ metadata: { originalFilename: "report.pdf" } });
    expect(artifactDisplayName(entry)).toBe("report.pdf");
    expect(artifactDragPayload(entry)).toEqual({ id: "artifact:test", name: "report.pdf", mimeType: "text/plain" });
  });

  it("falls back to the stored filename or a derived id name for media without filenames", () => {
    expect(artifactDisplayName(artifact({ metadata: { storedFilename: "kept.png" } }))).toBe("kept.png");
    expect(artifactDisplayName(artifact({ metadata: { artifactFile: "shot.bin" } }))).toBe("shot.bin");
    expect(artifactDisplayName(artifact({ mimeType: "image/png" }))).toBe("space-artifact-artifact:test.png");
  });
});

describe("readArtifactDragPayload", () => {
  const payload = { id: "artifact:x", name: "x.png", mimeType: "image/png" };

  it("parses the artifact MIME payload", () => {
    expect(readArtifactDragPayload({ getData: (type: string) => (type === SPACE_ARTIFACT_MIME ? JSON.stringify(payload) : "") } as unknown as DataTransfer)).toEqual(payload);
  });

  it("returns null when the artifact MIME is absent or dataTransfer is missing", () => {
    expect(readArtifactDragPayload(null)).toBeNull();
    expect(readArtifactDragPayload({ getData: () => "" } as unknown as DataTransfer)).toBeNull();
  });

  it("returns null for malformed payloads", () => {
    const dataTransfer = (raw: string) =>
      ({ getData: (type: string) => (type === SPACE_ARTIFACT_MIME ? raw : "") }) as unknown as DataTransfer;
    expect(readArtifactDragPayload(dataTransfer("{not json"))).toBeNull();
    expect(readArtifactDragPayload(dataTransfer(JSON.stringify({ id: "" })))).toBeNull();
    expect(readArtifactDragPayload(dataTransfer(JSON.stringify({ mimeType: "text/plain" })))).toBeNull();
  });

  it("fills a missing name from the id and mime type", () => {
    const result = readArtifactDragPayload({
      getData: (type: string) => (type === SPACE_ARTIFACT_MIME ? JSON.stringify({ id: "artifact:x", name: "", mimeType: "video/mp4" }) : "")
    } as unknown as DataTransfer);
    expect(result).toEqual({ id: "artifact:x", name: "space-artifact-artifact:x.mp4", mimeType: "video/mp4" });
  });
});

describe("resolveArtifactDragFile", () => {
  function readFileText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
      reader.addEventListener("error", () => reject(reader.error ?? new Error("FileReader failed")));
      reader.readAsText(file, "UTF-8");
    });
  }

  it("fetches the artifact file and returns a File with the drop name and type", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({ ok: true, status: 200, blob: async () => new Blob(["hello"], { type: "text/plain" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const file = await resolveArtifactDragFile({ id: "artifact:test", name: "note.txt", mimeType: "text/plain" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/artifacts/artifact%3Atest/file");
    expect(file.name).toBe("note.txt");
    expect(file.type).toBe("text/plain");
    expect(await readFileText(file)).toBe("hello");
  });

  it("throws when the artifact file fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(resolveArtifactDragFile({ id: "artifact:test", name: "note.txt", mimeType: "text/plain" })).rejects.toThrow(/could not be read/);
  });
});
