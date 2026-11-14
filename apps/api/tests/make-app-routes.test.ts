import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAKE_APP_PATHS, registerMakeAppRoutes, type MakeAppRouteDeps } from "../src/make-app-routes.js";
import { publicPaths } from "../src/api-request-classes.js";

const KEY = "k".repeat(40);
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function setup(options: { key?: string | null; users?: Array<{ id: string; email: string; role: string; disabled?: boolean }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "make-app-"));
  const keyFile = join(dir, "key");
  if (options.key !== null) writeFileSync(keyFile, `${options.key ?? KEY}\n`);
  const store = {
    listUsersWithRoomCounts: vi.fn(async () => options.users ?? [{ id: "user:member", email: "m@x", role: "USER" }, { id: "user:op", email: "op@x", role: "ADMIN" }]),
    upsertTaskItem: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: "task:1", createdAt: "2026-11-13T00:00:00.000Z" })),
    getPane: vi.fn(async (id: string) => { if (id === "pane:gone") throw new Error("missing"); return { id, roomId: id === "pane:other" ? "room:other" : "room:op", mode: "DESIGN" }; }),
    upsertUser: vi.fn(), recordAuditEvent: vi.fn(async () => undefined)
  };
  const service = {
    send: vi.fn(async () => ({ id: "nous_msg:1", createdAt: "2026-11-13T00:00:00.000Z" })),
    decisions: vi.fn(async () => [{ id: "d1", status: "OPEN", category: "EXTERNAL", title: "Send?", body: "b", options: ["Yes", "No"], recommendation: "Yes", createdAt: "t" },
      { id: "d2", status: "APPROVED", category: "EXTERNAL", title: "Old", body: "b", options: [], recommendation: null, createdAt: "t" }])
  };
  const notifications = { list: vi.fn(async () => [
    { id: "n2", title: "Done B", body: "", createdAt: "2026-11-13T10:00:00.000Z", roomId: null, paneId: null },
    { id: "n1", title: "Done A", body: "", createdAt: "2026-11-13T08:00:00.000Z", roomId: null, paneId: null }]) };
  const brief = vi.fn(async () => ({}));
  const app = Fastify(); apps.push(app);
  registerMakeAppRoutes(app, { store, operatorEmail: "op@x", nous: () => ({ service }), notifications, brief: () => brief,
    roomOwner: async (roomId) => (roomId === "room:op" ? "user:op" : "user:member"), routeOptions: {}, keyFiles: [keyFile] } as unknown as MakeAppRouteDeps);
  const call = (method: "GET" | "POST", url: string, payload?: unknown, key = KEY) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
  return { store, service, notifications, brief, call };
}

describe("Make app routes", () => {
  it("are public paths whose key is checked inside, off without a key file or with a short key", async () => {
    for (const path of MAKE_APP_PATHS) expect(publicPaths.has(path)).toBe(true);
    expect((await setup({ key: null }).call("GET", "/api/make/v1/me")).statusCode).toBe(404);
    expect((await setup({ key: "short" }).call("GET", "/api/make/v1/me", undefined, "short")).statusCode).toBe(404);
    const { call, store } = setup();
    expect((await call("GET", "/api/make/v1/me", undefined, "wrong")).statusCode).toBe(401);
    expect((await call("POST", "/api/make/v1/tasks", { title: "t", objective: "o" }, "wrong")).statusCode).toBe(401);
    expect(store.upsertTaskItem).not.toHaveBeenCalled();
    expect((await call("GET", "/api/make/v1/me")).json()).toEqual({ ok: true, app: "SpaceApp" });
  });

  it("acts as the operator ADMIN and refuses without one", async () => {
    expect((await setup({ users: [{ id: "user:member", email: "m@x", role: "USER" }] }).call("GET", "/api/make/v1/me")).statusCode).toBe(503);
    const { call, store, service } = setup();
    const task = await call("POST", "/api/make/v1/tasks", { title: "Lead", objective: "Call back" });
    expect(task.statusCode).toBe(201);
    expect(store.upsertTaskItem).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "user:op", title: "Lead", status: "OPEN" }));
    expect(store.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "user:op", action: "make.task.create", metadata: expect.objectContaining({ via: "make-app" }) }));
    expect((await call("POST", "/api/make/v1/nous/messages", { content: "New Stripe sale" })).statusCode).toBe(201);
    expect(service.send).toHaveBeenCalledWith("user:op", "From Make: New Stripe sale", { person: false });
  });

  it("briefs only the operator's own panes", async () => {
    const { call, brief } = setup();
    expect((await call("POST", "/api/make/v1/briefs", { paneId: "pane:other", text: "x" })).statusCode).toBe(404);
    expect((await call("POST", "/api/make/v1/briefs", { paneId: "pane:gone", text: "x" })).statusCode).toBe(404);
    expect(brief).not.toHaveBeenCalled();
    expect((await call("POST", "/api/make/v1/briefs", { paneId: "pane:design", text: "Banner" })).statusCode).toBe(201);
    expect(brief).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:design" }), "user:op", "Banner");
  });

  it("lists Done records after `since` and the open approvals", async () => {
    const { call, notifications } = setup();
    const done = (await call("GET", "/api/make/v1/done?since=2026-11-13T09:00:00.000Z")).json();
    expect(done).toEqual({ items: [expect.objectContaining({ id: "n2", title: "Done B" })], next: null });
    expect(notifications.list).toHaveBeenCalledWith("user:op", expect.objectContaining({ kind: "REQUEST_DONE", source: "NOUS" }));
    expect((await call("GET", "/api/make/v1/approvals")).json().items.map((item: { id: string }) => item.id)).toEqual(["d1"]);
  });

  it("ships a Make app definition whose modules call these routes", () => {
    const def = JSON.parse(readFileSync(join(__dirname, "../../../docs/integrations/make-app/spaceapp.make-app.json"), "utf8")) as { modules: Array<{ communication: { url: string } }> };
    for (const module of def.modules) expect(MAKE_APP_PATHS).toContain(`/api/make/v1${module.communication.url}`);
  });
});
