import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync("public/mock-worker.js", "utf8")
  .replace("__MOCK_RELEASE__", "proof")
  .replace("__MOCK_BOOT_ASSETS__", "[]")
  .replace("__MOCK_BASE__", "/demoappnew/");
function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const stored = new Map<string, any>();
  let online = true;
  const calls: any[] = [];
  const key = (request: any) => typeof request === "string" ? request : request.url;
  const response = { ok: true, clone() { return this; } };
  runInNewContext(source, {
    URL,
    self: { location: { origin: "https://spaceapp.dev" }, addEventListener: (type: string, fn: any) => handlers.set(type, fn) },
    caches: { open: async () => ({ match: async (request: any) => stored.get(key(request)), put: async (request: any, value: any) => stored.set(key(request), value) }) },
    fetch: async (request: any, options: any) => { calls.push({ request, options }); if (!online) throw new Error("offline"); return response; },
  });
  const request = (path: string, mode = "cors", method = "GET") => {
    let result: Promise<any> | undefined;
    handlers.get("fetch")!({ request: { url: new URL(path, "https://spaceapp.dev").href, method, mode }, respondWith: (promise: Promise<any>) => { result = promise; } });
    return result;
  };
  return { request, calls, stored, response, offline: () => { online = false; } };
}
describe("public demo asset cache isolation", () => {
  it("never intercepts private APIs, homepage, uploads, unversioned assets or writes", () => {
    const w = worker();
    for (const path of ["/", "/api/me", "/demoappnew/api/me", "/demoappnew/uploads/file.png", "/demoappnew/mock-version.json", "https://external.test/demoappnew/assets/App-12345678.js"]) expect(w.request(path, "navigate")).toBeUndefined();
    expect(w.request("/demoappnew/assets/App-12345678.js", "cors", "POST")).toBeUndefined();
    expect(w.calls).toHaveLength(0);
  });
  it("serves a hashed asset from cache even with no network and omits credentials on first fetch", async () => {
    const w = worker();
    await w.request("/demoappnew/assets/App-12345678.js");
    w.offline();
    expect(await w.request("/demoappnew/assets/App-12345678.js")).toBe(w.response);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].options.credentials).toBe("omit");
  });
  it("revalidates HTML and uses it as an offline fallback without caching query variants", async () => {
    const w = worker();
    await w.request("/demoappnew/?v=new", "navigate");
    expect(w.calls[0].options.cache).toBe("no-cache");
    expect(w.stored.has("/demoappnew/")).toBe(true);
    w.offline();
    expect(await w.request("/demoappnew/?v=another", "navigate")).toBe(w.response);
  });
});
