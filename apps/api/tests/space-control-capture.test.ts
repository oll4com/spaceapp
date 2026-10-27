import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { verifySession } from "../src/auth.js";
import { createCaptureTerminalFit, createControlScreenshotCapture } from "../src/space-control-capture.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";
import { createSpaceControl } from "../src/space-control.js";

const secret = "media-studio-test-secret-0123456789";
const user = { id: "user:operator", email: "space@space.local", role: "ADMIN" as const };
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function adapter(answer: (request: Record<string, unknown>) => unknown | Promise<unknown>) {
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

  it("records a video into the artifact directory it made and stores a room VIDEO artifact", async () => {
    const mp4 = Buffer.from("000000186674797069736f6d", "hex");
    const video = { steps: [{ dock: "tasks", dwellMs: 2000 }, { dwellMs: 3000 }] };
    const { capture, requests, createArtifact, artifactRoot } = await adapter(async (request) => {
      const file = join(String(request.outDir), "video-story.mp4");
      await writeFile(file, mp4);
      return { room: request.room, blockedWrites: 1, version: "abc1234", skipped: ["settings:appearance"],
        files: [{ file, viewport: "story", bytes: mp4.length, sha256: "f".repeat(64), durationMs: 9400 }] };
    });
    const evidence = await capture({ id: "user:operator" }, "room:studio001", { viewport: "story", paneId: "pane:one", dock: "media", video });

    const [request] = requests;
    expect(request).toMatchObject({ room: "room:studio001", viewport: "story", pane: "pane:one", dock: "media", video });
    expect(String(request!.outDir)).toMatch(new RegExp(`^${artifactRoot}/browser-evidence/space-control-[0-9a-f-]{36}$`));
    // The session outlives the recording and its encoding.
    expect(verifySession(String(request!.cookieValue), secret)).toMatchObject({ proofScope: "READ_ONLY" });
    const input = createArtifact.mock.calls[0]![0] as { storageUri: string; metadata: Record<string, unknown> };
    expect(input).toMatchObject({ roomId: "room:studio001", kind: "VIDEO", mimeType: "video/mp4", byteSize: mp4.length, sha256: "f".repeat(64),
      metadata: { source: "SPACE_CONTROL_RECORDING", viewport: "story", durationMs: 9400 } });
    expect(await readFile(join(artifactRoot, decodeURIComponent(input.storageUri.replace("space-artifact://", ""))))).toEqual(mp4);
    expect(evidence).toMatchObject({ roomId: "room:studio001", authenticated: true, captureSource: "AUTHENTICATED_APP", artifactId: "artifact:shot-1",
      kind: "VIDEO", format: "mp4", durationMs: 9400, skipped: ["settings:appearance"] });
  });

  it("removes a failed recording's directory", async () => {
    const { capture, createArtifact, artifactRoot } = await adapter(async (request) => {
      await writeFile(join(String(request.outDir), "partial.jpg"), "x");
      throw new Error("ffmpeg failed");
    });
    await expect(capture({ id: "user:operator" }, "room:studio001", { video: { steps: [{ dwellMs: 1000 }] } })).rejects.toThrow(/ffmpeg failed/);
    expect(createArtifact).not.toHaveBeenCalled();
    expect(await readdir(join(artifactRoot, "browser-evidence"))).toEqual([]);
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

  it("maps a social aspect, skips the room lock, answers a video with a RUNNING operation and refuses Dots a video", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Media Studio", initialPaneCount: 0, kind: "AGENT_PROOF" });
    const repository = new InMemoryControlRepository();
    // A capture is read-only: it never holds the room lock (a video runs for minutes).
    repository.withLock = async () => { throw new Error("room lock taken"); };
    let release!: () => void;
    const { capture, requests } = await adapter((request) => request.video
      ? new Promise((resolve) => { release = () => resolve({ room: request.room, files: [{ file: join(String(request.outDir), "video-story.mp4"), viewport: "story", bytes: 4, sha256: "a".repeat(64) }] }); })
      : shotOf(request.room, String(request.viewport)));
    const service = createSpaceControl({ store, repository, controller: {} as never, send: vi.fn(async () => ({ submitted: true })),
      publish: vi.fn(async () => {}), captureScreenshot: capture } as never);
    const actor = { id: "user:operator", role: "ADMIN" as const };

    await expect(service.screenshot(actor, room.id, { format: "png", aspect: "4:5", dock: "media" } as never)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(requests[0]).toMatchObject({ viewport: "portrait", dock: "media" });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const started = service.screenshot(actor, room.id, { aspect: "9:16", video: { steps: [{ dwellMs: 1000 }] } } as never);
      await vi.advanceTimersByTimeAsync(6000);
      const running = await started as { status: string; operationId: string };
      expect(running).toMatchObject({ status: "RUNNING", operationId: expect.any(String) });
      expect(requests[1]).toMatchObject({ viewport: "story" });
      release();
      await vi.waitFor(async () => expect(await service.operations(actor, room.id, running.operationId)).toMatchObject({ status: "COMPLETED" }));
      const done = await service.operations(actor, room.id, running.operationId) as { results: Array<{ evidence: { result: Record<string, unknown> } }> };
      expect(done.results[0]!.evidence.result).toMatchObject({ kind: "VIDEO", artifactId: "artifact:shot-1" });
    } finally {
      vi.useRealTimers();
    }

    await expect(service.screenshot({ ...actor, dotId: `dot:${"a".repeat(32)}` }, room.id, { video: { steps: [{ dwellMs: 1000 }] } } as never)).rejects.toThrow(/Dots capture stills only/);
  });
});

