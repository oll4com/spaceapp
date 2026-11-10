import { describe, expect, it, vi } from "vitest";
import { cliRouteSteps } from "../src/pane-cli-routes.js";

// 4/11: GET cli/session took 4 s on stable and no log line named the step; a slow CLI route now logs its steps.
describe("cli route steps", () => {
  it("logs each step's time since the request began only when the route took 1 s or more", () => {
    let clock = 0;
    const log = { info: vi.fn() };
    const step = cliRouteSteps({ log } as never, "GET /api/panes/:id/cli/session", () => clock);
    clock = 12; step.mark("pane");
    clock = 3_980; step.mark("host");
    clock = 4_010; step.log("cli:claude");
    expect(log.info).toHaveBeenCalledWith({ event: "cli_route.steps", route: "GET /api/panes/:id/cli/session", runtimeId: "cli:claude",
      totalMs: 4_010, steps: { pane: 12, host: 3_980 } }, "Slow CLI route steps");
    const fast = cliRouteSteps({ log } as never, "GET /api/panes/:id/cli/session", () => clock);
    clock += 999; fast.log("cli:claude");
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
