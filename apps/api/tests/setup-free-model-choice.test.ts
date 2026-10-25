import Fastify from "fastify";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

const secret = "installation-specific-session-secret-for-tests";

describe("first setup free model choice", () => {
  it("accepts only a signed anonymous-free choice and checks the resulting native proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "setup-free-choice-"));
    const store = new InMemorySpaceStore();
    const app = Fastify();
    app.addHook("preHandler", async request => { request.user = { id: "user:owner", email: "owner@example.com", role: "ADMIN" }; });
    try {
      const handoffRoot = join(root, "handoff"); await mkdir(handoffRoot);
      const memory = "Verified free model: opencode/free\nAssistant status: completed a live account-free tool call before Docker setup.\n";
      const cost = { input: 0 as const, output: 0 as const, cache: { read: 0 as const, write: 0 as const } };
      const catalog = JSON.stringify({ schema: 1, benchmarkVersion: "tool-call:v1", checkedAt: new Date().toISOString(), models: [
        { id: "opencode/free", anonymousAvailable: true, setupPassed: 2, attempts: 2, successes: 2, latencyMs: 50, context: 100000, toolcall: true, text: true, cost },
        { id: "opencode/account-free", anonymousAvailable: false, setupPassed: 0, attempts: 1, successes: 0, latencyMs: 50, context: 100000, toolcall: true, text: true, cost }
      ] });
      const signed = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId: "opencode/free", completed: true,
        catalogSha256: createHash("sha256").update(catalog).digest("hex") };
      await writeFile(join(handoffRoot, "INSTALLATION_MEMORY.md"), memory);
      await writeFile(join(handoffRoot, "free-model-catalog.json"), catalog);
      await writeFile(join(handoffRoot, "installation-handoff.json"), JSON.stringify({ ...signed, mac: createHmac("sha256", secret).update(JSON.stringify(signed)).digest("hex") }));
      let wrongProof = false;
      const choices: string[] = [];
      let selectable = false;
      registerSetupExecutionRoutes(app, {
        freeModelSelectable: async () => selectable, store, memoryRoot: root, handoffRoot, installationSecret: secret, actionPumpEnabled: false,
        connections: { overview: async () => [], verify: async () => ({ functionalState: "FUNCTIONAL", liveVerificationState: "VERIFIED" }) } as unknown as SetupConnectionsService,
        selectFreeModel: async choice => { choices.push(choice); await writeFile(join(root, "installation-model.json"), JSON.stringify({
          id: choice === "auto" ? "opencode/big-pickle" : wrongProof ? "opencode/other" : choice, verification: "tool-call", verifiedAt: new Date().toISOString(), cost
        })); }
      });
      // Until the installed wrapper offers select-free-model, the choice is shown but cannot be applied.
      expect((await app.inject({ method: "GET", url: "/api/setup/free-models" })).json()).toMatchObject({ selectable: false });
      const unsupported = await app.inject({ method: "POST", url: "/api/setup/free-model", payload: { modelId: "opencode/free" } });
      expect(unsupported.statusCode).toBe(503);
      expect(unsupported.json()).toMatchObject({ error: { code: "SETUP_MODEL_UNAVAILABLE" } });
      selectable = true;
      const catalogResponse = await app.inject({ method: "GET", url: "/api/setup/free-models" });
      expect(catalogResponse.json().models).toHaveLength(2);
      expect(catalogResponse.json().selectable).toBe(true);
      for (const modelId of ["opencode/account-free", "opencode/paid", "opencode/free;whoami"]) {
        const rejected = await app.inject({ method: "POST", url: "/api/setup/free-model", payload: { modelId } });
        expect(rejected.statusCode).toBe(422);
      }
      const accepted = await app.inject({ method: "POST", url: "/api/setup/free-model", payload: { modelId: "opencode/free" } });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ modelId: "opencode/free", verified: true });
      // "Auto — best free" keeps no pick: the wrapper gets "auto" and whichever free model passes (Big Pickle first) is used.
      const auto = await app.inject({ method: "POST", url: "/api/setup/free-model", payload: { modelId: null } });
      expect(auto.json()).toMatchObject({ choice: "AUTO_BEST_FREE", modelId: "opencode/big-pickle", verified: true });
      expect(choices).toEqual(["opencode/free", "auto"]);
      wrongProof = true;
      const failed = await app.inject({ method: "POST", url: "/api/setup/free-model", payload: { modelId: "opencode/free" } });
      expect(failed.statusCode).toBe(422);
      expect(failed.json()).toMatchObject({ error: { code: "SETUP_MODEL_NOT_VERIFIED", message: expect.stringMatching(/^Needs attention: .*current model is unchanged/) } });
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