describe("a pinned capture (2026-10-23 Demo API take)", () => {
  it("stores nothing when the engine fails closed because the page left the requested room", async () => {
    const left = "The Space screenshot failed: The capture page left room:studio001 for another room (the account switched rooms); nothing was recorded.";
    const { capture, createArtifact, artifactRoot } = await adapter(() => { throw new Error(left); });
    await expect(capture({ id: "user:operator" }, "room:studio001", { viewport: "desktop-4k" })).rejects.toThrow(/left room:studio001 for another room/);
    await expect(capture({ id: "user:operator" }, "room:studio001", { video: { steps: [{ dwellMs: 1000 }] } })).rejects.toThrow(/nothing was recorded/);
    expect(createArtifact).not.toHaveBeenCalled();
    expect(await readdir(join(artifactRoot, "browser-evidence")).catch(() => [])).toEqual([]);
  });
});

describe("space_screenshot fitTerminals (Nous Warm approval 2026-10-23)", () => {
  it("resizes a pane's active CLI PTY once through a temporary host attachment and records the new geometry", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Fact-check", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Alex", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "host-1", cols: 95, rows: 30 });
    const host = { attach: vi.fn(async () => ({ attachmentId: "fit", session: { generationId: "host-1", nextOutputSequence: 9 }, replay: [] })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(async () => undefined), terminate: vi.fn() };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never, discoverRuntimes: vi.fn() });

    await expect(manager.fitPaneTerminal(pane.id, 62, 40)).resolves.toEqual({ sessionId: session.sessionId, before: "95x30", after: "62x40" });
    expect(host.resize).toHaveBeenCalledTimes(1);
    expect(host.resize).toHaveBeenCalledWith(expect.objectContaining({ cliSessionId: session.sessionId }), "fit", 62, 40);
    expect(host.detach).toHaveBeenCalledWith(expect.anything(), "fit");
    expect(store.getPaneCliSession(session.sessionId)?.terminalGeometry).toEqual({ generationId: "host-1", cols: 62, rows: 40 });
    expect(host.input).not.toHaveBeenCalled();
    const idle = store.createPane({ roomId: room.id, title: "No CLI", mode: "TERMINAL", terminalRuntimeId: "cli:claude" });
    await expect(manager.fitPaneTerminal(idle.id, 62, 40)).resolves.toBeNull();
  });

  it("fits only the owner's own CLI panes of the captured room, clamps the grid, audits each fit and never runs for a Dot", async () => {
    const panes: Record<string, { id: string; roomId: string; mode: string; ownerUserId?: string | null }> = {
      "pane:a": { id: "pane:a", roomId: "room:r", mode: "TERMINAL" },
      "pane:b": { id: "pane:b", roomId: "room:r", mode: "TERMINAL" },
      "pane:other": { id: "pane:other", roomId: "room:x", mode: "TERMINAL" },
      "pane:chat": { id: "pane:chat", roomId: "room:r", mode: "CHAT" },
      "pane:shared": { id: "pane:shared", roomId: "room:r", mode: "TERMINAL", ownerUserId: "user:guest" }
    };
    const fitPaneTerminal = vi.fn(async (paneId: string, cols: number, rows: number) => ({ sessionId: `s:${paneId}`, before: "95x30", after: `${cols}x${rows}` }));
    const recordAuditEvent = vi.fn(async () => undefined);
    const fit = createCaptureTerminalFit({ getRoom: async () => ({ ownerUserId: "user:operator" }),
      getPane: async (id) => { if (!panes[id]) throw new Error("not found"); return panes[id]!; }, fitPaneTerminal, recordAuditEvent });

    await expect(fit({ id: "user:operator" }, "room:r", [{ paneId: "pane:a", cols: 62, rows: 40 }, { paneId: "pane:b", cols: 999, rows: 1 },
      { paneId: "pane:other", cols: 62, rows: 40 }, { paneId: "pane:chat", cols: 62, rows: 40 }, { paneId: "pane:shared", cols: 62, rows: 40 },
      { paneId: "pane:gone", cols: 62, rows: 40 }])).resolves.toEqual([{ paneId: "pane:a", before: "95x30", after: "62x40" },
      { paneId: "pane:b", before: "95x30", after: "400x5" }]);
    expect(fitPaneTerminal.mock.calls).toEqual([["pane:a", 62, 40], ["pane:b", 400, 5]]);
    expect(recordAuditEvent).toHaveBeenCalledTimes(2);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "user:operator", action: "space_control.capture.fit_terminal",
      targetId: "pane:a", metadata: { roomId: "room:r", sessionId: "s:pane:a", before: "95x30", after: "62x40" } }));
    await expect(fit({ id: "user:operator", dotId: "dot:1" }, "room:r", [])).rejects.toThrow(/Dots never/);
    await expect(fit({ id: "user:guest" }, "room:r", [])).rejects.toThrow(/owner/);
    expect(fitPaneTerminal).toHaveBeenCalledTimes(2);
  });

  it("asks the engine to fit, answers its SPACE_FIT through the owner's fit, and records terminalsFitted", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-control-capture-"));
    dirs.push(artifactRoot);
    const fitTerminals = vi.fn(async () => [{ paneId: "pane:a", before: "95x30", after: "62x40" }]);
    const createArtifact = vi.fn(async () => ({ artifact: { id: "artifact:shot-1" } }));
    const requests: Array<Record<string, unknown>> = [];
    const capture = createControlScreenshotCapture({ instance: "dev", cookieName: "space_session_dev", sessionSecret: secret, artifactRoot,
      resolveUser: async (id) => ({ ...user, id }), createArtifact, fitTerminals,
      run: async (request, _timeout, onFit) => {
        requests.push(JSON.parse(request));
        const fitted = onFit ? await onFit([{ paneId: "pane:a", cols: 62, rows: 40 }]) : undefined;
        return JSON.stringify({ ...shotOf("room:r", "desktop-4k"), ...(fitted === undefined ? {} : { terminalsFitted: fitted }) });
      } });
    await expect(capture({ id: "user:operator" }, "room:r", { viewport: "desktop-4k", fitTerminals: true })).resolves.toMatchObject({ terminalsFitted: 1,
      terminalFits: [{ paneId: "pane:a", before: "95x30", after: "62x40" }] });
    expect(requests[0]).toMatchObject({ fitTerminals: true, viewport: "desktop-4k" });
    expect(fitTerminals).toHaveBeenCalledWith({ id: "user:operator" }, "room:r", [{ paneId: "pane:a", cols: 62, rows: 40 }]);
    expect((createArtifact.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata).toMatchObject({ terminalsFitted: 1 });
    // Without the option nothing is fitted and nothing is recorded about it.
    await expect(capture({ id: "user:operator" }, "room:r", { viewport: "desktop-4k" })).resolves.not.toHaveProperty("terminalsFitted");
    expect(requests[1]).not.toHaveProperty("fitTerminals");
    await expect(capture({ id: "user:operator", dotId: "dot:1" }, "room:r", { fitTerminals: true })).rejects.toThrow(/Dots never/);
    expect(fitTerminals).toHaveBeenCalledTimes(1);
  });
});
