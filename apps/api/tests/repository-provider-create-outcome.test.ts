import { describe, expect, it } from "vitest";
import * as providers from "../src/source-control/providers.js";
import { GitControlError } from "../src/source-control/errors.js";

// The publish journal relies on these marks: only the create request itself can leave an unknown outcome.
const policy = new providers.ProviderUrlPolicy();
const gitlab = (route: (method: string, path: string) => unknown) => providers.createRepositoryProvider("gitlab", "https://gitlab.com", { token: "fixture" }, policy, async (url, _auth, method) => {
  const value = route(method, url.pathname.replace(/^\/api\/v4/, ""));
  if (value instanceof Error) throw value;
  return { data: value, headers: {} };
});
const reject = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as GitControlError; } throw new Error("expected rejection"); };

describe("repository create outcome marks", () => {
  it("marks a failed lookup before the POST as not sent", async () => {
    const error = await reject(gitlab((method, path) => path === "/user" ? new GitControlError("PROVIDER_UNAVAILABLE", "down", 503) : {}).createRepository({ name: "repo", private: true }));
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", createNotSent: true });
    expect(error.createAttempted).toBeUndefined();
  });
  it("marks a failed POST, including an unreadable success answer, as attempted", async () => {
    const offline = await reject(gitlab((method, path) => path === "/user" ? { id: 1, username: "dev" } : new GitControlError("PROVIDER_UNAVAILABLE", "down", 503)).createRepository({ name: "repo", private: true }));
    expect(offline).toMatchObject({ createAttempted: true }); expect(offline.createNotSent).toBeUndefined();
    const unreadable = await reject(gitlab((method, path) => path === "/user" ? { id: 1, username: "dev" } : { id: "not-numeric" }).createRepository({ name: "repo", private: true }));
    expect(unreadable).toMatchObject({ createAttempted: true }); expect(unreadable.createNotSent).toBeUndefined();
  });
  it("maps provider 4xx answers to a definite rejection and 408 to unavailable", async () => {
    const { createServer } = await import("node:http");
    for (const [status, code, http] of [[400, "PROVIDER_REJECTED", 400], [405, "PROVIDER_REJECTED", 400], [408, "PROVIDER_UNAVAILABLE", 503], [500, "PROVIDER_FAILED", 502]] as const) {
      const server = createServer((_request, response) => { response.writeHead(status, { "content-type": "application/json" }).end("{}"); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      const error = await reject(new providers.ProviderUrlPolicy([origin]).exchange(new URL(`${origin}/x`), "Bearer fixture", "POST", {}));
      expect(error).toMatchObject({ code, statusCode: http });
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
