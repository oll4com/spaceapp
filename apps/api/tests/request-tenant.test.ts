import Fastify from "fastify";
import { currentTenantId } from "@space/db";
import { describe, expect, it } from "vitest";
import { requestTenantHook } from "../src/session-access.js";

const appWith = (tenants: Record<string, string | null>, lookups: string[] = []) => {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (request) => {
    const id = request.headers["x-user"];
    if (typeof id === "string") request.user = { id, email: "u@example.com", role: "USER" };
  });
  app.addHook("preHandler", requestTenantHook({ getUserTenantId: async (id) => (lookups.push(id), tenants[id] ?? null) }));
  app.get("/t", async () => ({ tenant: currentTenantId() ?? null }));
  return app;
};

describe("requestTenantHook (K1 M6)", () => {
  it("runs a signed-in request in its user's tenant, looked up once, and a public one in none", async () => {
    const lookups: string[] = [];
    const app = appWith({ "user:a": "tenant:a", "user:b": "tenant:local" }, lookups);
    const get = async (user?: string) => (await app.inject({ url: "/t", headers: user ? { "x-user": user } : {} })).json();
    expect(await get("user:a")).toEqual({ tenant: "tenant:a" });
    expect(await get("user:b")).toEqual({ tenant: "tenant:local" });
    expect(await get("user:a")).toEqual({ tenant: "tenant:a" });
    expect(await get()).toEqual({ tenant: null });
    expect(lookups).toEqual(["user:a", "user:b"]);
  });

  it("refuses a user with no row instead of running as the owner", async () => {
    const response = await appWith({}).inject({ url: "/t", headers: { "x-user": "user:ghost" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("TENANT_UNKNOWN");
  });

  it("uses tenant:local on a store without the lookup (in-memory, no row-level security)", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (request) => { request.user = { id: "user:operator", email: "o@example.com", role: "ADMIN" }; });
    app.addHook("preHandler", requestTenantHook({}));
    app.get("/t", async () => ({ tenant: currentTenantId() }));
    expect((await app.inject({ url: "/t" })).json()).toEqual({ tenant: "tenant:local" });
  });
});
