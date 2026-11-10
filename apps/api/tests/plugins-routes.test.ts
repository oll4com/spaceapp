import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { PluginsService } from "../src/plugins-service.js";
import { registerPluginRoutes } from "../src/plugins-routes.js";

type Role = "ADMIN" | "OPERATOR" | "USER";
let app: FastifyInstance;
let directory: string;
let audits: Array<{ action: string; targetType: string; targetId?: string | null; metadata?: Record<string, unknown> }>;

beforeEach(async () => {
  const scratch = join(tmpdir(), "20261012-plugin-routes");
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(`${scratch}/plugins-`);
  audits = [];
  app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"] as Role | undefined;
    (request as unknown as { user: unknown }).user = role ? { id: `user:${role.toLowerCase()}`, email: "proof@example.invalid", role } : null;
  });
  registerPluginRoutes(app, {}, undefined, {
    service: new PluginsService(directory, false),
    recordAudit: async (_request, input) => { audits.push(input); }
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

const post = (url: string, role: Role, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { "x-test-role": role }, ...(payload === undefined ? {} : { payload }) });

describe("installation plugin routes", () => {
  it("refuses installation plugin changes from a USER account and records nothing", async () => {
    const attempts = [
      post("/api/plugins/superpowers/disconnect", "USER"),
      post("/api/plugins/context7/connect", "USER", { credentials: {} }),
      post("/api/plugins/upgrade-all", "USER"),
      post("/api/plugins/superpowers/update", "USER"),
      post("/api/plugins/superpowers/check-update", "USER"),
      post("/api/plugins/agent/pane:proof", "USER", { enabledPluginIds: [], disabledPluginIds: [] })
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ADMIN_REQUIRED");
    }
    expect(audits).toEqual([]);
    const catalog = await app.inject({ url: "/api/plugins", headers: { "x-test-role": "USER" } });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().find((plugin: { id: string }) => plugin.id === "superpowers").connection.status).toBe("CONNECTED");
  });

  it("lets an ADMIN or OPERATOR change installation plugins and audits each change", async () => {
    const disconnected = await post("/api/plugins/superpowers/disconnect", "ADMIN");
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json().status).toBe("NOT_CONNECTED");
    const reconnected = await post("/api/plugins/superpowers/connect", "OPERATOR", { credentials: {} });
    expect(reconnected.statusCode).toBe(200);
    expect(audits.map((entry) => [entry.action, entry.targetType, entry.targetId])).toEqual([
      ["plugins.disconnected", "plugin", "superpowers"],
      ["plugins.connected", "plugin", "superpowers"]
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/credentials/);
  });
});
