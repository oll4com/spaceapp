import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { noteServerModules, serverModuleOn } from "../src/features/pane-visibility/server-modules.js";
import { usePanesVisibility } from "../src/features/pane-visibility/use-panes-visibility.js";
import { canPlayAsteroids } from "../src/features/asteroids/eligibility.js";

// Review F14: panes and games of optional modules the server has off are hidden.
describe("server optional modules", () => {
  it("hides copilot panes and the games once the server reports its modules", () => {
    const { result } = renderHook(() => usePanesVisibility(window.sessionStorage));
    expect(result.current.isPaneHidden("add-jobs")).toBe(false);
    act(() => { noteServerModules({ optionalModules: ["mail-copilot"] }); });
    expect(result.current.isPaneHidden("add-jobs")).toBe(true);
    expect(result.current.isPaneHidden("add-marketing")).toBe(true);
    expect(result.current.isPaneHidden("add-mail")).toBe(false);
    expect(result.current.isPaneHidden("add-chat")).toBe(false);
    expect(serverModuleOn("games")).toBe(false);
    expect(canPlayAsteroids({ selectedRoomId: "room:a", displayedRoomId: "room:a", preparingRoomId: null, loaded: true, category: null,
      panes: [{ roomId: "room:a", isMinimized: true }] })).toBe(false);
    // A payload without the list (older server) changes nothing.
    act(() => { noteServerModules({ isAuthenticated: true }); });
    expect(result.current.isPaneHidden("add-mail")).toBe(false);
  });
});
