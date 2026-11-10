import { paneModeSchema } from "@space/contracts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UI_PARITY_ACTIONS,
  UI_PARITY_MANIFEST_VERSION,
  UI_PARITY_PANE_MODES,
  UI_PARITY_REACHABLE_STATES,
  UI_PARITY_VIEWPORTS
} from "../src/parity/ui-parity-manifest.js";

describe("Space UI parity manifest", () => {
  it("maps every canonical action to both live and demo runtimes without duplicate ids", () => {
    expect(UI_PARITY_MANIFEST_VERSION).toBe("space-ui-parity-v1");
    expect(new Set(UI_PARITY_ACTIONS.map((action) => action.id)).size).toBe(UI_PARITY_ACTIONS.length);
    expect(UI_PARITY_ACTIONS.every((action) => action.runtimes.join(",") === "live,demo")).toBe(true);
    expect(new Set(UI_PARITY_ACTIONS.map((action) => action.surface))).toEqual(new Set([
      "auth", "rooms", "toolbar", "pane", "chat", "cli", "browser", "youtube", "vnc", "review", "code", "swarm",
      "design", "media", "streaming", "clipboard", "tasks", "links", "settings", "health", "memory", "quick-links", "help",
      "music", "admin", "responsive"
    ]));
  });

  it("maps every reachable action to concrete interaction tests", () => {
    for (const action of UI_PARITY_ACTIONS) {
      expect(action.exercisedBy.length, `${action.id} has no interaction evidence`).toBeGreaterThan(0);
      for (const testFile of action.exercisedBy) {
        expect(testFile, `${action.id} must use a workspace-relative test path`).toMatch(/^tests\/[A-Za-z0-9._/-]+\.test\.[jt]sx?$/);
        expect(existsSync(resolve(testFile)), `${action.id} references missing ${testFile}`).toBe(true);
      }
    }
  });

  it("covers every production pane mode, canonical viewport and reachable state", () => {
    expect([...UI_PARITY_PANE_MODES].sort()).toEqual([...paneModeSchema.options].sort());
    expect(UI_PARITY_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`)).toEqual([
      "1365x900", "1280x800", "834x1112", "390x844"
    ]);
    expect(UI_PARITY_REACHABLE_STATES).toEqual(expect.arrayContaining([
      "loading", "empty", "ready", "disabled", "error", "authenticated", "unauthenticated",
      "idle", "running", "stopped", "completed", "maximized", "minimized", "mobile-drawer"
    ]));
  });

  it("keeps live and demo on the exact same Space App view", () => {
    const live = readFileSync("src/live/LiveSpaceApp.tsx", "utf8");
    const demo = readFileSync("src/demo/DemoSpaceApp.tsx", "utf8");

    expect(live).toContain('import { App } from "../App.js"');
    expect(demo).toContain('import { App } from "../App.js"');
    expect(live).toContain("<App />");
    expect(demo).toContain("<App />");
  });
});
