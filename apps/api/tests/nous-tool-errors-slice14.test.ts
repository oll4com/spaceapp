import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CliUpdateAllResult, Pane, Room } from "@space/contracts";
import { createNousCliUpdate } from "../src/nous/cli-update.js";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { createNousWeb } from "../src/nous/web.js";

/** Daily Nous errors 14/11 slice 14 (plan 1NF6u6gcCwtj step 4): gates and timeouts answer as refusals or findings, not failures. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t14", callId: "toolu_14", traceId: "trace:14" };
const room = (id: string, name: string): Room => ({ id, name, kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room);
const pane = (id: string, paneName: string, roomId: string, isClosed = false): Pane =>
  ({ id, roomId, paneName, title: paneName, mode: "BROWSER", terminalRuntimeId: null, isClosed } as unknown as Pane);

function tools(overrides: Partial<NousToolDeps> = {}) {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const deps = {
    world: async () => "world",
    rooms: async () => [room("room:felix001", "Felix")],
    listPanes: async (roomId: string) => roomId === "room:felix001" ? [pane("pane:andy0001", "Andy", roomId), pane("pane:2f6a5unH-TBn", "Iris", roomId, true)] : [],
    roomTool,
    inspectPane: async () => ({ text: "", state: "UNKNOWN", sessionId: "session:1", tasks: [] }),
    allowances: async () => ({ promote: false, warm: false }),
    notifications: { list: async () => [], resolve: async () => true },
    paneNotices: {},
    ...overrides
  } as unknown as NousToolDeps;
  return { tools: createNousTools(deps), roomTool };
}

describe("Daily Nous errors 14/11 slice 14", () => {
  it("answers the Vault fence on browser.content as a refusal that says when to read again", async () => {
    const f = tools();
    f.roomTool.mockResolvedValueOnce({ ok: false, display: "Used Space Control (space_execute): FAILED", result: JSON.stringify({ id: "a".repeat(64), status: "FAILED",
      results: [{ index: 0, status: "FAILED", paneId: "pane:andy0001", error: "This browser holds a Vault fill: its page is not read until it shows the next page." }] }) });
    const outcome = await f.tools.execute("space_execute", { room: "Felix", actions: [{ kind: "resource", operation: "browser.content", id: "pane:andy0001" }] }, ctx);
    expect(outcome).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Read it again once the page has moved on") });
  });

  it("holds space_inspect of a pane id that is not open in the room, naming it, and inspects nothing", async () => {
    const f = tools();
    const outcome = await f.tools.execute("space_inspect", { room: "Felix", arguments: { paneId: "pane:2f6a5unH-TBn" } } as never, ctx);
    expect(outcome).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Nothing inspected.") });
    expect(f.roomTool).not.toHaveBeenCalled();
  });

  it("reads the stored 7-day samples of these gates as refusals", () => {
    expect(historicalToolHold("space_execute", "FAILED browser.content pane:andy0001: This browser holds a Vault fill: its page is not read until it shows the next page.\n{")).toBe(true);
    expect(historicalToolHold("space_net_check", "The operation was aborted")).toBe(true);
    expect(historicalToolHold("space_net_check", "Port 3306 is not checked; ports: 80, 443.")).toBe(false);
    expect(historicalToolHold("space_inspect", "A selected pane is not in this room.")).toBe(true);
    expect(historicalToolHold("space_clipboard_note", "A new note needs its text.")).toBe(true);
    expect(historicalToolHold("space_clipboard_note", "No clipboard record clipboard:x.")).toBe(false);
    // A stale resident Browser Host waits for the operator's guarded restart: a real failure, still charged.
    expect(historicalToolHold("space_look", "The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR).")).toBe(false);
  });

  it("names the failed runtime and its cause on the update's first line", async () => {
    const result: CliUpdateAllResult = { mode: "UPDATE_ALL", overallStatus: "FAIL", scope: ["gemini"], reinstall: false, startedAt: null, finishedAt: new Date().toISOString(),
      runtimes: [{ runtimeId: "cli:gemini", displayName: "Gemini CLI", installedVersion: "1.0.0", availableVersion: "1.0.1", status: "FAIL", code: "SMOKE_FAILED",
        summary: "gemini --version exited 1.", checks: [], customPreserved: false }] };
    const cliUpdate = createNousCliUpdate({ runner: { detect: async () => ({ schemaVersion: "space.cli-update-all.detection.v1", detectedAt: "", cliTypes: [] }), updateAll: async () => result },
      runtimeSettings: async () => [], notice: () => {}, audit: async () => {}, waitMs: 1_000 } as never);
    const outcome = await createNousTools({ cliUpdate } as never).execute("space_cli_update", { runtimeId: "gemini" }, ctx);
    expect(outcome.result.split("\n")[0]).toBe("CLI update of cli:gemini: FAIL (1 checked): Gemini CLI SMOKE_FAILED: gemini --version exited 1..");
  });

  describe("space_net_check", () => {
    let server: Server;
    let port = 0;
    const sockets: Socket[] = [];
    beforeAll(async () => {
      server = createServer((socket) => { sockets.push(socket); }); // accepts and never answers: no TLS handshake
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      port = (server.address() as { port: number }).port;
    });
    afterAll(() => new Promise<void>((done) => { sockets.forEach((socket) => socket.destroy()); server.close(() => done()); }));

    it("answers a host that does not answer in time as the check's finding", async () => {
      const web = createNousWeb({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: () => true, ports: [port], checkTimeoutMs: 200 });
      expect(await web.check({ check: "tls", host: "site.example", port })).toMatch(/^tls site\.example → no answer within 0\.2 s from public-host \(No TLS handshake/);
    });
  });
});
