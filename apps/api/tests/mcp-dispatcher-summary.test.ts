import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { getApiConfig } from "../src/config.js";
import { registerMcpRoutes } from "../src/mcp-routes.js";
import type { CliRuntimeVisibilityPolicy } from "../src/cli-runtime-visibility.js";

let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function mcpPayload(usagePath: string) {
  app = Fastify();
  registerMcpRoutes(app, {
    config: getApiConfig({}), store: new InMemorySpaceStore(), cliRuntimeVisibility: {} as CliRuntimeVisibilityPolicy,
    routeOptions: {}, executeMcpToolWithPolicy: async () => { throw new Error("unused"); }, capabilityUsagePath: usagePath
  });
  return (await app.inject({ url: "/api/mcp" })).json();
}

describe("MCP payload", () => {
  it("summarizes the CLI dispatcher backends from the inventory job, or null before it ran", async () => {
    const scratch = join(tmpdir(), "20261013-mcp-dispatcher-summary");
    await mkdir(scratch, { recursive: true });
    directory = await mkdtemp(`${scratch}/usage-`);
    const usagePath = join(directory, "capability-usage.json");
    expect((await mcpPayload(usagePath)).dispatcher).toBeNull();
    await app?.close();
    await writeFile(usagePath, JSON.stringify({ generatedAt: "2026-10-13T04:25:32.509Z", backends: [
      { id: "space_ops", toolCount: 7, stale: false, description: "Ops" },
      { id: "playwright_pane", toolCount: 0, stale: true }
    ] }));
    expect((await mcpPayload(usagePath)).dispatcher).toEqual({ backendCount: 2, staleIds: ["playwright_pane"], checkedAt: "2026-10-13T04:25:32.509Z" });
  });
});
