import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { verifySession } from "../src/auth.js";
import { createControlScreenshotCapture } from "../src/space-control-capture.js";
import { createSpaceControl } from "../src/space-control.js";

const secret = "media-studio-test-secret-0123456789";
const user = { id: "user:operator", email: "space@space.local", role: "ADMIN" as const };
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function adapter(answer: (request: Record<string, unknown>) => unknown) {
  const artifactRoot = await mkdtemp(join(tmpdir(), "space-control-capture-"));
  dirs.push(artifactRoot);
  const requests: Array<Record<string, unknown>> = [];
  const createArtifact = vi.fn(async () => ({ artifact: { id: "artifact:shot-1" } }));
  const capture = createControlScreenshotCapture({
    instance: "dev", cookieName: "space_session_dev", sessionSecret: secret, artifactRoot,
    resolveUser: async (id) => ({ ...user, id }), createArtifact,
    run: async (request) => { const parsed = JSON.parse(request); requests.push(parsed); return JSON.stringify(await answer(parsed)); }
  });
  return { capture, requests, createArtifact, artifactRoot };
}

const shotOf = (room: unknown, viewport = "desktop") => ({ room, blockedWrites: 3, version: "abc1234",
  shots: [{ viewport, format: "png", width: 2880, height: 1800, base64: png.toString("base64") }] });

describe("Space Control screenshot capture", () => {
  it("captures the room read-only as the actor and stores a room SCREENSHOT artifact", async () => {
    const { capture, requests, createArtifact, artifactRoot } = await adapter((request) => shotOf(request.room));
    const evidence = await capture({ id: "user:operator" }, "room:studio001", { format: "png", viewport: "mobile" });

    const [request] = requests;
    expect(request).toMatchObject({ instance: "dev", cookieName: "space_session_dev", room: "room:studio001", viewport: "mobile", format: "png" });
    // The engine gets a short READ_ONLY session of the actor's own account: terminals attach as observers.
    expect(verifySession(String(request!.cookieValue), secret)).toMatchObject({ id: "user:operator", role: "ADMIN", proofScope: "READ_ONLY" });

    const input = createArtifact.mock.calls[0]![0] as { storageUri: string; sha256: string; byteSize: number; kind: string; roomId: string };
    expect(input).toMatchObject({ roomId: "room:studio001", kind: "SCREENSHOT", mimeType: "image/png", byteSize: png.length });
    const relative = decodeURIComponent(input.storageUri.replace("space-artifact://", ""));
    expect(await readFile(join(artifactRoot, relative))).toEqual(png);
    expect(evidence).toMatchObject({ roomId: "room:studio001", authenticated: true, captureSource: "AUTHENTICATED_APP", artifactId: "artifact:shot-1",
      width: 2880, height: 1800, blockedWrites: 3 });
    expect(JSON.stringify(evidence)).not.toContain(String(request!.cookieValue));
  });

  it("rejects an image of another room and runs one capture at a time", async () => {
    const other = await adapter(() => shotOf("room:another1"));
    await expect(other.capture({ id: "user:operator" }, "room:studio001")).rejects.toThrow(/no image of this room/);
    expect(other.createArtifact).not.toHaveBeenCalled();

    let release!: () => void;
    const slow = await adapter((request) => new Promise((resolve) => { release = () => resolve(shotOf(request.room)); }));
    const first = slow.capture({ id: "user:operator" }, "room:studio001");
    await vi.waitFor(() => expect(slow.requests).toHaveLength(1));
    await expect(slow.capture({ id: "user:operator" }, "room:studio001")).rejects.toThrow(/Another Space screenshot/);
    release();
    await expect(first).resolves.toMatchObject({ artifactId: "artifact:shot-1" });
  });

  it("is what space_screenshot uses, with its viewport", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Media Studio", initialPaneCount: 0, kind: "AGENT_PROOF" });
    const { capture, requests } = await adapter((request) => shotOf(request.room, String(request.viewport)));
    const service = createSpaceControl({ store, repository: new InMemoryControlRepository(), controller: {} as never, send: vi.fn(async () => ({ submitted: true })),
      publish: vi.fn(async () => {}), captureScreenshot: capture } as never);
    const result = await service.screenshot({ id: "user:operator", role: "ADMIN" }, room.id, { format: "png", viewport: "tablet" });
    expect(result).toMatchObject({ status: "COMPLETED", evidence: { captureSource: "AUTHENTICATED_APP", viewport: "tablet" } });
    expect(requests[0]).toMatchObject({ room: room.id, viewport: "tablet" });
  });
});
