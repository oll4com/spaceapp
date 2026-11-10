import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createBrowserSessionManager, traceBrowserHostCalls, type BrowserSessionManager } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";

const traceId = "trace:0123456789abcdef01234567";
const pane = { id: "pane:browser01", roomId: "room:alex0001" };
const lines = (calls: unknown[][]) => calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>).filter((line) => line.event === "browser_host_request");

afterEach(() => vi.restoreAllMocks());

describe("OBS-001: the Browser Host writes one browser_host_request line, ids only, per call the API traced", () => {
  it("logs traced calls with status, code and duration; never a URL, an untraced call, a keystroke or a heartbeat", async () => {
    const write = vi.fn<(line: string) => void>();
    const failure = Object.assign(new Error("Pane https://bank.example/secret is gone."), { code: "BROWSER_SESSION_NOT_FOUND" });
    const navigate = vi.fn(async (): Promise<unknown> => ({ ok: true }));
    const manager = traceBrowserHostCalls({
      navigate,
      action: vi.fn(async () => { throw failure; }),
      stopRoom: vi.fn(async () => undefined),
      input: vi.fn(async () => ({})),
      heartbeatControl: vi.fn(async () => ({}))
    } as unknown as BrowserSessionManager, write);
    await expect(manager.navigate(pane as never, "https://bank.example/secret?token=1", traceId)).resolves.toEqual({ ok: true });
    await expect(manager.action(pane as never, {} as never, traceId)).rejects.toBe(failure);
    await manager.stopRoom("room:alex0001", traceId);
    const gone = Object.assign(new Error("Pane was not found."), { name: "SpaceNotFoundError" });
    navigate.mockRejectedValueOnce(gone);
    await expect(manager.navigate(pane as never, "https://bank.example/", traceId)).rejects.toBe(gone);
    await manager.navigate(pane as never, "https://bank.example/", "not a trace id");
    await manager.input!(pane as never, {} as never, traceId);
    await manager.heartbeatControl!(pane as never, {} as never, traceId);
    expect(lines(write.mock.calls)).toEqual([
      { event: "browser_host_request", method: "navigate", traceId, paneId: pane.id, status: "OK", durationMs: expect.any(Number) },
      { event: "browser_host_request", method: "action", traceId, paneId: pane.id, status: "FAILED", code: "BROWSER_SESSION_NOT_FOUND", durationMs: expect.any(Number) },
      { event: "browser_host_request", method: "stopRoom", traceId, roomId: "room:alex0001", status: "OK", durationMs: expect.any(Number) },
      { event: "browser_host_request", method: "navigate", traceId, paneId: pane.id, status: "FAILED", code: "BROWSER_HOST_NOT_FOUND", durationMs: expect.any(Number) }
    ]);
    expect(JSON.stringify(write.mock.calls)).not.toContain("bank.example");
  });

  // OBS-006: a browser start and a capture carry the request's id in their input, not as an argument, and wrote no line.
  it("logs a start and a capture by the request id inside their input", async () => {
    const write = vi.fn<(line: string) => void>();
    const manager = traceBrowserHostCalls({
      startOrRestore: vi.fn(async () => ({})),
      createCapture: vi.fn(async () => ({}))
    } as unknown as BrowserSessionManager, write);
    const requestId = "req-1a2b3c";
    await manager.startOrRestore({ pane: pane as never, targetUrl: "https://bank.example/?token=1", traceId: requestId });
    await manager.createCapture!(pane as never, {} as never, { requestedByType: "OPERATOR", requestedById: "user:operator", traceId: requestId });
    expect(lines(write.mock.calls)).toEqual([
      { event: "browser_host_request", method: "startOrRestore", traceId: requestId, paneId: pane.id, status: "OK", durationMs: expect.any(Number) },
      { event: "browser_host_request", method: "createCapture", traceId: requestId, paneId: pane.id, status: "OK", durationMs: expect.any(Number) }
    ]);
    expect(JSON.stringify(write.mock.calls)).not.toContain("bank.example");
  });

  it("wraps the manager the Browser Host process builds", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const manager = createBrowserSessionManager({ store: new InMemorySpaceStore(), config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "false" }) });
    await manager.stopRoom("room:alex0001", traceId);
    expect(lines(stderr.mock.calls)).toEqual([
      { event: "browser_host_request", method: "stopRoom", traceId, roomId: "room:alex0001", status: "OK", durationMs: expect.any(Number) }
    ]);
  });
});
