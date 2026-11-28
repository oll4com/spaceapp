import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createUrlLook, lookAtUrl, startFenceProxy } from "../src/nous/url-look.js";
import { uiProofMissing, UI_PROOF_HINT } from "../src/nous/request-done.js";

const viaProxy = (port: number, options: { method?: string; path: string }) => new Promise<number>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path });
  req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
  req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on("error", reject);
  req.end();
});

describe("space_look {url} (Response time 28/11: a UI Done refused 11 times for want of a page screenshot)", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of closers.splice(0)) await close(); });

  it("fences the page's every request to public hosts on web ports, loopback included", async () => {
    const secret: Server = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((done) => secret.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => secret.close(() => done())));
    const proxy = await startFenceProxy(async () => [{ address: "127.0.0.1", family: 4 }]);
    closers.push(proxy.close);
    const local = (secret.address() as AddressInfo).port;
    expect(await viaProxy(proxy.port, { path: `http://127.0.0.1:${local}/` })).toBe(403);
    expect(await viaProxy(proxy.port, { path: "http://localhost/" })).toBe(403);
    // A public name that resolves to this server (DNS rebinding) is refused on its address.
    expect(await viaProxy(proxy.port, { path: "http://rebind.example/" })).toBe(403);
    expect(await viaProxy(proxy.port, { method: "CONNECT", path: "169.254.169.254:443" })).toBe(403);
    expect(proxy.refused).toHaveLength(4);
    // Even an allowed address is reached only on 80/443.
    const open = await startFenceProxy(async () => [{ address: "127.0.0.1", family: 4 }], () => true);
    closers.push(open.close);
    expect(await viaProxy(open.port, { path: `http://127.0.0.1:${local}/` })).toBe(403);
  });

  it("refuses a private URL before any Chrome starts", async () => {
    const look = createUrlLook({ chromePath: "/nonexistent/chrome" });
    await expect(look("http://127.0.0.1:4911/")).rejects.toThrow(/Private and local addresses/);
    const answer = await lookAtUrl(look, "http://10.0.0.1/", 1_000_000);
    expect(answer).toMatchObject({ ok: false, refused: true });
  });

  it("answers with the image and a citation that meets the Done screenshot check", async () => {
    const answer = await lookAtUrl(async () => ({ png: Buffer.from("png"), url: "https://oll4.com/c/5TFZkUtN?lang=el" }), "oll4.com/c/5TFZkUtN?lang=el", 1_000_000);
    expect(answer.ok).toBe(true);
    expect(answer.images).toEqual([{ data: Buffer.from("png").toString("base64"), mimeType: "image/png" }]);
    const cited = /space_look https:\/\/\S+: <what the page shows>/.exec(answer.result)![0].replace("<what the page shows>", "step 2 names the button");
    expect(uiProofMissing("the invite page step", cited)).toBe(false);
    expect(UI_PROOF_HINT).toContain("space_look {url}");
    expect((await lookAtUrl(undefined, "https://example.com", 1)).ok).toBe(false);
  });
});
