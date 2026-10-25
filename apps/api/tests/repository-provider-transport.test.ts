import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { ProviderUrlPolicy } from "../src/source-control/providers.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())))); });
async function fixture(status: number, headers: Record<string, string> = {}, body = '{"ok":true}') {
  let authorization: string | undefined;
  const server = createServer((req, res) => { authorization = req.headers.authorization; res.writeHead(status, headers); res.end(body); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture unavailable");
  const url = new URL(`http://127.0.0.1:${address.port}/api/repos`);
  return { url, policy: new ProviderUrlPolicy([url.origin]), authorization: () => authorization };
}
describe("provider HTTP transport", () => {
  it("preserves pagination headers and provider-specific Basic authentication", async () => {
    const f = await fixture(200, { "x-next-page": "2", "x-ms-continuationtoken": "opaque-token" });
    const result = await f.policy.exchange(f.url, "Basic Zml4dHVyZTp0b2tlbg==", "GET");
    expect(result).toMatchObject({ data: { ok: true }, headers: { "x-next-page": "2", "x-ms-continuationtoken": "opaque-token" } });
    expect(f.authorization()).toBe("Basic Zml4dHVyZTp0b2tlbg==");
  });
  it.each([[301, "REDIRECT_BLOCKED"], [401, "INVALID_TOKEN"], [403, "INSUFFICIENT_PERMISSION"], [404, "REPOSITORY_NOT_FOUND"], [409, "REPOSITORY_COLLISION"], [422, "REPOSITORY_COLLISION"], [429, "RATE_LIMITED"], [500, "PROVIDER_FAILED"]])("sanitizes status %s without reflecting secret response text", async (status, code) => {
    const f = await fixture(status as number, { location: "https://foreign.invalid/secret" }, '{"error":"fixture-secret"}');
    await expect(f.policy.exchange(f.url, "Bearer fixture-secret", "POST", {})).rejects.toMatchObject({ code });
    try { await f.policy.exchange(f.url, "Bearer fixture-secret", "GET"); } catch (error) { expect(String(error)).not.toContain("fixture-secret"); }
  });
});
