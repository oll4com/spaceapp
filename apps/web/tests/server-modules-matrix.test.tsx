import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Checked against the API's optionalModuleIds by domain-boundaries-current.test.mjs.
export const WEB_OPTIONAL_MODULE_IDS = [
  "games", "job-copilot", "mail-copilot", "marketing-copilot", "freelance-copilot", "design", "app-studio", "video",
  "security-copilot", "monitoring-copilot", "mail-campaigns", "channels", "telegram", "waitlist", "desktop-updates"
] as const;

const PANE_ENTRIES = [
  ["job-copilot", "add-jobs"], ["mail-copilot", "add-mail"], ["marketing-copilot", "add-marketing"],
  ["freelance-copilot", "add-freelance"], ["design", "add-design"], ["app-studio", "add-app-studio"],
  ["video", "add-video"], ["security-copilot", "add-security"], ["monitoring-copilot", "add-monitoring"]
] as const;

const playableRoom = {
  selectedRoomId: "room:matrix", displayedRoomId: "room:matrix", preparingRoomId: null, loaded: true, category: null,
  panes: [{ roomId: "room:matrix", isMinimized: true }]
};

describe("server optional modules: disabled-module matrix (ARCH-003 part A)", () => {
  let visibility: typeof import("../src/features/pane-visibility/use-panes-visibility.js");
  let modules: typeof import("../src/features/pane-visibility/server-modules.js");
  let games: typeof import("../src/features/asteroids/eligibility.js");

  beforeEach(async () => {
    // The module list is intentionally retained for a page's lifetime. Each case
    // starts a fresh page so the older-server case really has an unknown list.
    vi.resetModules();
    window.sessionStorage.clear();
    visibility = await import("../src/features/pane-visibility/use-panes-visibility.js");
    modules = await import("../src/features/pane-visibility/server-modules.js");
    games = await import("../src/features/asteroids/eligibility.js");
  });
  afterEach(() => cleanup());

  function hiddenEntries(isHidden: (id: string) => boolean) {
    return visibility.NON_CLI_PANE_DEFINITIONS.filter((pane) => isHidden(pane.actionId)).map((pane) => pane.actionId).sort();
  }

  it.each(WEB_OPTIONAL_MODULE_IDS)("turning off only %s hides only its own add entry and game", (disabled) => {
    const { result } = renderHook(() => visibility.usePanesVisibility(window.sessionStorage));
    expect(hiddenEntries(result.current.isPaneHidden)).toEqual([]);
    act(() => { modules.noteServerModules({ optionalModules: WEB_OPTIONAL_MODULE_IDS.filter((id) => id !== disabled) }); });
    const entry = PANE_ENTRIES.find(([id]) => id === disabled);
    expect(hiddenEntries(result.current.isPaneHidden)).toEqual(entry ? [entry[1]] : []);
    for (const id of WEB_OPTIONAL_MODULE_IDS) expect(modules.serverModuleOn(id), id).toBe(id !== disabled);
    expect(games.canPlayAsteroids(playableRoom)).toBe(disabled !== "games");
  });

  it("with all modules off hides the nine add entries and disallows games", () => {
    const { result } = renderHook(() => visibility.usePanesVisibility(window.sessionStorage));
    act(() => { modules.noteServerModules({ optionalModules: [] }); });
    expect(hiddenEntries(result.current.isPaneHidden)).toEqual(PANE_ENTRIES.map(([, entry]) => entry).sort());
    for (const id of WEB_OPTIONAL_MODULE_IDS) expect(modules.serverModuleOn(id), id).toBe(false);
    expect(games.canPlayAsteroids(playableRoom)).toBe(false);
  });

  it("a fresh payload without a module list keeps all entries and games available", () => {
    modules.noteServerModules({ isAuthenticated: true });
    const { result } = renderHook(() => visibility.usePanesVisibility(window.sessionStorage));
    expect(hiddenEntries(result.current.isPaneHidden)).toEqual([]);
    for (const id of WEB_OPTIONAL_MODULE_IDS) expect(modules.serverModuleOn(id), id).toBe(true);
    expect(games.canPlayAsteroids(playableRoom)).toBe(true);
  });
});
