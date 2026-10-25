import { describe, expect, it } from "vitest";
import { defaultToolRoutingState } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { routingStateWithLegacy } from "../src/tool-routing.js";

const storeWith = (assignments: Array<{ toolId: string; scope: "NONE" | "COMMON" | "SPECIFIC"; runtimeIds: string[] }>) =>
  ({ getToolRoutingState: () => defaultToolRoutingState(), listAgentToolAssignments: () => assignments }) as unknown as SpaceStore;

describe("legacy agent tool assignments in routing", () => {
  it("treats Autohand's mcpDispatcher like mcp_dispatcher: both select every dispatcher backend", async () => {
    for (const toolId of ["mcp:mcp_dispatcher", "mcp:mcpDispatcher"]) {
      const state = await routingStateWithLegacy(storeWith([{ toolId, scope: "NONE", runtimeIds: [] }]));
      expect(state.overrides).toEqual([{ toolId: "mcp:*", modelId: "*", runtimeId: "*", mode: "DISABLED" }]);
    }
  });
});
