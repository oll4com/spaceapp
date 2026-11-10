import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelTactics, loadArenaModelCatalog, registerBenchmarkRoutes } from "../src/benchmark-routes.js";
import { ArenaBenchmarkRunner } from "../src/asteroids-arena/runner.js";
import { createArenaFileStore } from "../src/asteroids-arena/store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/task-title-opencode.js", () => ({ resolveNativeOpenCodeRuntime: async () => null }));
vi.mock("../src/openrouter-benchmark-models.js", () => ({ loadOpenRouterBenchmarkModels: async () => [] }));
// Never read the host's Gateway credential; exercise the real provider with a fixture key.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) =>
    String(args[0]) === (process.env.SPACE_GATEWAY_KEY_FILE || process.env.SPACE_CODEX_LB_KEY_FILE || "/opt/spaceapp/secrets/space-gateway-internal.key")
      ? Promise.resolve("test-gateway-key") : fs.readFile(...args) };
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json(String(url).endsWith("/models") ? { data: [{ id: "test-model" }] }
      : { choices: [{ message: { content: JSON.stringify({ aggression: 0.8, maneuver: "hold", fire: true, note: "test" }) } }] });
  });
  const app = Fastify({ genReqId: () => "req:benchmark-server" });
  app.addHook("onRequest", async (request) => {
    request.requestIdForSpace = request.id;
    request.user = { id: "user:test", email: "test@example.test", role: "ADMIN" };
  });
  return { app, calls };
}

describe("OBS-006 benchmark Gateway correlation", () => {
  it("forwards the model catalog request's server id, omitting absent or oversized ids", async () => {
    const { app, calls } = fixture();
    registerBenchmarkRoutes(app, {});
    try {
      await loadArenaModelCatalog();
      expect(calls.at(-1)!.headers.get("x-request-id")).toBeNull();
      await loadArenaModelCatalog("x".repeat(121));
      expect(calls.at(-1)!.headers.get("x-request-id")).toBeNull();
      expect((await app.inject({ url: "/api/asteroids/benchmark/models", headers: { "x-request-id": "untrusted" } })).statusCode).toBe(200);
      expect(calls.at(-1)!.headers.get("x-request-id")).toBe("req:benchmark-server");
    } finally { await app.close(); }
  });

  it("forwards the tactics request's server id for single and batch calls, omitting absent or oversized ids", async () => {
    const { app, calls } = fixture();
    registerBenchmarkRoutes(app, {});
    try {
      await fetchModelTactics("codex/test-model");
      expect(calls.at(-1)!.headers.get("x-request-id")).toBeNull();
      await fetchModelTactics("codex/test-model", undefined, "x".repeat(121));
      expect(calls.at(-1)!.headers.get("x-request-id")).toBeNull();
      calls.length = 0;
      for (const payload of [{ modelId: "codex/test-model" }, { models: ["codex/test-model", "codex/other-model"] }]) {
        expect((await app.inject({ method: "POST", url: "/api/asteroids/benchmark/tactics", payload,
          headers: { "x-request-id": "untrusted" } })).statusCode).toBe(200);
      }
      expect(calls).toHaveLength(3);
      expect(calls.map((call) => call.headers.get("x-request-id"))).toEqual(Array(3).fill("req:benchmark-server"));
    } finally { await app.close(); }
  });

  it("keeps the arena start request's server id on Gateway preflight and round decisions", async () => {
    const { app, calls } = fixture();
    const root = await mkdtemp(join(tmpdir(), "arena-request-id-"));
    const store = createArenaFileStore(root);
    const runner = new ArenaBenchmarkRunner({ store, sleep: async () => {} });
    registerBenchmarkRoutes(app, {}, { store, runner });
    try {
      const response = await app.inject({ method: "POST", url: "/api/asteroids/benchmark/runs", headers: { "x-request-id": "untrusted" },
        payload: { mode: "championship", rounds: 1, contestants: ["codex/test-model", "baseline/scripted-pilot"] } });
      expect(response.statusCode).toBe(202);
      expect((await runner.done)!.status).toBe("completed");
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every((call) => call.headers.get("x-request-id") === "req:benchmark-server")).toBe(true);
      // Reusing the runner without a valid id must not retain the previous request's id.
      for (const traceId of [undefined, "x".repeat(121)]) {
        calls.length = 0;
        runner.start({ mode: "championship", rounds: 1, pace: false, contestants: [{ id: "codex/test-model" }, { id: "baseline/scripted-pilot" }], traceId });
        await runner.done;
        expect(calls.length).toBeGreaterThan(1);
        expect(calls.every((call) => call.headers.get("x-request-id") === null)).toBe(true);
      }
    } finally { runner.stop(); await runner.done; await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
