import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createNousWeb } from "../src/nous/web.js";
import { fetchPublicUrl, isPublicAddress, PublicUrlRedirectError, PublicUrlRefusedError } from "../src/public-url-fetch.js";

describe("fetchPublicUrl", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()));

  it("classifies private, loopback, link-local, metadata and translated addresses as not public", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "0:0:0:0:0:0:0:1", "::", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "fe80::1", "fd00::1", "64:ff9b::a00:1", "2002:a00:1::1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });

  it("refuses private literals, local names and private DNS answers without connecting", async () => {
    const resolver = async (hostname: string) => [{ address: hostname === "rebind.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }];
    for (const url of ["http://127.0.0.1:4911/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/",
      "http://[0:0:0:0:0:0:0:1]/", "http://localhost/", "http://metadata.google.internal/", "http://rebind.example/", "file:///etc/passwd",
      "http://user:pass@example.com/"]) {
      await expect(fetchPublicUrl(url, { timeoutMs: 1000, resolver }), url).rejects.toBeInstanceOf(PublicUrlRefusedError);
    }
  });

  it("fetches an allowed page and refuses a redirect to a private address", async () => {
    server = createServer((request, response) => {
      if (request.url === "/hop") { response.writeHead(302, { location: "http://10.0.0.1/admin" }); response.end(); return; }
      response.writeHead(200, { "content-type": "text/html" }); response.end("<title>Public</title>");
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const options = { timeoutMs: 2000, resolver: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: (address: string) => address === "127.0.0.1" };
    const page = await fetchPublicUrl(`http://public.example:${port}/`, options);
    expect(page).toMatchObject({ status: 200, ok: true, text: "<title>Public</title>" });
    await expect(fetchPublicUrl(`http://public.example:${port}/hop`, options)).rejects.toBeInstanceOf(PublicUrlRefusedError);
  });

  it("decodes a gzip or brotli body the server sent unasked (platform.minimax.io read as binary, 16/11) and cuts at maxBytes decoded", async () => {
    const html = `<title>Compressed</title>${"x".repeat(5_000)}`;
    server = createServer((request, response) => {
      const br = request.url === "/br";
      response.writeHead(200, { "content-type": "text/html", "content-encoding": br ? "br" : "gzip" });
      response.end(br ? brotliCompressSync(html) : gzipSync(html));
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const options = { timeoutMs: 2000, resolver: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: (address: string) => address === "127.0.0.1" };
    expect((await fetchPublicUrl(`http://public.example:${port}/`, options)).text).toBe(html);
    expect((await fetchPublicUrl(`http://public.example:${port}/br`, options)).text).toBe(html);
    expect((await fetchPublicUrl(`http://public.example:${port}/`, { ...options, maxBytes: 100 })).text).toBe(html.slice(0, 100));
  });

  it("names a redirect loop's chain, and space_net_check / space_web_read answer it instead of failing (nousapp.dev 16/11 05:19Z)", async () => {
    server = createServer((request, response) => {
      response.writeHead(301, { location: request.url === "/a" ? "/b" : "/a", ...(request.url === "/b" ? { "set-cookie": "sid=secret; Path=/" } : {}) });
      response.end();
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://public.example:${port}`;
    const error = await fetchPublicUrl(`${base}/a`, { timeoutMs: 2000, resolver: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: () => true })
      .catch((caught: unknown) => caught) as PublicUrlRedirectError;
    expect(error).toBeInstanceOf(PublicUrlRedirectError);
    expect(error).toMatchObject({ loop: true, next: `${base}/a`, chain: [{ url: `${base}/a`, status: 301, setCookie: false }, { url: `${base}/b`, status: 301, setCookie: true }] });
    const web = createNousWeb({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], allowAddress: () => true, checkTimeoutMs: 2000 });
    const check = await web.check({ check: "http", host: `${base}/a` } as never);
    expect(check).toContain(`GET ${base}/a → redirect loop, last HTTP 301:\n1. ${base}/a → HTTP 301\n2. ${base}/b → HTTP 301 (sets a cookie; none is sent back)\nnext: ${base}/a`);
    expect(check).not.toContain("secret");
    expect(await web.read({ url: `${base}/b` } as never)).toMatch(/^GET .*\/b → redirect loop, last HTTP 301:/);
  });
});
