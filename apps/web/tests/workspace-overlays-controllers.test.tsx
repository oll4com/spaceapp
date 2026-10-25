import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";

const api = vi.hoisted(() => ({
  cliVpnRoutingStatus: vi.fn(),
  cliRuntimeSettings: vi.fn(),
  rotateCliNordCity: vi.fn(),
  rotateCliMullvadCity: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api }));
const refreshCliVpnRoutingStatus = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/cli-vpn-routing.js", () => ({ CLI_VPN_ROUTING_STATUS_EVENT: "space:cli-vpn-routing-status", refreshCliVpnRoutingStatus }));

import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { useToolbarVpn } from "../src/features/toolbar-vpn/useToolbarVpn.js";
import { useAppNotices } from "../src/features/app-notices/useAppNotices.js";
import { AppNoticeBanners, LiveDebugToastView } from "../src/features/app-notices/AppNoticeBanners.js";
import { LiveRailButton, LiveRailMenu, useLiveRail } from "../src/features/live-pane/useLiveRail.js";
import { useSnipTool } from "../src/features/snip-tool/useSnipTool.js";
import { useBrowserFullscreen } from "../src/features/desktop-titlebar/useBrowserFullscreen.js";
import { SPACE_CLIPBOARD_NOTICE_EVENT } from "../src/features/clipboard-dock/clipboard-events.js";

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("useToolbarVpn", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    refreshCliVpnRoutingStatus.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reads the route and runtime settings once signed in and on each routing event", async () => {
    api.cliVpnRoutingStatus.mockResolvedValue({ selectedRoute: "nord" });
    api.cliRuntimeSettings.mockResolvedValue({ settings: [] });
    const onRuntimeSettings = vi.fn();
    const { result, rerender } = renderHook(({ authenticated }: { authenticated: boolean | undefined }) =>
      useToolbarVpn({ isAuthenticated: authenticated, onRuntimeSettings }), { initialProps: { authenticated: undefined as boolean | undefined } });
    expect(api.cliVpnRoutingStatus).not.toHaveBeenCalled();
    rerender({ authenticated: true });
    await flush();
    expect(result.current.toolbarVpnRoute).toBe("nord");
    expect(onRuntimeSettings).toHaveBeenCalledWith({ settings: [] });
    act(() => { window.dispatchEvent(new Event("space:cli-vpn-routing-status")); });
    await flush();
    expect(api.cliVpnRoutingStatus).toHaveBeenCalledTimes(2);
    rerender({ authenticated: false });
    expect(result.current.toolbarVpnRoute).toBeNull();
  });

  it("polls the routing status every 20 seconds while signed in", () => {
    vi.useFakeTimers();
    api.cliVpnRoutingStatus.mockResolvedValue({ selectedRoute: null });
    api.cliRuntimeSettings.mockResolvedValue({ settings: [] });
    renderHook(() => useToolbarVpn({ isAuthenticated: true, onRuntimeSettings: vi.fn() }));
    act(() => { vi.advanceTimersByTime(40_000); });
    expect(refreshCliVpnRoutingStatus).toHaveBeenCalledTimes(2);
  });

  it("rotates the city of the selected provider and reports the result", async () => {
    api.cliVpnRoutingStatus.mockResolvedValue({ selectedRoute: "mullvad" });
    api.cliRuntimeSettings.mockResolvedValue({ settings: [] });
    api.rotateCliMullvadCity.mockResolvedValueOnce({ relay: { cityName: "Athens", countryName: "Greece" }, egressIpv4: "203.0.113.5" });
    const { result } = renderHook(() => useToolbarVpn({ isAuthenticated: true, onRuntimeSettings: vi.fn() }));
    await flush();
    await act(async () => { await result.current.rotateVpnCityFromToolbar(); });
    expect(result.current.vpnCityNotice).toBe("Mullvad changed to Athens, Greece (203.0.113.5).");
    api.rotateCliMullvadCity.mockRejectedValueOnce(new Error("down"));
    await act(async () => { await result.current.rotateVpnCityFromToolbar(); });
    expect(result.current.vpnCityNotice).toBe("Mullvad city could not be changed.");
    expect(result.current.vpnCityPending).toBe(false);
  });
});

