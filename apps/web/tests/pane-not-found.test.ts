import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PANE_NOT_FOUND_EVENT, reportMissingPane } from "../src/pane-not-found.js";

describe("reportMissingPane", () => {
  it("announces a pane the server no longer has, and nothing else", () => {
    const heard = vi.fn();
    window.addEventListener(PANE_NOT_FOUND_EVENT, heard);
    reportMissingPane("/api/panes/pane%3AokSfB-RY5haM/working-time", 404, "NOT_FOUND: Pane pane:okSfB-RY5haM was not found.");
    reportMissingPane("/api/panes/pane%3Aa/browser/session", 404, "No browser session for this pane.");
    reportMissingPane("/api/panes/pane%3Ab/cli/session", 503, "Pane pane:b was not found.");
    reportMissingPane("/api/rooms/room%3Ax/panes", 404, "Pane pane:c was not found.");
    window.removeEventListener(PANE_NOT_FOUND_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect((heard.mock.calls[0]![0] as CustomEvent).detail).toEqual({ paneId: "pane:okSfB-RY5haM" });
  });

  it("keeps a gone room and a timed-out CLI session request from rejecting unhandled", () => {
    const app = readFileSync(resolve(__dirname, "../src/App.tsx"), "utf8");
    const terminal = readFileSync(resolve(__dirname, "../src/features/terminal-pane/TerminalPane.tsx"), "utf8");
    expect(app).toMatch(/if \(!isRoomNotFoundError\(error, roomId\)\) throw error;[\s\S]*?void requestRoomCatalogRefreshRef\.current\(\)\.catch\(\(\) => undefined\);\s*\} finally/);
    expect(terminal).toMatch(/runSessionRequest\(async \(\) => \{[\s\S]*?\}\)\.catch\(\(err: unknown\) => \{[^}]*return null;/);
  });
});
