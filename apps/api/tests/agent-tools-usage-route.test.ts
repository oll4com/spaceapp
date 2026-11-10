import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStore } from "@space/runtime";
import { registerAgentToolRoutingRoutes } from "../src/agent-tool-routing-routes.js";

let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function build(usagePath: string) {
  app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"];
    (request as unknown as { user: unknown }).user = role ? { id: "user:proof", email: "proof@example.invalid", role } : null;
  });
  registerAgentToolRoutingRoutes(app, {
    store: {} as SpaceStore, agentToolsOptions: undefined, recordAudit: async () => {}, routeOptions: {}, capabilityUsagePath: usagePath
  });
  await app.ready();
  return app;
}

describe("agent tool usage", () => {
  it("serves the collected usage to ADMIN only and says when none exists yet", async () => {
    const scratch = join(tmpdir(), "20261012-plugin-routes");
    await mkdir(scratch, { recursive: true });
    directory = await mkdtemp(`${scratch}/usage-`);
    const usagePath = join(directory, "capability-usage.json");
    const server = await build(usagePath);
    expect((await server.inject({ url: "/api/agent-tools/usage", headers: { "x-test-role": "ADMIN" } })).json()).toMatchObject({ available: false });
    await writeFile(usagePath, JSON.stringify({ id: "space-capability-usage", windowDays: 30, skills: [{ name: "space-a", uses: 2 }], mcp: [] }));
    const admin = await server.inject({ url: "/api/agent-tools/usage", headers: { "x-test-role": "ADMIN" } });
    expect(admin.json()).toMatchObject({ available: true, windowDays: 30, skills: [{ name: "space-a", uses: 2 }] });
    const user = await server.inject({ url: "/api/agent-tools/usage", headers: { "x-test-role": "USER" } });
    expect(user.statusCode).toBe(403);
  });
});
