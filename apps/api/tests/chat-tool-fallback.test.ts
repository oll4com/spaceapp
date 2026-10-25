import { describe, expect, it, vi } from "vitest";
import { createDecisionsService } from "../src/decisions-service.js";

describe("Chat tool fallback without a classifier", () => {
  it.each(["Ψάξε τρεις προμηθευτές και σύγκρινε τιμές", "βρες μου πλιροφοριες για αυτο", "κάνε research και φτιάξε πίνακα", "Find the cheapest flight to Athens"])("preserves the selected authorized surface for %s", async prompt => {
    const fetch = vi.fn(); const readFileImpl = vi.fn(async () => "");
    const service = createDecisionsService({ enabled: false, fetch, readFileImpl });
    const selected = ["browser:navigate", "mcp:playwright:screenshot", "memory:search"];
    const result = await service.evaluateToolSurface(prompt, selected);
    expect(result).toMatchObject({ available: false, needsBrowser: true, filteredTools: selected, degraded: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileImpl).not.toHaveBeenCalled();
  });
  it("drops browser tools for a request that needs no browsing (9a933cd0cb)", async () => {
    const service = createDecisionsService({ enabled: false });
    const result = await service.evaluateToolSurface("What is 2 + 2?", ["browser:navigate", "mcp:playwright:screenshot", "memory:search"]);
    expect(result).toMatchObject({ available: false, needsBrowser: false, filteredTools: ["memory:search"], degraded: true });
  });
  it("does not add unselected browser tools", async () => {
    const service = createDecisionsService({ enabled: false });
    expect((await service.evaluateToolSurface("Κάνε έρευνα", ["memory:search"])).filteredTools).toEqual(["memory:search"]);
  });
});
