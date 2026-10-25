import Fastify from "fastify";
import { expect, it } from "vitest";
import { authUserSchema, buildSetupSelection } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";

it("keeps an unsupported Harness discoverable with an explanation and excludes it from Full", async () => {
  const store = new InMemorySpaceStore();
  const app = Fastify();
  app.addHook("preHandler", async request => { request.user = authUserSchema.parse({ id: "user:owner", email: "owner@example.test", role: "ADMIN" }); });
  registerSetupExecutionRoutes(app, { store, connections: { overview: async () => [], verify: async () => { throw new Error("Not selected"); },
    verifyAll: async () => [], recordVerifiedEvidence: async () => { throw new Error("No task receipt"); } } });
  try {
    const result = await app.inject({ method: "GET", url: "/api/setup/catalog" });
    expect(result.statusCode).toBe(200);
    const features = result.json().features;
    expect(features.find((feature: { id: string }) => feature.id === "pane:harness"))
      .toMatchObject({ availability: "UNAVAILABLE", reasonCode: "HARNESS_SETUP_UNSUPPORTED" });
    expect(buildSetupSelection("developer", "full", Object.fromEntries(features.map((feature: { id: string; availability: string }) => [feature.id, feature.availability])), []).requestedIds)
      .not.toContain("pane:harness");
  } finally { await app.close(); }
});