describe("useAppNotices", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reports a Google account link from the URL and removes the query", () => {
    window.history.replaceState({}, "", "/?googleLinked=true");
    const { result } = renderHook(() => useAppNotices());
    expect(result.current.accountNotice).toContain("Google account linked.");
    expect(window.location.search).toBe("");
    cleanup();
    window.history.replaceState({}, "", "/?googleLinkError=Access%20denied");
    const second = renderHook(() => useAppNotices());
    expect(second.result.current.accountError).toBe("Access denied");
  });

  it("collects watchdog alerts once per id and dismisses them", () => {
    const { result } = renderHook(() => useAppNotices());
    act(() => {
      window.dispatchEvent(new CustomEvent("space:room-watchdog-alert", { detail: { id: "a", message: "Room stalled", timestamp: "t1" } }));
      window.dispatchEvent(new CustomEvent("space:room-watchdog-alert", { detail: { id: "a", message: "Room stalled", timestamp: "t2" } }));
      result.current.addWatchdogAlert({ id: "b", message: "Pane stuck", timestamp: "t3" });
      result.current.addWatchdogAlert({ id: "b", message: "Pane stuck", timestamp: "t4" });
    });
    expect(result.current.watchdogAlerts).toEqual([
      { id: "a", message: "Room stalled", timestamp: "t1" },
      { id: "b", message: "Pane stuck", timestamp: "t3" }
    ]);
    act(() => result.current.dismissWatchdogAlert("a"));
    expect(result.current.watchdogAlerts.map((alert) => alert.id)).toEqual(["b"]);
    // A repeated message replaces its banner instead of stacking another one.
    act(() => result.current.addWatchdogAlert({ id: "c", message: "Pane stuck", timestamp: "t5" }));
    expect(result.current.watchdogAlerts).toEqual([{ id: "c", message: "Pane stuck", timestamp: "t5" }]);
  });

  it("shows clipboard notices for five seconds and the Live debug toast for 4.5 seconds", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = renderHook(() => useAppNotices());
    act(() => {
      window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, { detail: { message: "Copied" } }));
      window.dispatchEvent(new CustomEvent("space-live-debug", { detail: { message: "Live failed", type: "error" } }));
    });
    expect(result.current.clipboardNotice).toBe("Copied");
    expect(result.current.liveDebugToast).toMatchObject({ message: "Live failed", type: "error" });
    expect(log).toHaveBeenCalledWith("[AI-Live-Debug][ERROR] Live failed");
    act(() => { vi.advanceTimersByTime(4_500); });
    expect(result.current.liveDebugToast).toBeNull();
    act(() => { result.current.showLiveDebug("AI Live button tapped...", "info"); });
    expect(log).toHaveBeenCalledWith("[AI-Live-Debug][INFO] AI Live button tapped...");
    expect(result.current.liveDebugToast).toBeNull();
    expect(result.current.liveDebugToast).toBeNull();
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.clipboardNotice).toBeNull();
    log.mockRestore();
  });

  it("keeps a dismissed storage warning dismissed for the tab until the server clears it", () => {
    const { result } = renderHook(() => useAppNotices());
    act(() => result.current.applyStorageWarning("Disk almost full"));
    act(() => result.current.dismissStorageWarning());
    expect(result.current.dismissedStorageWarning).toBe("Disk almost full");
    expect(window.sessionStorage.getItem("space.dismissedStorageWarning")).toBe("Disk almost full");
    act(() => result.current.applyStorageWarning(""));
    expect(result.current.dismissedStorageWarning).toBeNull();
    expect(window.sessionStorage.getItem("space.dismissedStorageWarning")).toBeNull();
  });

  it("renders the banners in order and hides focus-mode-sensitive notices", () => {
    function Banners({ focus }: { focus: boolean }) {
      const notices = useAppNotices();
      return (
        <>
          <button type="button" onClick={() => {
            notices.applyStorageWarning("Disk almost full");
            notices.setClipToolNotice("Clip saved");
            notices.setClipboardNotice("Copied");
            notices.setAccountError("Link failed");
            notices.addWatchdogAlert({ id: "w", message: "Room stalled", timestamp: "t" });
          }}>fill</button>
          <AppNoticeBanners notices={notices} actionError={null} onDismissActionError={() => undefined}
            vpnCityNotice="NordVPN changed" vpnCityNoticeRef={{ current: null }} onDismissVpnCityNotice={() => undefined}
            isRoomFocusMode={focus} isDemoRuntime={false} />
          <LiveDebugToastView notices={notices} />
        </>
      );
    }
    const { container, rerender } = render(<Banners focus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "fill" }));
    expect(Array.from(container.querySelectorAll(".banner")).map((banner) => banner.textContent)).toEqual([
      "Room stalled", "Disk almost full", "Clip saved", "NordVPN changed", "Copied", "Link failed"
    ]);
    rerender(<Banners focus />);
    expect(Array.from(container.querySelectorAll(".banner")).map((banner) => banner.textContent)).toEqual([
      "Room stalled", "Clip saved", "NordVPN changed", "Link failed"
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss watchdog alert" }));
    expect(container.querySelectorAll(".banner.bad")).toHaveLength(0);
  }, 30_000);
});

