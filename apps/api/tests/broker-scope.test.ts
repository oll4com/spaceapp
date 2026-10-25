import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { adminActionRoutes } from "@space/contracts";
import { createApp } from "../src/app.js";
import { createCsrfToken, csrfHeaderName, signSessionWithTtl } from "../src/auth.js";

const secret = "test-secret-with-enough-length";
const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function app(store = new InMemorySpaceStore()) {
  const created = await createApp({ store, auth: { sessionSecret: secret, devLogin: true, secureCookies: false } });
  apps.push(created);
  return created;
}
// What the auth broker signs (deploy/space-auth-broker) for an agent.
function brokerSession(brokerScope: string) {
  const token = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN", brokerScope }, secret, 60);
  return { cookie: `space_session=${token}`, [csrfHeaderName]: createCsrfToken(token, secret)! };
}

describe("broker-scoped agent sessions (hardening step 4)", () => {
  it("an ADMIN_ACTION session reaches its action's routes and nothing else", async () => {
    const api = await app();
    const headers = brokerSession("ADMIN_ACTION:user-appearance-get");
    expect((await api.inject({ method: "GET", url: "/api/auth/csrf", headers })).statusCode).toBe(200);
    expect((await api.inject({ method: "GET", url: "/api/user-settings", headers })).statusCode).toBe(200);
    for (const [method, url] of [["PATCH", "/api/user-settings"], ["GET", "/api/rooms"], ["GET", "/api/admin/users"], ["POST", "/api/admin/releases/promote"]] as const) {
      const denied = await api.inject({ method, url, headers, payload: method === "GET" ? undefined : {} });
      expect(denied.statusCode, `${method} ${url}`).toBe(403);
      expect(denied.json().error.code).toBe("BROKER_SCOPE_DENIED");
    }
    const unknown = await api.inject({ method: "GET", url: "/api/user-settings", headers: brokerSession("ADMIN_ACTION:no-such-action") });
    expect(unknown.statusCode).toBe(403);
  });

  it("a UI_PROOF session drives the app but never the operator-only routes", async () => {
    const api = await app();
    const headers = brokerSession("UI_PROOF");
    expect((await api.inject({ method: "GET", url: "/api/rooms", headers })).statusCode).toBe(200);
    expect((await api.inject({ method: "GET", url: "/api/admin/users", headers })).json()?.error?.code).not.toBe("BROKER_SCOPE_DENIED");
    // First Setup's Live provider keys are the operator's secrets, like the Vault (refused before the route runs).
    for (const [method, url] of [["POST", "/api/admin/releases/promote"], ["POST", "/api/admin/users/invites"], ["POST", "/api/configuration/export"],
      ["POST", "/api/setup/voice/credentials"]] as const) {
      const denied = await api.inject({ method, url, headers, payload: method === "GET" ? undefined : {} });
      expect(denied.statusCode, `${method} ${url}`).toBe(403);
      expect(denied.json().error.code, `${method} ${url}`).toBe("BROKER_SCOPE_DENIED");
    }
  });

  it("no agent session turns on Nous's allowances or runs a release, the operator's session does (hardening step 5)", async () => {
    const api = await app();
    for (const scope of ["UI_PROOF", "ADMIN_ACTION:user-appearance"]) {
      const denied = await api.inject({ method: "PATCH", url: "/api/user-settings", headers: brokerSession(scope), payload: { nous: { mayPromote: true } } });
      expect(denied.statusCode, scope).toBe(403);
    }
    // The old broker's unscoped proof sessions count as UI_PROOF.
    const legacy = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN" }, secret, 60);
    const legacyHeaders = { cookie: `space_session=${legacy}`, [csrfHeaderName]: createCsrfToken(legacy, secret)! };
    expect((await api.inject({ method: "POST", url: "/api/admin/releases/promote", headers: legacyHeaders, payload: {} })).statusCode).toBe(403);
    expect((await api.inject({ method: "PATCH", url: "/api/user-settings", headers: legacyHeaders, payload: { nous: { mayPromote: true } } })).statusCode).toBe(403);
    const login = await api.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
    const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
    const csrf = (await api.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    const person = await api.inject({ method: "PATCH", url: "/api/user-settings", headers: { cookie, [csrfHeaderName]: csrf }, payload: { nous: { mayPromote: true } } });
    expect(person.statusCode).toBe(200);
  });

  it("audits an admin action as the agent's operator-proof session it really was (hardening step 17)", async () => {
    const store = new InMemorySpaceStore();
    const api = await app(store);
    const changed = await api.inject({ method: "PATCH", url: "/api/user-settings", headers: brokerSession("ADMIN_ACTION:user-appearance"), payload: { uiTheme: "aurora" } });
    expect(changed.statusCode).toBe(200);
    const audit = (await store.listAuditEvents()).find((event) => event.action === "user_settings.update");
    // It acted in the operator's account; the row names the broker session and its scope.
    expect(audit).toMatchObject({ actorUserId: "user:operator", metadata: { sessionPrincipal: "user:operator-proof", brokerScope: "ADMIN_ACTION:user-appearance" } });
  });

  it("checks the route the router matched, so encoded or cut paths cannot slip past (security review 2026-10-19)", async () => {
    const api = await app();
    const proof = brokerSession("UI_PROOF");
    expect((await api.inject({ method: "GET", url: "/api/space%2Dvault/state", headers: proof })).json().error.code).toBe("BROKER_SCOPE_DENIED");
    expect((await api.inject({ method: "POST", url: "/api/admin/user%73/invites", headers: proof, payload: {} })).json().error.code).toBe("BROKER_SCOPE_DENIED");
    const cli = brokerSession("ADMIN_ACTION:freelance-cli-start");
    const cut = await api.inject({ method: "POST", url: "/api/panes/pane%3Aabcdef#/cli/session", headers: cli, payload: {} });
    expect(cut.statusCode).toBe(403);
    // A MEDIA_CAPTURE session (read-only, no scope from the broker) is a UI_PROOF session that writes nothing.
    const capture = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN", proofScope: "READ_ONLY" }, secret, 60);
    const captureHeaders = { cookie: `space_session=${capture}`, [csrfHeaderName]: createCsrfToken(capture, secret)! };
    expect((await api.inject({ method: "GET", url: "/api/rooms", headers: captureHeaders })).statusCode).toBe(200);
    expect((await api.inject({ method: "GET", url: "/api/space-vault/state", headers: captureHeaders })).statusCode).toBe(403);
    expect((await api.inject({ method: "POST", url: "/api/rooms", headers: captureHeaders, payload: { name: "x", initialPaneCount: 0 } })).statusCode).toBe(403);
    // space_screenshot's capture session carries the caller's own id; read-only still means read-only (addendum step 4).
    const own = signSessionWithTtl({ id: "user:operator", email: "space@space.local", role: "ADMIN", proofScope: "READ_ONLY" }, secret, 120);
    const ownHeaders = { cookie: `space_session=${own}`, [csrfHeaderName]: createCsrfToken(own, secret)! };
    expect((await api.inject({ method: "GET", url: "/api/rooms", headers: ownHeaders })).statusCode).toBe(200);
    const write = await api.inject({ method: "POST", url: "/api/rooms", headers: ownHeaders, payload: { name: "x", initialPaneCount: 0 } });
    expect(write.json().error.code).toBe("READ_ONLY_SESSION");
    // The App Diagnostics session (read-only, as the broker signs it) keeps exactly its own diagnostics writes.
    const diagnostics = signSessionWithTtl({ id: "user:operator-diagnostics", email: "space@space.local", role: "ADMIN", proofScope: "READ_ONLY",
      automationScope: "APP_DIAGNOSTICS" }, secret, 120);
    const diagnosticsHeaders = { cookie: `space_session=${diagnostics}`, [csrfHeaderName]: createCsrfToken(diagnostics, secret)! };
    const debugOn = await api.inject({ method: "PATCH", url: "/api/admin/app-diagnostics", headers: diagnosticsHeaders, payload: { isEnabled: true } });
    expect(["READ_ONLY_SESSION", "AUTOMATION_SCOPE_READ_ONLY", "BROKER_SCOPE_DENIED"]).not.toContain(debugOn.json().error?.code);
    const other = await api.inject({ method: "POST", url: "/api/rooms", headers: diagnosticsHeaders, payload: { name: "x", initialPaneCount: 0 } });
    expect(other.json().error.code).toBe("AUTOMATION_SCOPE_READ_ONLY");
  });

  it("lets agent sessions change appearance, never what steers or silences the operator (security review 2026-10-19)", async () => {
    const api = await app();
    const patch = (scope: string, payload: Record<string, unknown>) => api.inject({ method: "PATCH", url: "/api/user-settings", headers: brokerSession(scope), payload });
    expect((await patch("ADMIN_ACTION:user-appearance", { uiTheme: "aurora" })).statusCode).toBe(200);
    expect((await patch("ADMIN_ACTION:user-appearance", { dateTime: { timeFormat: "24h" } })).statusCode).toBe(403);
    expect((await patch("UI_PROOF", { uiTheme: "aurora" })).statusCode).toBe(200);
    for (const payload of [{ livePane: { prompt: "x" } }, { notifications: {} }, { promptVariables: [] }, { suppressNotifications: true }]) {
      expect((await patch("UI_PROOF", payload)).statusCode, JSON.stringify(payload)).toBe(403);
    }
  });

  it("every admin action's routes exist and pass its own scope", async () => {
    const api = await app();
    for (const [action, routes] of Object.entries(adminActionRoutes)) {
      for (const pattern of routes) {
        const [method, target] = pattern.split(" ", 2) as [string, string];
        // Literal route segments the actions use (council actions, copilot run verbs, copilot views).
        const sample = (name: string) => name === "action" ? (target.includes("/council/") ? "approve" : "start") : name === "view" ? "memory" : encodeURIComponent(`${name}:abcdef12`);
        const url = target.replace(/:([a-z]+)/g, (_match, name: string) => sample(name));
        const response = await api.inject({ method: method as "GET", url, headers: brokerSession(`ADMIN_ACTION:${action}`), payload: method === "GET" ? undefined : {} });
        expect(response.json()?.error?.code, `${action}: ${pattern}`).not.toBe("BROKER_SCOPE_DENIED");
      }
    }
  }, 120_000);

  it("a session with an unknown scope value is not a session", async () => {
    const api = await app();
    const response = await api.inject({ method: "GET", url: "/api/auth/me", headers: brokerSession("EVERYTHING") });
    expect(response.json().user ?? null).toBeNull();
  });
});
