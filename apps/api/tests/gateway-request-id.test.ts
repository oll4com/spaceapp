import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayRequestIdHeader } from "../src/gateway-request-id.js";
import { pngOf } from "./fixtures/design-png.js";

// OBS-006: Space's own callers of Space Gateway send a Space id as x-request-id, which the gateway keeps as its request
// log id when it fits (1-120 visible ASCII characters).
describe("Space Gateway request id from Space callers", () => {
  const originalKeyFile = process.env.SPACE_GATEWAY_KEY_FILE;
  let dir: string | null = null;
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (originalKeyFile === undefined) delete process.env.SPACE_GATEWAY_KEY_FILE; else process.env.SPACE_GATEWAY_KEY_FILE = originalKeyFile;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("sends only an id the gateway can keep", () => {
    expect(gatewayRequestIdHeader("council_run:0123456789abcdef01234567")).toEqual({ "x-request-id": "council_run:0123456789abcdef01234567" });
    expect(gatewayRequestIdHeader("req:abc")).toEqual({ "x-request-id": "req:abc" });
    for (const value of ["", "has space", "x".repeat(121), "naïve", null, undefined]) expect(gatewayRequestIdHeader(value)).toEqual({});
  });

  it("names the Council run on a gateway model call and on its web search, and the game on a Codex chess move", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gw-request-id-"));
    process.env.SPACE_GATEWAY_KEY_FILE = path.join(dir, "key");
    await writeFile(process.env.SPACE_GATEWAY_KEY_FILE, "sk-sgw-test\n");
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string> });
      if (url.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { content: "ok" } }] });
      const done = { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "{\"findings\":[]}" }] }] } };
      return new Response(`data: ${JSON.stringify(done)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const { requestModelText } = await import("../src/asteroids-arena/providers.js");
    const { searchWebThroughGateway } = await import("../src/council/web-search.js");
    const runId = "council_run:0123456789abcdef01234567";
    const signal = new AbortController().signal;
    expect((await requestModelText({ modelId: "codex/gpt-5.5", system: "s", user: "u", signal, traceId: runId })).text).toBe("ok");
    await requestModelText({ modelId: "codex/gpt-5.5", system: "s", user: "u", signal });
    await searchWebThroughGateway("query", "question", signal, runId);
    expect(sent.map((call) => [call.url.split("/").slice(-2).join("/"), call.headers["x-request-id"]])).toEqual([
      ["chat/completions", runId], ["chat/completions", undefined], ["v1/responses", runId], ["v1/responses", runId]]);
    expect(sent.every((call) => call.headers.Authorization === "Bearer sk-sgw-test")).toBe(true);

    sent.length = 0;
    const { createChessMoveRequester } = await import("../src/chess/chess-players.js");
    const contestant = { id: "codex/gpt-5.5", providerId: "codex", modelId: "codex/gpt-5.5", reasoningEffort: "default" } as never;
    await createChessMoveRequester()({ contestant, system: "s", prompt: "p", signal, traceId: "chess_tournament:t1:game:3" });
    expect(sent.map((call) => call.headers["x-request-id"])).toEqual(["chess_tournament:t1:game:3"]);
  });

  it("names the request on a YouTube summary and a Design image (EXT-G-5)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gw-request-id-"));
    const keyFile = path.join(dir, "key");
    await writeFile(keyFile, "sk-sgw-test\n");
    const sent: Array<string | undefined> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)["x-request-id"]);
      return Response.json(url.endsWith("/gemini/v1/generate") ? { text: "Words." }
        : { images: [{ mimeType: "image/png", base64: pngOf(1024, 1024).toString("base64") }], model: "gemini-3.1-flash-image" });
    }) as unknown as typeof fetch;
    const { youtubeVideoText } = await import("../src/youtube-summary.js");
    const { createGatewayImageGenerator } = await import("../src/design/images.js");
    await youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile, videoId: "jNQXAC9IVRw", kind: "summary", fetchImpl, traceId: "req:abc123def456" });
    await youtubeVideoText({ gatewayUrl: "http://gw.test", keyFile, videoId: "jNQXAC9IVRw", kind: "summary", fetchImpl });
    const generate = createGatewayImageGenerator({ gatewayUrl: "http://gw.test", keyFile, fetchImpl });
    await generate({ engine: "NANO_BANANA", prompt: "p", width: 1024, height: 1024, references: [], traceId: "req:abc123def456" });
    await generate({ engine: "NANO_BANANA", prompt: "p", width: 1024, height: 1024, references: [] });
    expect(sent).toEqual(["req:abc123def456", undefined, "req:abc123def456", undefined]);
  });
});