describe("useLiveRail", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it("mirrors the shared Live status and a Live pane of the room", () => {
    const panes = [{ id: "pane:live", mode: "LIVE" } as Pane, { id: "pane:cli", mode: "TERMINAL" } as Pane];
    const { result } = renderHook(() => useLiveRail(panes));
    act(() => { window.dispatchEvent(new CustomEvent("space-live-pane-status", { detail: { rail: true, status: "listening" } })); });
    expect(result.current.liveRailStatus).toBe("listening");
    act(() => { window.dispatchEvent(new CustomEvent("space-live-pane-status", { detail: { paneId: "pane:cli", status: "error" } })); });
    expect(result.current.liveRailStatus).toBe("listening");
    act(() => { window.dispatchEvent(new CustomEvent("space-live-pane-status", { detail: { paneId: "pane:live", status: "speaking" } })); });
    expect(result.current.liveRailStatus).toBe("speaking");
  });

  it("persists the graphic choice from the menu event", () => {
    const { result } = renderHook(() => useLiveRail([]));
    act(() => { window.dispatchEvent(new Event("space-live-rail-graphic-toggle")); });
    expect(result.current.isLiveRailGraphicDisabled).toBe(true);
    expect(window.localStorage.getItem("space.liveRail.graphicDisabled.v1")).toBe("true");
  });

  it("renders the rail button and toggles its context menu", () => {
    const onActivate = vi.fn();
    function Rail() {
      const liveRail = useLiveRail([]);
      return <><LiveRailButton liveRail={liveRail} onActivate={onActivate} disabled={false} /><LiveRailMenu liveRail={liveRail} /></>;
    }
    const { container } = render(<Rail />);
    const button = screen.getByRole("button", { name: "Start Live voice conversation" });
    expect(button.getAttribute("data-live-status")).toBe("idle");
    expect(container.querySelector(".live-orb")).not.toBeNull();
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(button, { clientX: 10, clientY: 20 });
    expect(container.querySelectorAll(".room-live-rail-button")).toHaveLength(1);
    expect(screen.getByRole("menu").className).toBe("live-rail-context-menu");
  });
});

describe("useSnipTool", () => {
  afterEach(() => cleanup());

  it("marks the body while open and opens in capture mode on PrintScreen", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { result } = renderHook(() => useSnipTool());
    expect(document.body.hasAttribute("data-snip-tool-active")).toBe(false);
    act(() => { window.dispatchEvent(new KeyboardEvent("keyup", { key: "PrintScreen" })); });
    expect(result.current.isSnipToolOpen).toBe(true);
    expect(result.current.snipToolInitialModeRef.current).toBe("capturing");
    expect(document.body.getAttribute("data-snip-tool-active")).toBe("true");
    act(() => result.current.setIsSnipToolOpen(false));
    expect(result.current.snipToolInitialModeRef.current).toBe("float");
    expect(document.body.hasAttribute("data-snip-tool-active")).toBe(false);
    log.mockRestore();
  });
});

describe("useBrowserFullscreen", () => {
  afterEach(() => cleanup());

  it("follows fullscreen changes", () => {
    const { result } = renderHook(() => useBrowserFullscreen());
    expect(result.current).toBe(false);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current).toBe(true);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current).toBe(false);
  });
});
