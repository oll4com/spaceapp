import Fastify from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createMcpToolExecutionInputSchema } from "@space/contracts";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import { getApiConfig } from "../src/config.js";
import { createMcpToolExecutor } from "../src/mcp-tool-executor.js";
import { recordAudit } from "../src/request-audit.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stdio-mcp-server.mjs", import.meta.url));
const hash = `sha256:${"a".repeat(64)}`;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "mcp-domain-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const callCountPath = join(root, "starts.txt");
  const store = new InMemorySpaceStore();
  store.recordMcpDiscoveryCatalog({ servers: [{ id: "fixture", displayName: "Fixture", transport: "stdio",
    status: mode === "unverified" ? "DISABLED" : "VERIFIED", statusReason: "Synthetic fixture", schemaVersion: "2025-11-25",
    configHash: hash, toolCount: 1, lastDiscoveredAt: null }],
    tools: [{ id: "fixture:list_files", serverId: "fixture", name: "list_files", riskLevel: "R2",
      schemaHash: hash, approvalRequired: true, status: "VERIFIED", statusReason: "Synthetic fixture" }] });
  const config = getApiConfig({ SPACE_ARTIFACT_ROOT: root });
  config.mcpToolExecutionEnabled = mode !== "disabled";
  config.mcpAllowlistedSchemaHashes = mode === "unallowlisted" ? [] : [hash];
  config.mcpServerConfigs = mode === "missing-config" ? [] : [{ id: "fixture", displayName: "Fixture", transport: "stdio",
    command: process.execPath, args: [fixturePath, "call-ok-count-start", callCountPath], enabled: true }];
  const app = Fastify();
  cleanups.push(() => app.close());
  app.addHook("onRequest", async request => {
    request.user = { id: "user:fixture", email: "fixture@example.test", role: "OPERATOR" };
    request.requestIdForSpace = "req:mcp-domain";
  });
  const execute = createMcpToolExecutor({ store, config, eventBus: new SpaceEventBus(),
    recordAudit: (request, input) => recordAudit(store, request, input) });
  // Authentication is tested at the application boundary separately. This
  // owned route supplies a verified principal to the independent service.
  app.post("/execute", async request => execute(createMcpToolExecutionInputSchema.parse(request.body), request));
  return { root, callCountPath, store, app };
}

it.each([
  ["disabled", "GATEWAY_DISABLED"],
  ["unknown-tool", "TOOL_NOT_FOUND"],
  ["unverified", "SERVER_NOT_VERIFIED"],
  ["unallowlisted", "SCHEMA_HASH_NOT_ALLOWLISTED"],
  ["unapproved", "RISK_APPROVAL_REQUIRED"],
  ["missing-config", "SERVER_CONFIG_MISSING"]
])("keeps %s execution fail-closed with correlated audit and no process", async (mode, code) => {
  const { app, store, callCountPath } = await fixture(mode);
  const response = await app.inject({ method: "POST", url: "/execute", payload: {
    toolId: mode === "unknown-tool" ? "fixture:absent" : "fixture:list_files", arguments: { path: "private-query" },
    ...(mode === "unapproved" ? {} : { approvalReason: "Fixture approval" })
  } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code, artifact: null,
    status: mode === "unapproved" ? "APPROVAL_REQUIRED" : "BLOCKED" });
  await expect(readFile(callCountPath)).rejects.toMatchObject({ code: "ENOENT" });
  const audit = store.listAuditEvents().filter(item => item.action === "mcp.tool.execute");
  expect(audit).toEqual([expect.objectContaining({ traceId: "req:mcp-domain", metadata: expect.objectContaining({ code }) })]);
  expect(JSON.stringify(audit)).not.toContain("private-query");
});

it("executes the approved fixture once and publishes only its redacted result", async () => {
  const { app, store, callCountPath } = await fixture("approved");
  const response = await app.inject({ method: "POST", url: "/execute", payload: {
    toolId: "fixture:list_files", arguments: { path: "/fixture" }, approvalReason: "Fixture approval"
  } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "EXECUTED", code: "TOOL_EXECUTION_OK", approved: true });
  expect(await readFile(callCountPath, "utf8")).toBe("start\n");
  const artifact = response.json().artifact;
  expect(store.getArtifact(artifact.id)).toMatchObject({ id: artifact.id, kind: "MCP_RESULT" });
  const output = await readFile(artifact.metadata.localPath, "utf8");
  expect(output).toContain("listed /fixture");
  expect(output).not.toContain("raw-credential-value-that-must-not-leak");
  expect(store.listAuditEvents()).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "mcp.tool.execute", traceId: "req:mcp-domain",
      metadata: expect.objectContaining({ status: "EXECUTED", artifactId: artifact.id }) })
  ]));
});
