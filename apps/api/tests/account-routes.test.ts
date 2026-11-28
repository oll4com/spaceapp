import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { AccountLifecycle, AccountView } from "../src/computer/accounts.js";
import { AccountStateError } from "../src/computer/accounts.js";

// K2 §3.2 account routes over a fake lifecycle (the lifecycle itself: nous-computer-accounts-postgres.test.ts).
const sessionSecret = "account-routes-test-secret";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function fakeLifecycle(kind = "PERSONAL") {
  const calls: string[] = [];
  let status = "ACTIVE";
  const view = (tenantId: string): AccountView => ({ tenantId, kind, region: "eu", status, deleteAfter: status === "DELETING" ? "2026-12-04T00:00:00.000Z" : null });
  const lifecycle = {
    account: async (tenantId: string) => view(tenantId),
    requestDeletion: async (tenantId: string) => { calls.push(`delete ${tenantId}`); status = "DELETING"; return { exportKey: "exports/a.tar", deleteAfter: 0 }; },
    cancelDeletion: async (tenantId: string) => {
      if (status !== "DELETING") throw new AccountStateError("nothing to cancel");
      calls.push(`cancel ${tenantId}`); status = "ACTIVE";
    }
  } as unknown as AccountLifecycle;
  return { lifecycle, calls };
}

async function appWith(options: { headless: boolean; tenant: string | null; lifecycle: AccountLifecycle }) {
  const store = new InMemorySpaceStore();
  store.getUserTenantId = async () => options.tenant;
  const app = await createApp({ store, config: { ...getApiConfig({}), headless: options.headless },
    auth: { sessionSecret, devLogin: false, secureCookies: false }, accountLifecycle: options.lifecycle });
  apps.push(app);
  return app;
}
function headers(role: "USER" | "ADMIN" = "USER") {
  const session = signSession({ id: "user:alice", email: "alice@example.test", role }, sessionSecret);
  return { cookie: `space_session=${session}`, [csrfHeaderName]: createCsrfToken(session, sessionSecret)! };
}

describe("account routes (headless)", () => {
  it("reads, deletes with export and cancels the signed-in user's account", async () => {
    const { lifecycle, calls } = fakeLifecycle();
    const app = await appWith({ headless: true, tenant: "tenant:alice", lifecycle });
    expect((await app.inject({ method: "GET", url: "/api/account" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/account", headers: headers() })).json()).toMatchObject({ tenantId: "tenant:alice", status: "ACTIVE" });
    const deleted = await app.inject({ method: "DELETE", url: "/api/account", headers: headers() });
    expect(deleted.json()).toMatchObject({ status: "DELETING", deleteAfter: "2026-12-04T00:00:00.000Z", exportReady: true });
    expect((await app.inject({ method: "POST", url: "/api/account/deletion/cancel", headers: headers() })).json()).toMatchObject({ status: "ACTIVE" });
    expect((await app.inject({ method: "POST", url: "/api/account/deletion/cancel", headers: headers() })).statusCode).toBe(409);
    expect(calls).toEqual(["delete tenant:alice", "cancel tenant:alice"]);
  });

  it("refuses the self-hosted tenant and a team member, and is not registered outside headless", async () => {
    const local = await appWith({ headless: true, tenant: "tenant:local", lifecycle: fakeLifecycle().lifecycle });
    expect((await local.inject({ method: "DELETE", url: "/api/account", headers: headers() })).statusCode).toBe(403);
    const team = fakeLifecycle("TEAM");
    const teamApp = await appWith({ headless: true, tenant: "tenant:team", lifecycle: team.lifecycle });
    expect((await teamApp.inject({ method: "DELETE", url: "/api/account", headers: headers("USER") })).statusCode).toBe(403);
    expect((await teamApp.inject({ method: "DELETE", url: "/api/account", headers: headers("ADMIN") })).statusCode).toBe(200);
    const selfHosted = await appWith({ headless: false, tenant: "tenant:alice", lifecycle: fakeLifecycle().lifecycle });
    expect((await selfHosted.inject({ method: "GET", url: "/api/account", headers: headers() })).statusCode).toBe(404);
  });
});
