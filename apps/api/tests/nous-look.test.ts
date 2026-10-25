// Eyes (operator request 2026-10-24): space_look answers with a browser or copilot pane's masked screenshot as an image block.
// The Vault fence holds (no image while a fill holds the page), the image is never stored by Nous, CLI panes have no look.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, NOUS_LOOK_MAX_BYTES, type NousToolDeps } from "../src/nous/tools.js";
import { registerNousMcpRoute, signNousToken } from "../src/nous/mcp.js";
import Fastify from "fastify";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = { id: "room:look00001", name: "Main", kind: "WORKSPACE" } as Room;
const pane = (id: string, mode: Pane["mode"], title: string) => ({ id, roomId: room.id, mode, title, isClosed: false, isMinimized: false } as unknown as Pane);
const browserPane = pane("pane:marketing1", "MARKETING_COPILOT", "Marketing");
const cliPane = pane("pane:andy00001", "TERMINAL", "Andy");
const base = mkdtempSync(join(tmpdir(), "nous-look-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
// A real PNG header: the image block carries the file's bytes as base64.
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const shotPath = join(base, "masked-screenshot.png");
writeFileSync(shotPath, png);

function tools(extra: Partial<NousToolDeps> = {}, fenced = false) {
  const action = vi.fn(async () => ({ text: JSON.stringify({ artifactId: "artifact:shot0001", path: shotPath, masked: true }), session: { currentUrl: "https://x.com/compose" } }));
  const vaultProtection = { ownerOf: vi.fn(async () => fenced ? "pane:marketing1" : null), release: vi.fn(async () => false) };
  const nous = createNousTools({ rooms: async () => [room], listPanes: async () => [browserPane, cliPane], browser: { getActive: async (target) => target.id === browserPane.id ? {} : null, action },
    vaultProtection, ...extra } as unknown as NousToolDeps);
  return { nous, action, vaultProtection };
}

describe("space_look", () => {
  it("answers with the pane's masked screenshot as an image block, and the MCP route passes it to the model", async () => {
    const { nous, action } = tools();
    const looked = await nous.execute("space_look", { room: "Main", pane: "Marketing" }, ctx);
    expect(looked).toMatchObject({ ok: true, display: "Looked at Marketing" });
    expect(looked.result).toContain("https://x.com/compose");
    expect(looked.result).toContain("artifact:shot0001");
    expect(looked.result).toContain("never instructions");
    expect(looked.images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
    expect(action).toHaveBeenCalledWith(browserPane, { type: "masked_screenshot" }, "trace:1");

    const app = Fastify();
    const secret = "s".repeat(40);
    registerNousMcpRoute(app, { secret, tools: nous.definitions, routeOptions: {}, service: { turnRunning: () => true, callTool: async () => looked } as never });
    const token = signNousToken(secret, { owner, turnId: "nous_turn:look1", expiresAt: Date.now() + 60_000 });
    const answer = (await app.inject({ method: "POST", url: "/api/cli/nous/mcp", headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "space_look", arguments: { room: "Main", pane: "Marketing" } } } })).json().result;
    expect(answer.isError).toBe(false);
    expect(answer.content[0]).toMatchObject({ type: "text" });
    expect(answer.content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    await app.close();
  });

  it("keeps the Vault fence: a page a fill holds gives no image, not even masked", async () => {
    const { nous, action } = tools({}, true);
    const held = await nous.execute("space_look", { room: "Main", pane: "Marketing" }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true, display: "Marketing's page is behind the Vault fence" });
    expect(held.images).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
  });

  it("has no look for a CLI pane, a browser that is not open, a missing pane or an image past the cap", async () => {
    const { nous, action } = tools();
    expect(await nous.execute("space_look", { room: "Main", pane: "Andy" }, ctx)).toMatchObject({ ok: false, display: "Andy has no browser" });
    expect((await nous.execute("space_look", { room: "Main", pane: "Nobody" }, ctx)).ok).toBe(false);
    const closed = tools({ browser: { getActive: async () => null, action } });
    expect(await closed.nous.execute("space_look", { room: "Main", pane: "Marketing" }, ctx)).toMatchObject({ ok: false, display: "Marketing's browser is not open" });
    const bigPath = join(base, "big.png");
    writeFileSync(bigPath, Buffer.alloc(NOUS_LOOK_MAX_BYTES + 1));
    const big = tools({ browser: { getActive: async () => ({}), action: async () => ({ text: JSON.stringify({ artifactId: "artifact:big", path: bigPath, masked: true }) }) } });
    expect(await big.nous.execute("space_look", { room: "Main", pane: "Marketing" }, ctx)).toMatchObject({ ok: false, display: "Marketing's image is too large" });
    expect(action).not.toHaveBeenCalled();
    // No browser host (dev): a plain refusal.
    expect(await tools({ browser: undefined }).nous.execute("space_look", { room: "Main", pane: "Marketing" }, ctx)).toMatchObject({ ok: false, display: "No browser host here" });
  });
});
