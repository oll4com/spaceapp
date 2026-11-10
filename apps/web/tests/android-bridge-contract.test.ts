/* @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOUS_FOCUS_EVENT } from "../src/features/nous-focus/nous-focus-events.js";

// SpaceApp Android 0.2.5 (plan clipboard:1cZ-YxU8zS2O, S1) injects these names into the page as literals (its src/lib/webview-guard.ts):
// renaming one here breaks the phone without a failing test. The SpaceNative methods are pinned by notifications.test.tsx,
// snip-capture.test.ts and agent-files-dock.test.tsx.
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("Android app bridge", () => {
  it("keeps the event names the app dispatches", () => {
    expect(NOUS_FOCUS_EVENT).toBe("space:nous-focus");
    for (const file of ["App.tsx", "features/terminal-pane/TerminalPane.tsx"]) {
      expect(source(file)).toContain('addEventListener("space:app-resumed"');
    }
    expect(source("features/notifications/desktop-notifications.ts")).toContain("__spaceOpenNotification = take");
  });
});
