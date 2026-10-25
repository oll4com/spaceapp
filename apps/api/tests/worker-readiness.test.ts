import { describe, expect, it } from "vitest";
import { createWorkerReadinessChecker } from "../src/worker-readiness.js";
import { getApiConfig } from "../src/config.js";

describe("worker readiness checker", () => {
  it("reports ERROR for an unreachable Temporal without throwing, and can be disposed", async () => {
    const config = getApiConfig({ SPACE_TEMPORAL_ADDRESS: "127.0.0.1:1" });
    const checker = createWorkerReadinessChecker(config);
    try {
      const first = await checker();
      expect(first.status).toBe("ERROR");
      expect(first.reachable).toBe(false);
      const second = await checker();
      expect(second.status).toBe("ERROR");
    } finally {
      await checker.dispose?.();
    }
  }, 20_000);
});
