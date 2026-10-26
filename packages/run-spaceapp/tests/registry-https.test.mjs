import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { httpsGet, noProxyCovers, registryProxy, RegistryUnreachableError } from "../src/registry-https.mjs";

const ghcr = "https://ghcr.io/v2/oll4com/spaceapp-core/manifests/sha256:abc";
const storage = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/sha256:abc";
const docker = (httpsProxy = "", noProxy = "") => () => ({ httpsProxy, noProxy });

test("the environment's proxy wins over the Docker client's, which is the fallback", () => {
  assert.equal(registryProxy(ghcr, { env: { HTTPS_PROXY: "http://env:3128" }, dockerConfig: docker("http://docker:3128") }), "http://env:3128");
  assert.equal(registryProxy(ghcr, { env: { https_proxy: "http://lower:3128" }, dockerConfig: docker("http://docker:3128") }), "http://lower:3128");
  assert.equal(registryProxy(ghcr, { env: {}, dockerConfig: docker("http://docker:3128") }), "http://docker:3128");
  assert.equal(registryProxy(ghcr, { env: { HTTPS_PROXY: " " }, dockerConfig: docker() }), null);
  assert.equal(registryProxy(ghcr, { env: {}, dockerConfig: docker() }), null);
});

test("NO_PROXY from the environment, else the Docker client's noProxy, keeps ghcr.io and its storage host direct", () => {
  for (const noProxy of ["ghcr.io,.githubusercontent.com", "*", "localhost ghcr.io:443 *.githubusercontent.com", "GHCR.IO,githubusercontent.com"]) {
    assert.equal(registryProxy(ghcr, { env: { HTTPS_PROXY: "http://p:3128", NO_PROXY: noProxy }, dockerConfig: docker() }), null, noProxy);
    assert.equal(registryProxy(storage, { env: { HTTPS_PROXY: "http://p:3128", no_proxy: noProxy }, dockerConfig: docker() }), null, noProxy);
  }
  assert.equal(registryProxy(ghcr, { env: {}, dockerConfig: docker("http://docker:3128", "ghcr.io") }), null);
  assert.equal(registryProxy(storage, { env: {}, dockerConfig: docker("http://docker:3128", "ghcr.io") }), "http://docker:3128");
  // A bare domain covers its subdomains, as in curl; not covered: a lookalike suffix, another port, an empty list.
  assert.equal(noProxyCovers("example.com,io", "ghcr.io"), true);
  assert.equal(noProxyCovers("example.com,cr.io", "ghcr.io"), false);
  assert.equal(noProxyCovers("ghcr.io:5000", "ghcr.io"), false);
  assert.equal(noProxyCovers("", "ghcr.io"), false);
});

test("the Docker client config is read from DOCKER_CONFIG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-docker-config-"));
  await writeFile(join(dir, "config.json"), JSON.stringify({ proxies: { default: { httpsProxy: "http://corp:8080", noProxy: "githubusercontent.com" } } }));
  assert.equal(registryProxy(ghcr, { env: { DOCKER_CONFIG: dir } }), "http://corp:8080");
  assert.equal(registryProxy(storage, { env: { DOCKER_CONFIG: dir } }), null);
  assert.equal(registryProxy(ghcr, { env: { DOCKER_CONFIG: join(dir, "missing") } }), null);
});

test("a read goes through the proxy's CONNECT tunnel; a refused tunnel or connection is an unreachable registry", async () => {
  const seen = [];
  const proxy = http.createServer();
  proxy.on("connect", (request, socket) => {
    seen.push({ target: request.url, auth: request.headers["proxy-authorization"] });
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address();
  try {
    const error = await httpsGet(ghcr, { env: { HTTPS_PROXY: `http://user:p%40ss@127.0.0.1:${port}` }, timeoutMs: 5_000 }).catch((reason) => reason);
    assert.ok(error instanceof RegistryUnreachableError);
    assert.match(error.message, /answered 407 to CONNECT ghcr\.io/);
    assert.deepEqual(seen, [{ target: "ghcr.io:443", auth: `Basic ${Buffer.from("user:p@ss").toString("base64")}` }]);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
  const refused = await httpsGet(ghcr, { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, timeoutMs: 5_000 }).catch((reason) => reason);
  assert.ok(refused instanceof RegistryUnreachableError);
  assert.match(refused.message, /the proxy 127\.0\.0\.1:\d+ failed: connect ECONNREFUSED/);
});
