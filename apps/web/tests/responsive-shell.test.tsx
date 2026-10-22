import { workspaceAction as currentWorkspaceAction } from "./workspace-navigation.js";
import { demoHealthSnapshot } from "../src/demo/demo-health.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, configure, createEvent, fireEvent, getConfig, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cliToggleRuntimeIds, type AgentPaneSession, type AgentRuntime, type CliVpnRoutingStatus, type Pane, type PaneCliSessionResponse, type Room } from "@space/contracts";
import {
  createCoalescedRefreshQueue,
  formatTerminalSessionClipboardText,
  formatTerminalSessionDebugInfo,
  paneHeaderNeedsSecondRow,
  roomRefreshCategoriesForEvent,
  roomToolbarNeedsSecondRow,
  shellVisiblePaneIds,
  shouldOpenAppEventStreams,
  shouldUseEventStreamFallback
} from "../src/App.js";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { CODE_RADIO_METADATA_URL, CODE_RADIO_PRIMARY_STREAM_URL } from "../src/features/vibe-music/VibeMusicPlayer.js";
import { readLifecycleDebugSnapshot } from "../src/lifecycle-debug.js";
import { publishCliVpnRoutingStatus, resetCliVpnRoutingStatusForTests } from "../src/cli-vpn-routing.js";
import { api as liveApi } from "../src/live-api.js";

import { __dirname, paginated, isRoomCatalogRequest, userLinks, cliRuntime, cliRuntimeRegistry, roomPayload, pane, reviewPanes, terminalPanes, chatPanes, agentSession, setViewport, openDesktopMenu, workspaceAction, openSettingsSection, openCliDockSection, setWarmRoomTelemetry, deferred, installFetchFixture, showMinimizedBar } from "./responsive-shell-fixture.js";

// Each test renders the full live App shell in jsdom, where role queries recompute styles for
// every candidate element. Several flows open many docks and menus and need well over the 5 s
// default when the suite runs alongside other work. A test that times out keeps running in the
// background and clicks through the next test's DOM, so a tight timeout also cascades failures.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Workspace dock entries open inline pages inside the Workspace menu (4d2bc9d1a4), so
 * an open dock drawer or inline dock switches docks with its own Next dock control.
 */
function showDock(label: string): HTMLElement {
  for (let step = 0; step < 20; step += 1) {
    const surface = document.querySelector<HTMLElement>(".side-surface-drawer, .side-surface-inline:not([aria-hidden])");
    if (!surface) throw new Error(`No dock is open while looking for ${label}`);
    if (surface.getAttribute("aria-label") === label) return surface;
    // Query the dock header controls only: kept-alive dock bodies make a whole-surface role
    // query cost hundreds of milliseconds per step in jsdom.
    const controls = surface.querySelector<HTMLElement>(".dock-nav-controls") ?? surface;
    fireEvent.click(within(controls).getByRole("button", { name: "Next dock" }));
  }
  throw new Error(`Dock ${label} is not reachable with Next dock`);
}

/**
 * The live API caches the Codex environment for 15 s across renders (321b32d43b). Tests that need
 * a specific Codex state load their fixture's environment, and Codex Off tests hand an enabled
 * environment back so later tests in this file do not inherit the Off state.
 */
async function loadFixtureCodexEnvironment({ restoreEnabled = false } = {}) {
  await liveApi.codexEnvironment(true);
  if (!restoreEnabled) return;
  onTestFinished(async () => {
    installFetchFixture({});
    await liveApi.codexEnvironment(true);
    vi.unstubAllGlobals();
  });
}

/** Stylesheet rules (comments stripped) with at least one top-level selector matching `selector`. */
function cssRulesFor(css: string, selector: RegExp) {
  const topLevelSelectors = (list: string) => {
    const selectors: string[] = [];
    let depth = 0;
    let current = "";
    for (const character of list) {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (character === "," && depth === 0) {
        selectors.push(current.trim());
        current = "";
      } else {
        current += character;
      }
    }
    selectors.push(current.trim());
    return selectors;
  };
  return Array.from(css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
    selectors: topLevelSelectors(match[1]!.trim().replace(/\s+/g, " ")),
    declarations: match[2]!
  })).filter((rule) => rule.selectors.some((item) => selector.test(item)));
}

/** Admin server actions moved into the grouped Manage page of the Workspace menu (ecc0af72fb). */
async function openManageSection(section: "Maintenance" | "Connections" | "Services" | "Administration") {
  let manage = screen.queryByRole("dialog", { name: "Manage" });
  if (!manage) {
    const nav = await screen.findByRole("navigation", { name: "Workspace navigation" });
    const mode = within(nav).queryByRole("button", { name: "Admin mode" });
    if (mode?.getAttribute("aria-pressed") === "false") fireEvent.click(mode);
    fireEvent.click(await workspaceAction("Manage"));
    manage = await screen.findByRole("dialog", { name: "Manage" });
  }
  const allSections = within(manage).queryByRole("button", { name: "← All sections" });
  if (allSections) fireEvent.click(allSections);
  fireEvent.click(within(manage).getByRole("button", { name: section }));
  return manage;
}

/**
 * The Workspace "Clip Tool" entry opens the Snip Tool page (4d2bc9d1a4); the direct Clip
 * Tool capture remains on the lower rail's Workspace tools menu.
 */
async function railToolAction(name: string) {
  if (!document.querySelector(".room-toolbar-collapsed")) {
    fireEvent.click(await screen.findByRole("button", { name: "Hide room toolbar" }));
  }
  const trigger = await screen.findByRole("button", { name: "Workspace tools" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  const menu = await screen.findByRole("dialog", { name: "Workspace tools" });
  return within(menu).getByRole("button", { name });
}

describe("Space responsive shell", () => {
  it("searches rooms and preserves activity badges without changing the selected room or mounted panes", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    installFetchFixture({
      rooms: [{ id: "room:alpha", name: "Alpha", order: 0 }, { id: "room:beta", name: "Beta", order: 1 }],
      panesByRoom: {
        "room:alpha": [{ ...pane({ id: "pane:alpha:error", roomId: "room:alpha", order: 0, title: "Needs review" }), status: "ERROR" }],
        "room:beta": reviewPanes("room:beta", 1)
      },
      cliCountsByRoom: { "room:alpha": 0, "room:beta": 2 }
    });
    const { container } = render(<App />);
    const mountedPane = await screen.findByLabelText("Needs review agent 1");
    const search = screen.getByRole("searchbox", { name: "Find a room" });
    fireEvent.change(search, { target: { value: "  BETA  " } });
    const beta = screen.getByRole("button", { name: "Open Beta" });
    // Room cards count open panes instead of running CLIs since 7929588575.
    await waitFor(() => expect(beta.querySelector(".room-cli-badge")?.textContent).toBe("Panes 1"));
    expect(screen.queryByRole("button", { name: "Open Alpha" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    // The Running / Needs attention filter group was replaced by account filters (4399759d7d);
    // room attention stays visible on the room card itself.
    expect(screen.queryByRole("group", { name: "Filter rooms" })).toBeNull();
    await waitFor(() => expect(within(screen.getByRole("button", { name: "Open Alpha" })).getByText("Needs attention")).toBeTruthy());
    expect(within(screen.getByRole("button", { name: "Open Beta" })).queryByText("Needs attention")).toBeNull();
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(screen.getByRole("button", { name: "Open Alpha" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Beta" })).toBeNull();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No rooms match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Open Alpha" }).getAttribute("aria-current")).toBe("true");
    expect(container.querySelector('.space-shell')?.getAttribute('data-room-id')).toBe("room:alpha");
    expect(screen.getByLabelText("Needs review agent 1")).toBe(mountedPane);
  });

  it("moves between rooms with a horizontal swipe on the phone room title", async () => {
    window.sessionStorage.clear();
    setViewport(390, 844);
    installFetchFixture({
      rooms: [{ id: "room:alpha", name: "Alpha", order: 0 }, { id: "room:beta", name: "Beta", order: 1 }],
      panesByRoom: { "room:alpha": reviewPanes("room:alpha", 1), "room:beta": reviewPanes("room:beta", 1) }
    });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));
    const title = () => container.querySelector<HTMLElement>(".board-title-heading h2")!;
    await waitFor(() => expect(title()?.textContent).toBe("Alpha"));
    fireEvent.touchStart(title(), { touches: [{ clientX: 200, clientY: 30 }] });
    fireEvent.touchEnd(title(), { changedTouches: [{ clientX: 100, clientY: 32 }] });
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));
    // A mostly vertical drag is not a swipe.
    fireEvent.touchStart(title(), { touches: [{ clientX: 100, clientY: 30 }] });
    fireEvent.touchEnd(title(), { changedTouches: [{ clientX: 150, clientY: 130 }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta");
    fireEvent.touchStart(title(), { touches: [{ clientX: 100, clientY: 30 }] });
    fireEvent.touchEnd(title(), { changedTouches: [{ clientX: 200, clientY: 30 }] });
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));
  });

  it("gives the phone room toolbar 44 px buttons by leaving the brand and Admin switch out of the row", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    expect(css).toMatch(/\[data-shell-mode="mobile"\] \.board-toolbar :is\(\.desktop-rooms-toggle, \.desktop-navigation > button, \.toolbar-actions-fixed > button\) \{[^}]*width: 44px;[^}]*height: 44px;/);
    expect(css).toContain('.space-shell[data-shell-mode="mobile"] .board-toolbar :is(.space-brand-control, .desktop-mode-switch) { display: none; }');
    expect(css).not.toMatch(/\[data-shell-mode="mobile"\] \.board-toolbar[^{]*\{[^}]*width: 32px;/);
  });

  it("switches mobile panes from the bottom pane bar and by title swipe", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: reviewPanes("room:responsive", 4) });
    const view = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    expect(screen.queryByRole("button", { name: "Pane layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next pane" })).toBeNull();
    expect(view.container.querySelector('.pane-fullscreen-nav')).toBeNull();
    const bar = screen.getByRole("navigation", { name: "Room panes" });
    const chips = within(bar).getAllByRole("button");
    expect(chips).toHaveLength(4);
    expect(chips[0]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(chips[2]!);
    await waitFor(() => expect(screen.getByLabelText("Review 3 agent 3").getAttribute("data-shell-visible")).toBe("true"));
    expect(within(bar).getAllByRole("button")[2]!.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(bar).getAllByRole("button")[0]!);
    await waitFor(() => expect(screen.getByLabelText("Review 1 agent 1").getAttribute("data-shell-visible")).toBe("true"));
    let title = view.container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(title!, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 200, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("Review 4 agent 4").getAttribute("data-shell-visible")).toBe("true"));
    title = view.container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(title!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("Review 1 agent 1").getAttribute("data-shell-visible")).toBe("true"));
    view.unmount();
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    expect(screen.queryByRole("navigation", { name: "Room panes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next pane" })).toBeNull();
  });
  it.each([
    ["cli:codex", "Codex CLI"],
    ["cli:claude", "Claude Code CLI"],
    ["cli:gemini", "Gemini CLI"],
    ["cli:opencode", "OpenCode CLI"],
    ["cli:autohand", "Autohand Code CLI"],
    ["cli:qwen", "Qwen Code CLI"],
    ["cli:kimi", "Kimi Code CLI"],
    ["cli:grok", "Grok Build CLI"]
  ])("includes the %s runtime type in terminal session debug text", (runtimeId, runtimeLabel) => {
    expect(formatTerminalSessionDebugInfo({
      sessionId: "cli_session:renamed-pane",
      codexThreadId: null,
      runtimeId,
      purpose: "NORMAL"
    })?.title).toBe(`${runtimeLabel} session cli_session:renamed-pane`);
  });

  it("formats terminal clipboard text from session metadata instead of the pane title", () => {
    expect(formatTerminalSessionClipboardText({
      sessionId: "cli_session:copy-me",
      codexThreadId: "019f-copy-thread",
      runtimeId: "cli:codex",
      purpose: "NORMAL"
    })).toBe([
      "CLI session ID: cli_session:copy-me",
      "Codex thread ID: 019f-copy-thread"
    ].join("\n"));
  });

  // Chat panes, the CLI dock, Memory workspace, on-screen keyboard and other surfaces are lazy
  // chunks. Their first import in a test run can take longer than Testing Library's 1 s default
  // find/waitFor window, so whichever test opens a surface first would fail on load time alone.
  let previousAsyncUtilTimeout: number;
  beforeAll(() => {
    previousAsyncUtilTimeout = getConfig().asyncUtilTimeout;
    configure({ asyncUtilTimeout: 15_000 });
  });
  afterAll(() => {
    configure({ asyncUtilTimeout: previousAsyncUtilTimeout });
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    window.localStorage.setItem("space.uiTheme.v1", "classic");
    setWarmRoomTelemetry({ hardwareConcurrency: 4 });
  });

  afterEach(() => {
    resetCliVpnRoutingStatusForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setWarmRoomTelemetry({ hardwareConcurrency: 4 });
  });

  // Source Control works locally without a provider account since 23e6bb24f9.
  it.each([undefined, "gitea", "github"] as const)("shows Source Control in Docks with or without a connected provider (%s)", async (provider) => {
    setViewport(1440, 900);
    installFetchFixture({ panes: [], sourceControlProvider: provider });
    render(<App />);
    const { menu } = await openDesktopMenu("Workspace");
    await waitFor(() => expect(within(menu).queryByRole("button", { name: /source control/i })).toBeTruthy());
    expect(within(menu).queryByRole("button", { name: /GitHub \/ Gitea/ })).toBeNull();
  });

  it("coalesces repeated SSE pane refreshes and queues one trailing refresh during an active request", async () => {
    const refreshQueue = createCoalescedRefreshQueue();
    const firstGate = deferred<void>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => firstGate.promise)
      .mockResolvedValue(undefined);

    const first = refreshQueue.request("room:responsive:panes", refresh);
    const duplicate = refreshQueue.request("room:responsive:panes", refresh);
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    refreshQueue.request("room:responsive:panes", refresh);
    refreshQueue.request("room:responsive:panes", refresh);
    firstGate.resolve();
    await first;

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("routes SSE events to one runtime category and polls only after the stream is unavailable", () => {
    expect(roomRefreshCategoriesForEvent("PANE_CREATED")).toEqual(["panes"]);
    expect(roomRefreshCategoriesForEvent("TURN_COMPLETED")).toEqual(["turns"]);
    expect(roomRefreshCategoriesForEvent("SWARM_TASK_UPDATED")).toEqual(["swarm"]);
    expect(roomRefreshCategoriesForEvent("ARTIFACT_CREATED")).toEqual([]);

    expect(shouldUseEventStreamFallback("connected")).toBe(false);
    expect(shouldUseEventStreamFallback("connecting")).toBe(false);
    expect(shouldUseEventStreamFallback("disconnected")).toBe(true);
    expect(shouldUseEventStreamFallback("unavailable")).toBe(true);
  });

  it("opens app EventSource streams only after visible terminal sockets report ready", () => {
    expect(shouldOpenAppEventStreams({
      authenticated: true,
      terminalsConnected: false,
      eventSourceSupported: true,
      cliLauncherOpen: false
    })).toBe(false);
    expect(shouldOpenAppEventStreams({
      authenticated: true,
      terminalsConnected: true,
      eventSourceSupported: true,
      cliLauncherOpen: false
    })).toBe(true);
  });

  it("starts every terminal session without loading optional admin catalogs", async () => {
    setViewport(1440, 900);
    const readinessGate = deferred<void>();
    const fixture = installFetchFixture({
      panes: terminalPanes("room:responsive", 5),
      requestDeferredByUrl: { "/readyz": readinessGate.promise }
    });

    render(<App />);

    expect(await screen.findByLabelText("CLI 5 agent 5")).toBeTruthy();
    await waitFor(() => expect(fixture.requests.some((request) => request.url === "/readyz")).toBe(true));
    const requestUrls = fixture.requests.map((request) => request.url);
    const activeSessionUrls = Array.from(
      { length: 5 },
      (_, index) => `/api/panes/pane%3Aroom%3Aresponsive%3Acli-${index + 1}/cli/session?includeTranscript=false`
    );
    expect(requestUrls.indexOf("/api/rooms")).toBeLessThan(requestUrls.findIndex((url) => url.startsWith("/api/panes?roomId=")));
    for (const activeSessionUrl of activeSessionUrls) {
      expect(requestUrls.indexOf(activeSessionUrl)).toBeGreaterThanOrEqual(0);
    }
    expect(requestUrls).not.toContain("/api/skills");

    await act(async () => {
      readinessGate.resolve();
      await readinessGate.promise;
    });
  });

  it("hydrates both recent warm pane layers before optional room metadata and the admin burst", async () => {
    setViewport(1440, 900);
    setWarmRoomTelemetry({
      hardwareConcurrency: 8,
      usedBytes: 256 * 1024 ** 2,
      heapLimitBytes: 8 * 1024 ** 3,
      deviceMemoryGiB: 16
    });
    window.sessionStorage.clear();
    window.sessionStorage.setItem("space.selectedRoomId", "room:active");
    window.sessionStorage.setItem(
      "space.warmRoom.mru.v1",
      JSON.stringify(["room:active", "room:recent-a", "room:recent-b"])
    );
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    const metadataGate = deferred<void>();
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:active", name: "Active", order: 0 },
        { id: "room:recent-a", name: "Recent A", order: 1 },
        { id: "room:recent-b", name: "Recent B", order: 2 }
      ],
      panesByRoom: {
        "room:active": reviewPanes("room:active", 1),
        "room:recent-a": reviewPanes("room:recent-a", 1),
        "room:recent-b": reviewPanes("room:recent-b", 1)
      },
      requestDeferredByUrl: {
        [`/api/swarm?roomId=${encodeURIComponent("room:recent-a")}`]: metadataGate.promise,
        [`/api/turns?roomId=${encodeURIComponent("room:recent-a")}`]: metadataGate.promise,
        [`/api/events?roomId=${encodeURIComponent("room:recent-a")}&pageSize=50&sortOrder=desc`]: metadataGate.promise
      }
    });

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "Active" })).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('[data-room-runtime-id="room:recent-a"]')).toBeTruthy();
      expect(container.querySelector('[data-room-runtime-id="room:recent-b"]')).toBeTruthy();
      expect(fixture.requests.some((request) => request.url === "/readyz")).toBe(true);
    });

    const requestUrls = fixture.requests.map((request) => request.url);
    const recentAPanes = `/api/panes?roomId=${encodeURIComponent("room:recent-a")}`;
    const recentBPanes = `/api/panes?roomId=${encodeURIComponent("room:recent-b")}`;
    expect(requestUrls.filter((url) => url === recentAPanes)).toHaveLength(1);
    expect(requestUrls.filter((url) => url === recentBPanes)).toHaveLength(1);
    expect(requestUrls.indexOf(recentAPanes)).toBeGreaterThanOrEqual(0);
    expect(requestUrls.indexOf(recentAPanes)).toBeLessThan(requestUrls.indexOf(recentBPanes));
    expect(requestUrls.indexOf(recentBPanes)).toBeLessThan(requestUrls.indexOf("/readyz"));
    expect(requestUrls).not.toContain("/api/skills");

    metadataGate.resolve();
  });

  it("defers provider and health snapshots until Resources opens", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    await waitFor(() => {
      expect(fixture.requests.some((request) => request.url === "/readyz")).toBe(true);
      expect(fixture.requests.some((request) => request.url === "/api/admin")).toBe(true);
    });
    for (const url of [
      "/api/providers",
      "/api/provider-settings",
      "/api/models",
      "/api/skills",
      "/api/imports",
      "/api/mcp",
      "/api/admin/mcp/discovery-smoke",
      "/api/admin/memory/embedding-smoke",
      "/api/admin/memory/vector-readiness",
      "/api/admin/codex-app-server",
      "/api/admin/codex-app-server/handshake",
      "/api/admin/codex-app-server/turn-smoke",
      "/api/admin/storage",
      "/api/admin/observability",
      "/api/admin/worker"
    ]) {
      expect(fixture.requests.some((request) => request.url === url)).toBe(false);
    }

    // Health is no longer a dock (5aa3a6fdc4); its snapshot lives in the merged Resources view (ecc0af72fb).
    fireEvent.click((await workspaceAction("Resources")));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    expect(within(resources).getByRole("heading", { name: "Resources" })).toBeTruthy();
    await waitFor(() => expect(fixture.requests.some(request => request.url === "/api/admin/system-analytics/health")).toBe(true));
    expect(screen.getByRole("dialog", { name: "Resources" })).toBeTruthy();
  });

  it("loads only the provider catalog when the Settings dock opens", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    await waitFor(() => expect(fixture.requests.some((request) => request.url === "/readyz")).toBe(true));
    fireEvent.click((await workspaceAction(/^(Open|Show) settings dock$/)));
    expect(await screen.findByRole("searchbox", { name: "Search settings" })).toBeTruthy();
    await waitFor(() => {
      expect(fixture.requests.some((request) => request.url === "/api/providers")).toBe(true);
      expect(fixture.requests.some((request) => request.url === "/api/provider-settings")).toBe(true);
    });
    for (const url of [
      "/api/models",
      "/api/mcp",
      "/api/admin/mcp/discovery-smoke",
      "/api/admin/storage",
      "/api/admin/observability",
      "/api/admin/worker"
    ]) {
      expect(fixture.requests.some((request) => request.url === url)).toBe(false);
    }
  });



  it("renders and bootstraps panes before room runtime metadata resolves", async () => {
    setViewport(1440, 900);
    const roomId = "room:responsive";
    const metadataGate = deferred<void>();
    const fixture = installFetchFixture({
      panes: terminalPanes(roomId, 3),
      requestDeferredByUrl: {
        [`/api/swarm?roomId=${encodeURIComponent(roomId)}`]: metadataGate.promise,
        [`/api/turns?roomId=${encodeURIComponent(roomId)}`]: metadataGate.promise,
        [`/api/events?roomId=${encodeURIComponent(roomId)}&pageSize=50&sortOrder=desc`]: metadataGate.promise
      }
    });

    render(<App />);

    expect(await screen.findByLabelText("CLI 3 agent 3")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start your workspace" })).toBeNull();
    await waitFor(() => {
      expect(
        fixture.requests.some(
          (request) => request.url === "/api/panes/pane%3Aroom%3Aresponsive%3Acli-1/cli/session?includeTranscript=false"
        )
      ).toBe(true);
    });

    await act(async () => {
      metadataGate.resolve();
      await metadataGate.promise;
    });
  });

  it("shows pane loading instead of an empty room until the pane request resolves", async () => {
    setViewport(1440, 900);
    window.sessionStorage.clear();
    window.sessionStorage.setItem("space.selectedRoomId", "room:responsive");
    const paneGate = deferred<void>();
    installFetchFixture({
      panes: [],
      paneRequestDeferredByRoom: { "room:responsive": paneGate.promise }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Loading panes" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start your workspace" })).toBeNull();

    await act(async () => {
      paneGate.resolve();
      await paneGate.promise;
    });

    expect(await screen.findByRole("heading", { name: "Start your workspace" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Loading panes" })).toBeNull();
  });

  it("offers quick-start panes and keeps pane creation single-flight while a request is pending", async () => {
    setViewport(1440, 900);
    const paneCreateGate = deferred<void>();
    const fixture = installFetchFixture({
      panes: [],
      requestDeferredByUrl: { "/api/panes": paneCreateGate.promise }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Start your workspace" })).toBeTruthy();
    expect(screen.getByText("Choose a pane to begin working in this room.")).toBeTruthy();
    const openCli = screen.getByRole("button", { name: "Open CLI" });
    const openChat = screen.getByRole("button", { name: "Open Chat" });
    const openBrowser = screen.getByRole("button", { name: "Open Browser" });

    await act(async () => {
      openBrowser.click();
      openBrowser.click();
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: "Opening Browser…" })).toHaveProperty("disabled", true);
    expect(openCli).toHaveProperty("disabled", true);
    expect(openChat).toHaveProperty("disabled", true);
    expect(
      fixture.requests.filter((request) => request.url === "/api/panes" && request.method === "POST")
    ).toHaveLength(1);
    expect(
      JSON.parse(fixture.requestBodies.find((request) => request.url === "/api/panes")?.body ?? "{}")
    ).toMatchObject({ mode: "BROWSER", title: "Browser 1" });

    await act(async () => {
      paneCreateGate.resolve();
      await paneCreateGate.promise;
    });

    expect(await screen.findByLabelText("Browser 1 agent 1")).toBeTruthy();
  });

  it("restores quick-start actions and shows the API error when pane creation fails", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: [], failPaneCreate: true });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Start your workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Chat" }));

    expect(await screen.findByText("PANE_CREATE_FAILED: The pane could not be opened.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open CLI" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Open Chat" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Open Browser" })).toHaveProperty("disabled", false);
    expect(
      fixture.requests.filter((request) => request.url === "/api/panes" && request.method === "POST")
    ).toHaveLength(1);
  });

  it("does not poll the active room while the first pane request is pending with Warm Off", async () => {
    setViewport(1440, 900);
    const paneGate = deferred<void>();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const originalSetInterval = window.setInterval.bind(window);
    let roomPoll: (() => void) | null = null;
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 30_000 && roomPoll === null) {
        roomPoll = handler as () => void;
        return originalSetInterval(() => undefined, 60_000) as unknown as ReturnType<typeof setInterval>;
      }
      return originalSetInterval(handler, timeout, ...args) as unknown as ReturnType<typeof setInterval>;
    });
    const fixture = installFetchFixture({
      panes: terminalPanes("room:responsive", 1),
      paneRequestDeferredByRoom: { "room:responsive": paneGate.promise }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Loading panes" })).toBeTruthy();
    await waitFor(() => expect(roomPoll).not.toBeNull());
    await act(async () => {
      now += 30_100;
      roomPoll?.();
      await Promise.resolve();
      now += 30_100;
      roomPoll?.();
      await Promise.resolve();
    });
    expect(fixture.requests.filter((request) => request.url.startsWith("/api/panes?roomId=")).length).toBe(1);

    await act(async () => {
      paneGate.resolve();
      await paneGate.promise;
    });

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Start your workspace" })).toBeNull();
  });

  it.each([390, 768, 1024, 1440])("keeps exactly one workspace logo visible at %ipx", async (width) => {
    setViewport(width, width <= 768 ? 844 : 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(container.querySelectorAll(".space-brand-control")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Play Space logo animation" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Space" }).getAttribute("src")).toBe("/brand/space-logo-2048.png");
    expect(container.querySelector(".board-title-row .space-brand-control")).toBeTruthy();
  });

  it.each([
    ["cli:codex", "Codex CLI", "codex"],
    [null, "Codex CLI", "codex"],
    ["cli:claude", "Claude Code CLI", "claude"],
    ["cli:gemini", "Gemini CLI", "gemini"],
    ["cli:opencode", "OpenCode CLI", "opencode"],
    ["opencode", "OpenCode CLI", "opencode"],
    ["cli:autohand", "Autohand Code CLI", "autohand"],
    ["autohand", "Autohand Code CLI", "autohand"],
    ["cli:kimi", "Kimi Code CLI", "kimi"],
    ["cli:qwen", "Qwen Code CLI", "qwen"],
    ["cli:grok", "Grok Build CLI", "grok"]
  ])("shows %s branding in the terminal header", async (terminalRuntimeId, title, brand) => {
    setViewport(1440, 900);
    installFetchFixture({
      panes: [pane({
        id: `pane:${brand}:${terminalRuntimeId ?? "default"}`,
        roomId: "room:responsive",
        order: 0,
        title,
        mode: "TERMINAL",
        terminalRuntimeId
      })]
    });

    render(<App />);

    const paneCard = await screen.findByLabelText(`${title} agent 1`);
    expect(
      paneCard.querySelector(`header .pane-agent-badge img[data-terminal-runtime-brand="${brand}"]`)
    ).toBeTruthy();
  });

  it("keeps the full VPN egress beside the pane identity instead of truncating it in the title row", async () => {
    setViewport(1440, 900);
    const paneId = "pane:opencode-vpn-header";
    const runtime = cliRuntime("cli:opencode", "OpenCode CLI");
    const sessionId = "cli_session:opencode-vpn-header";
    installFetchFixture({
      panes: [pane({
        id: paneId,
        roomId: "room:responsive",
        order: 0,
        title: "OpenCode VPN",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:opencode"
      })],
      cliSessionByPane: {
        [paneId]: {
          session: {
            sessionId,
            paneId,
            roomId: "room:responsive",
            runtimeId: "cli:opencode",
            providerId: "opencode",
            agentId: "opencode",
            modelId: null,
            reasoningEffort: "medium",
            launchMode: "FRESH",
            purpose: "NORMAL",
            cwd: "/etc",
            codexThreadId: null,
            cliTaskId: "cli_task:opencode-vpn-header",
            cliTaskRevisionId: "cli_revision:opencode-vpn-header",
            accountProfileId: null,
            status: "RUNNING",
            statusReason: "Attached to OpenCode.",
            exitCode: null,
            isActive: true,
            startedAt: "2026-08-01T15:00:00.000Z",
            updatedAt: "2026-08-01T15:00:00.000Z",
            endedAt: null
          },
          runtime,
          transcript: [],
          websocket: null
        }
      },
      cliVpnRoutingStatus: {
        vpnSupported: true,
        selectedRoute: "greece",
        connectionStatus: "CONNECTED",
        egressIpv4: "150.228.63.199",
        egressIpv6: null,
        relay: null,
        applications: [{
          runtimeId: "cli:opencode",
          effectiveMode: "VPN",
          appliedSessionIds: [sessionId],
          restartRequiredSessionIds: []
        }],
        checkedAt: "2026-08-01T15:00:00.000Z"
      }
    });

    render(<App />);

    const paneCard = await screen.findByLabelText("OpenCode VPN agent 1");
    const badge = paneCard.querySelector(".pane-agent-badge");
    await waitFor(() => expect(badge?.getAttribute("title")).toContain("Greece VPN egress 150.228.63.199"));
    await waitFor(() => expect(badge?.querySelector(".pane-agent-vpn-indicator")?.textContent).toBe("VPN"));
    expect(paneCard.querySelector(".pane-session-routing")).toBeNull();
  });

  it("keeps the last confirmed pane VPN badge during a transient status refresh failure", async () => {
    setViewport(1440, 900);
    const paneId = "pane:opencode-vpn-refresh";
    const sessionId = "cli_session:opencode-vpn-refresh";
    const fixtureInput: Parameters<typeof installFetchFixture>[0] = {
      panes: [pane({
        id: paneId,
        roomId: "room:responsive",
        order: 0,
        title: "OpenCode VPN refresh",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:opencode"
      })],
      cliSessionByPane: {
        [paneId]: {
          session: {
            sessionId,
            paneId,
            roomId: "room:responsive",
            runtimeId: "cli:opencode",
            providerId: "opencode",
            agentId: "opencode",
            modelId: null,
            reasoningEffort: "medium",
            launchMode: "FRESH",
            purpose: "NORMAL",
            cwd: "/etc",
            codexThreadId: null,
            cliTaskId: "cli_task:opencode-vpn-refresh",
            cliTaskRevisionId: "cli_revision:opencode-vpn-refresh",
            accountProfileId: null,
            status: "RUNNING",
            statusReason: "Attached to OpenCode.",
            exitCode: null,
            isActive: true,
            startedAt: "2026-08-01T15:00:00.000Z",
            updatedAt: "2026-08-01T15:00:00.000Z",
            endedAt: null
          },
          runtime: cliRuntime("cli:opencode", "OpenCode CLI"),
          transcript: [],
          websocket: null
        }
      },
      cliVpnRoutingStatus: {
        vpnSupported: true,
        selectedRoute: "mullvad",
        connectionStatus: "CONNECTED",
        egressIpv4: "193.32.249.133",
        egressIpv6: null,
        relay: null,
        applications: [{
          runtimeId: "cli:opencode",
          effectiveMode: "VPN",
          appliedSessionIds: [sessionId],
          restartRequiredSessionIds: []
        }],
        checkedAt: "2026-08-01T15:00:00.000Z"
      }
    };
    const fixture = installFetchFixture(fixtureInput);

    render(<App />);

    const paneCard = await screen.findByLabelText("OpenCode VPN refresh agent 1");
    await waitFor(() => expect(paneCard.querySelector(".pane-agent-vpn-indicator")?.textContent).toBe("VPN"));
    const statusRequestsBeforeFailure = fixture.requests.filter(({ url }) => url === "/api/cli/vpn/routing-status").length;

    fixtureInput.cliVpnRoutingStatus = undefined;
    act(() => publishCliVpnRoutingStatus());

    await waitFor(() => expect(
      fixture.requests.filter(({ url }) => url === "/api/cli/vpn/routing-status").length
    ).toBeGreaterThan(statusRequestsBeforeFailure));
    expect(paneCard.querySelector(".pane-agent-vpn-indicator")?.textContent).toBe("VPN");
    expect(paneCard.querySelector(".pane-agent-badge")?.getAttribute("title")).toContain("Mullvad VPN egress 193.32.249.133");
  });

  it("shows only cancel and reconnect actions while a CLI pane is authenticating", async () => {
    setViewport(1440, 900);
    const paneId = "pane:gemini-login";
    const geminiRuntime = {
      ...cliRuntime("cli:gemini", "Gemini CLI"),
      authMode: "BROWSER_OAUTH" as const,
      authState: "LOGIN_REQUIRED" as const,
      authReason: "Gemini CLI requires Google OAuth login.",
      canStartLogin: true,
      status: "NOT_CONNECTED" as const,
      statusReason: "Gemini CLI requires Google OAuth login."
    };
    installFetchFixture({
      panes: [pane({
        id: paneId,
        roomId: "room:responsive",
        order: 0,
        title: "Gemini Login",
        mode: "TERMINAL",
        terminalRuntimeId: "cli:gemini"
      })],
      cliSessionByPane: {
        [paneId]: {
          session: {
            sessionId: "cli_session:gemini-login",
            paneId,
            roomId: "room:responsive",
            runtimeId: "cli:gemini",
            providerId: "gemini",
            agentId: "gemini",
            modelId: null,
            reasoningEffort: "medium",
            launchMode: "FRESH",
            purpose: "LOGIN",
            cwd: "/etc",
            codexThreadId: null,
            cliTaskId: null,
            cliTaskRevisionId: null,
            accountProfileId: null,
            status: "RUNNING",
            statusReason: "Attached to CLI login.",
            exitCode: null,
            isActive: true,
            startedAt: "2026-07-22T08:00:00.000Z",
            updatedAt: "2026-07-22T08:00:00.000Z",
            endedAt: null
          },
          runtime: geminiRuntime,
          transcript: [],
          websocket: null
        }
      }
    });

    render(<App />);

    const paneCard = await screen.findByLabelText("Gemini Login agent 1");
    expect(paneCard.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    expect(await within(paneCard).findByRole("button", { name: "More pane actions Gemini Login" })).toBeTruthy();
    fireEvent.click(within(paneCard).getByRole("button", { name: "More pane actions Gemini Login" }));
    const loginSheet = await screen.findByRole("menu", { name: "Pane actions Gemini Login" });
    expect(within(loginSheet).getByRole("menuitem", { name: "Cancel CLI login Gemini Login" })).toBeTruthy();
    expect(within(loginSheet).getByRole("menuitem", { name: "Reconnect CLI login Gemini Login" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane actions Gemini Login" })).toBeNull());
    for (const blockedLabel of [
      /Import files/,
      /Generate pane title/,
      /Edit pane title/,
      /Enable Plan mode/,
      /Resume/,
      /Stop CLI task/,
      /Save .* to memory/,
      /Copy CLI contents/,
      /Move .* to another room/,
      /Add pane from/
    ]) {
      expect(within(paneCard).queryByRole("button", { name: blockedLabel })).toBeNull();
    }
  });

  it("keeps configured Chat usable while Codex pane actions are Off and preserves other CLI splits", async () => {
    setViewport(1440, 900);
    const roomId = "room:responsive";
    const fixture = installFetchFixture({
      isCodexEnabled: false,
      panes: [
        pane({
          id: "pane:chat-off",
          roomId,
          order: 0,
          title: "Chat Off",
          mode: "CHAT"
        }),
        pane({
          id: "pane:claude-on",
          roomId,
          order: 1,
          title: "Claude On",
          mode: "TERMINAL",
          terminalRuntimeId: "cli:claude"
        })
      ]
    });

    await fixture.environmentReady;
    render(<App />);

    const chatPane = await screen.findByLabelText("Chat Off agent 1");
    const composer = await within(chatPane).findByRole("textbox", { name: "Message Chat Off" });
    await waitFor(() => expect(composer).toHaveProperty("disabled", false));

    expect(chatPane.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    fireEvent.click(within(chatPane).getByRole("button", { name: "More pane actions Chat Off" }));
    const chatMenu = await screen.findByRole("menu", { name: "Pane actions Chat Off" });
    const plan = within(chatMenu).getByRole("menuitem", { name: "Enable Plan mode Chat Off" });
    const copy = within(chatMenu).getByRole("menuitem", { name: "Copy Chat contents Chat Off" });
    const addChat = within(chatMenu).getByRole("menuitem", { name: "Add pane from Chat Off" });
    expect(plan).toHaveProperty("disabled", true);
    expect(plan.getAttribute("title")).toBe("Enable Codex in Settings");
    // An empty Chat has nothing to copy, so Copy says so instead of failing on click.
    expect(copy).toHaveProperty("disabled", true);
    expect(copy.getAttribute("title")).toBe("There are no visible Chat contents to copy.");
    expect(addChat).toHaveProperty("disabled", true);

    for (const actionName of ["New task", "Task history", "Attach folder", "Manage goal"]) {
      const action = within(chatMenu).getByRole("menuitem", { name: actionName });
      expect(action).toHaveProperty("disabled", true);
      expect(action.getAttribute("title")).toBe("Enable Codex in Settings");
    }
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane actions Chat Off" })).toBeNull());

    const claudePane = screen.getByLabelText("Claude On agent 2");
    expect(claudePane.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    fireEvent.click(within(claudePane).getByRole("button", { name: "More pane actions Claude On" }));
    const claudeMenu = await screen.findByRole("menu", { name: "Pane actions Claude On" });
    const addClaude = within(claudeMenu).getByRole("menuitem", { name: "Add pane from Claude On" });
    expect(addClaude).toHaveProperty("disabled", false);
    fireEvent.click(addClaude);

    await waitFor(() =>
      expect(
        fixture.requestBodies.some(({ url, body }) =>
          url === "/api/panes" &&
          body.includes("\"terminalRuntimeId\":\"cli:claude\"")
        )
      ).toBe(true)
    );
  });

  it("keeps Settings and admin Codex controls visible but disabled while Off", async () => {
    setViewport(1440, 900);
    const { environmentReady } = installFetchFixture({
      role: "ADMIN",
      isCodexEnabled: false,
      panes: terminalPanes("room:responsive", 1)
    });

    await environmentReady;
    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    fireEvent.click(await currentWorkspaceAction("Manage", "Utilities", true));
    const manage = await screen.findByRole("dialog", { name: "Manage" });
    fireEvent.click(within(manage).getByRole("button", { name: "Connections" }));
    const speed = within(manage).getByRole("button", { name: "Codex speed defaults" });
    expect(speed).toHaveProperty("disabled", true);
    expect(speed.getAttribute("title")).toBe("Enable Codex in Settings");
    fireEvent.click(within(manage).getByRole("button", { name: "← All sections" }));
    fireEvent.click(within(manage).getByRole("button", { name: "Maintenance" }));
    expect(within(manage).getByRole("button", { name: "Purge inactive history" })).toHaveProperty("disabled", false);

    fireEvent.click(await currentWorkspaceAction(/^(Open|Show) settings dock$/, "Docks", true));
    await openSettingsSection("Default provider");
    const provider = await screen.findByRole("combobox", { name: "Default provider" });
    expect(provider).toHaveProperty("disabled", true);
    expect(provider.getAttribute("title")).toBe("Enable Codex in Settings");

    await openSettingsSection("Telegram notifications");
    const telegram = await screen.findByRole("region", { name: "Telegram notifications" });
    expect(within(telegram).getByText("OFF")).toBeTruthy();
    expect(within(telegram).getByRole("button", { name: "Telegram notification actions" })).toHaveProperty("disabled", true);
  });

  it("moves a pane to another room without switching away from the current room", async () => {
    setViewport(1440, 900);
    const { requestBodies } = installFetchFixture({
      rooms: [
        { id: "room:source", name: "Source room" },
        { id: "room:target", name: "Target room" }
      ],
      roomId: "room:source",
      panes: reviewPanes("room:source", 1)
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Source room" })).toBeTruthy();
    const targetPane = screen.getByRole("button", { name: "Target Review 1" });
    expect(targetPane.getAttribute("aria-pressed")).toBe("true");
    expect(targetPane.classList.contains("selected")).toBe(false);
    const movePane = await screen.findByRole("button", { name: "Move Review 1 to another room" });
    expect(movePane.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(movePane);
    expect(movePane.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByRole("dialog", { name: "Move pane to another room" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move pane" }));

    expect(await screen.findByText('Moved "Review 1" to "Target room".')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Source room" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Start your workspace" })).toBeTruthy();
    expect(requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/api/panes/pane%3Aroom%3Asource%3A1/move",
          body: JSON.stringify({ targetRoomId: "room:target" })
        })
      ])
    );
  });

  it("uses one-pane mobile focus mode and overlay surfaces for 6-pane rooms", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: reviewPanes("room:responsive", 6) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-pane-count")).toBe("6");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("1");

    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    for (let index = 0; index < 3; index += 1) {
      const title = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
      fireEvent.touchStart(title!, { touches: [{ clientX: 200, clientY: 100 }] });
      fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    }
    expect(await screen.findByLabelText("Review 4 agent 4")).toBeTruthy();
    expect(screen.getByLabelText("Review 1 agent 1").getAttribute("data-shell-visible")).toBe("false");

    expect(screen.queryByLabelText("Rooms")).toBeNull();
    expect(screen.queryByLabelText("Media dock")).toBeNull();
    expect((await workspaceAction("Open media dock")).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    expect(await screen.findByLabelText("Rooms")).toBeTruthy();
    showDock("Room Agent");
    expect(await screen.findByLabelText("Room Agent")).toBeTruthy();
    // The simplified Room Agent dock (d8b32fa7fa) identifies itself as a chat region instead of a heading.
    expect(await screen.findByRole("region", { name: "Room Agent chat" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message Room Agent" })).toBeTruthy();
    expect(within(screen.getByLabelText("Room Agent")).queryByLabelText(/model|reasoning|permission|upload/i)).toBeNull();
    showDock("Media dock");
    expect(await screen.findByLabelText("Media dock")).toBeTruthy();
    expect((await workspaceAction("Close media dock")).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByLabelText("Rooms")).toBeNull();
    showDock("Clipboard");
    expect(await screen.findByLabelText("Clipboard")).toBeTruthy();
    expect((await workspaceAction("Open media dock")).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect((await workspaceAction("Close clipboard")).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(await screen.findByLabelText("Clipboard history")).toBeTruthy();
    expect(screen.queryByLabelText("Media dock")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open controls" })).toBeNull();
  });

  it("keeps the tablet agent board mounted and visible while every shared left surface is open", async () => {
    setViewport(945, 2048);
    installFetchFixture({ panes: reviewPanes("room:responsive", 3) });

    const { container } = render(<App />);
    const paneBeforeOpen = await screen.findByLabelText("Review 1 agent 1");
    const runtimeBeforeOpen = container.querySelector(".room-runtime-layer");
    const gridBeforeOpen = container.querySelector(".pane-grid");

    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("tablet");

    for (const surface of [
      { label: "Rooms" },
      { label: "Room Agent" },
      { label: "Media dock" },
      { label: "Agent Files" },
      { label: "Clipboard" },
      { label: "Links" },
      { label: "Settings dock" }
    ]) {
      fireEvent.click((await workspaceAction("Open rooms")));
      await screen.findByRole("dialog", { name: "Rooms" });
      showDock(surface.label);

      expect(await screen.findByLabelText(surface.label)).toBeTruthy();
      expect(container.querySelector(".surface-dismiss-layer")).toBeTruthy();
      expect(container.querySelector(".surface-backdrop")).toBeNull();
      expect(container.querySelector(".room-runtime-layer")).toBe(runtimeBeforeOpen);
      expect(container.querySelector(".pane-grid")).toBe(gridBeforeOpen);
      expect(screen.getByLabelText("Review 1 agent 1")).toBe(paneBeforeOpen);

      fireEvent.click(container.querySelector(".surface-dismiss-layer") as HTMLButtonElement);
      await waitFor(() => expect(container.querySelector(".side-surface-drawer")).toBeNull());
    }

    // Health merged into Resources (ecc0af72fb, 5aa3a6fdc4).
    fireEvent.click((await workspaceAction("Resources")));
    const health = await screen.findByRole("dialog", { name: "Resources" });
    expect(container.querySelector(".room-runtime-layer")).toBe(runtimeBeforeOpen);
    expect(container.querySelector(".pane-grid")).toBe(gridBeforeOpen);
    expect(screen.getByLabelText("Review 1 agent 1")).toBe(paneBeforeOpen);
    fireEvent.click(within(health).getByRole("button", { name: "Close Resources" }));

    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.surface-dismiss-layer \{[^}]*background: transparent;/s);
    expect(css).toMatch(/\.space-shell\[data-room-theme\] \.surface-dismiss-layer \{[^}]*background: transparent;/s);
  });

  it("traps compact drawer focus and restores the trigger when Escape closes it", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    // Workspace dock entries open inline pages (4d2bc9d1a4); the compact drawer opens from
    // the room toolbar and switches to Settings with its own dock navigation.
    const trigger = await workspaceAction("Open rooms");
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Rooms" });
    showDock("Settings dock");

    const drawer = await screen.findByRole("dialog", { name: "Settings dock" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'));
    focusable.at(-1)?.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".side-surface-drawer")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("traps embedded Settings focus and restores the trigger after Escape returns through Workspace", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    const action = await workspaceAction("Open settings dock");
    const trigger = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(action);

    const drawer = await screen.findByRole("dialog", { name: "Workspace" });
    expect(await within(drawer).findByRole("region", { name: "Settings dock" })).toBeTruthy();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'));
    focusable.at(-1)?.focus();
    fireEvent.keyDown(drawer, { key: "Tab" });
    expect(document.activeElement).toBe(within(drawer).getByRole("textbox", { name: "Find an action" }));
    fireEvent.keyDown(drawer, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(within(drawer).queryByRole("region", { name: "Settings dock" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Workspace" })).toBe(drawer);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("lets a modal opened inside a compact drawer own Escape and Tab", async () => {
    setViewport(390, 844);
    window.localStorage.setItem("space.roomToolbar.hidden.v1", "true");
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Show docks" }));
    fireEvent.click(await screen.findByRole("button", { name: /settings/i }));
    const drawer = await screen.findByRole("dialog", { name: "Settings dock" });

    const nested = document.createElement("dialog");
    nested.setAttribute("open", ""); nested.setAttribute("aria-label", "Nested picker");
    nested.innerHTML = '<input aria-label="Nested search" />';
    drawer.appendChild(nested);
    const nestedInput = within(nested).getByLabelText("Nested search");
    nestedInput.focus();
    fireEvent.keyDown(nestedInput, { key: "Tab" });
    expect(document.activeElement).toBe(nestedInput);
    fireEvent.keyDown(nestedInput, { key: "Escape" });
    expect(container.querySelector(".side-surface-drawer")).toBe(drawer);

    nested.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".side-surface-drawer")).toBeNull());
  });

  it("hides collapsed floating toolbar when a compact drawer is open", async () => {
    setViewport(390, 844);
    window.localStorage.setItem("space.roomToolbar.hidden.v1", "true");
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    expect(container.querySelector(".room-toolbar-collapsed")).toBeTruthy();

    const docksButton = screen.getByRole("button", { name: "Show docks" });
    fireEvent.click(docksButton);
    const settingsOption = await screen.findByRole("button", { name: /settings/i });
    fireEvent.click(settingsOption);

    await screen.findByRole("dialog", { name: "Settings dock" });
    expect(container.querySelector(".side-surface-drawer")).toBeTruthy();
    expect(container.querySelector(".room-toolbar-collapsed")).toBeNull();

    fireEvent.click(container.querySelector(".surface-dismiss-layer") as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector(".side-surface-drawer")).toBeNull());
    expect(container.querySelector(".room-toolbar-collapsed")).toBeTruthy();

    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toContain(".space-shell:has(.side-surface-drawer) .room-toolbar-floating-controls");
    expect(css).toContain(".space-shell:has(.mobile-action-sheet-backdrop) .room-toolbar-floating-controls");
    expect(css).toContain(".space-shell[data-shell-mode=\"mobile\"] .side-surface-drawer");
  });

  it("closes desktop theme and navigation menus with Escape and restores the persistent trigger", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click(await workspaceAction("Room theme"));
    // The theme picker is embedded in the Workspace menu (4d2bc9d1a4) and handles Escape itself.
    const themeMenu = await screen.findByRole("menu", { name: "Room theme options" });
    fireEvent.keyDown(themeMenu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Room theme options" })).toBeNull();
    const { trigger, menu } = await openDesktopMenu("Workspace");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus through searchable desktop actions and restores the navigation trigger", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    const { trigger, menu } = await openDesktopMenu("Workspace");
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    const search = within(menu).getByRole("textbox", { name: "Find an action" });
    expect(document.activeElement).toBe(search);
    const enabled = Array.from(menu.querySelectorAll<HTMLButtonElement>(".desktop-menu-action:not(:disabled)"));
    expect(enabled.length).toBeGreaterThan(1);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(enabled[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(enabled[1]);
    fireEvent.keyDown(enabled[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(enabled[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(enabled.at(-1));
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("traps focus in the mobile room action dialog and restores its trigger", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "Workspace" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Workspace" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The Workspace footer now ends with Sign out and the app version link, so links are part of the trap.
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]'))
      .filter(node => node.tabIndex >= 0 && !node.closest('[hidden], [aria-hidden="true"]'));
    focusable.at(-1)!.focus();
    fireEvent.keyDown(focusable.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(focusable[0]);
    fireEvent.keyDown(focusable[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(focusable.at(-1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("opens all ADMIN server actions from the desktop Admin menu and restores focus", async () => {
    setViewport(1440, 900);
    const { requests, requestBodies } = installFetchFixture({
      role: "ADMIN",
      panes: terminalPanes("room:responsive", 1)
    });

    await loadFixtureCodexEnvironment();
    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    // Server actions are grouped on the Manage page of the Workspace menu (ecc0af72fb); every
    // tool opens embedded in that page and Escape walks back to the persistent trigger.
    // Space Gateway left Manage for a full-screen Utilities entry in 549031fbaf.
    const { trigger } = await openDesktopMenu("Admin", true);
    fireEvent.click(await workspaceAction("Manage"));
    const menu = await screen.findByRole("dialog", { name: "Manage" });
    await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("textbox", { name: "Find an action" })));
    const sections: Record<string, string[]> = {
      Maintenance: ["Space & CLI maintenance", "Clean CLI sessions & storage", "Purge inactive history", "Reclaim safe memory", "Update all CLIs"],
      Connections: ["Setup & connections", "Codex speed defaults"],
      Services: ["Restart server", "Restart all CLI runtimes", "System services"],
      Administration: ["Users & permissions", "Publish Space release"]
    };
    expect(Array.from(menu.querySelectorAll(".manage-groups > button"), (item) => item.getAttribute("aria-label"))).toEqual(Object.keys(sections));
    for (const [section, names] of Object.entries(sections)) {
      fireEvent.click(within(menu).getByRole("button", { name: section }));
      expect(Array.from(menu.querySelectorAll(".manage-actions > button"), (item) => item.getAttribute("aria-label"))).toEqual(names);
      fireEvent.click(within(menu).getByRole("button", { name: "← All sections" }));
    }
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Manage" })).toBeNull();
    const workspaceMenu = screen.getByRole("dialog", { name: "Workspace" });
    await waitFor(() => expect(document.activeElement).toBe(within(workspaceMenu).getByRole("button", { name: "Manage" })));
    fireEvent.keyDown(workspaceMenu, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);

    const manage = await openManageSection("Maintenance");
    fireEvent.click(within(manage).getByRole("button", { name: "Space & CLI maintenance" }));
    const maintenanceDialog = await within(manage).findByRole("region", { name: "Space & CLI maintenance" });
    await waitFor(() => expect(requests).toContainEqual({ url: "/api/admin/cli-maintenance/runs", method: "GET" }));
    fireEvent.click(within(maintenanceDialog).getByRole("button", { name: "Close Space & CLI maintenance" }));
    expect(await within(manage).findByRole("button", { name: "Space & CLI maintenance" })).toBeTruthy();

    await openManageSection("Administration");
    fireEvent.click(within(manage).getByRole("button", { name: "Publish Space release" }));
    const releaseDialog = await within(manage).findByRole("region", { name: "Publish Space release" });
    await waitFor(() => expect(requests).toContainEqual({ url: "/api/admin/releases/runs", method: "GET" }));
    fireEvent.click(within(releaseDialog).getByRole("button", { name: "Close Publish Space release" }));
    expect(await within(manage).findByRole("button", { name: "Publish Space release" })).toBeTruthy();

    await openManageSection("Connections");
    fireEvent.click(within(manage).getByRole("button", { name: "Codex speed defaults" }));
    expect(within(manage).queryByRole("button", { name: "Codex speed defaults" })).toBeNull();
    const dialog = await within(manage).findByRole("region", { name: "Codex speed defaults" });
    const close = within(dialog).getByRole("button", { name: "Close Codex speed defaults" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    await waitFor(() => expect(requests).toContainEqual({ url: "/api/admin/codex-lb-speed-defaults", method: "GET" }));

    fireEvent.click(await within(dialog).findByRole("button", { name: "Set GPT-5.5 to Fast" }));
    await waitFor(() => expect(requestBodies).toContainEqual({
      url: "/api/admin/codex-lb-speed-defaults/gpt-5.5",
      body: JSON.stringify({ tier: "FAST" })
    }));

    fireEvent.click(close);
    fireEvent.click(await within(manage).findByRole("button", { name: "Close Manage" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Workspace" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("removes speed and history links from the regular Workspace menu", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      role: "ADMIN",
      panes: terminalPanes("room:responsive", 1)
    });

    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    const { menu } = await openDesktopMenu("Workspace");
    expect(within(menu).queryByRole("button", { name: "Codex speed defaults" })).toBeNull();
    expect(within(menu).queryByRole("button", { name: "Purge inactive history" })).toBeNull();
    expect(within(menu).queryByText("Admin tools")).toBeNull();
  });

  it("opens CLI cleanup and memory reclaim from the server menu without removing their metric triggers", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      role: "ADMIN",
      panes: terminalPanes("room:responsive", 1)
    });

    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    const { trigger } = await openDesktopMenu("Admin", true);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Workspace" }), { key: "Escape" });
    // Resources summarises CLI sessions and CPU/RAM as overview rows (ecc0af72fb).
    fireEvent.click(await workspaceAction("Resources"));
    const metricLabel = (metric: HTMLElement) => metric.querySelector(".resources-summary-info")?.textContent;
    const cliMetric = within(await screen.findByRole("dialog", { name: "Resources" })).getByRole("button", { name: /^Sessions/ });
    const ramMetric = within(screen.getByRole("dialog", { name: "Resources" })).getByRole("button", { name: /^System.*RAM/ });
    const cliMetricLabel = metricLabel(cliMetric);
    const ramMetricLabel = metricLabel(ramMetric);
    expect(cliMetricLabel).toContain("Running CLI sessions");
    expect(ramMetric.textContent).toContain("RAM");

    const manage = await openManageSection("Maintenance");
    fireEvent.click(within(manage).getByRole("button", { name: "Clean CLI sessions & storage" }));
    const cliDialog = await within(manage).findByRole("region", { name: "Clean CLI sessions" });
    fireEvent.click(within(cliDialog).getByRole("button", { name: "Close Clean CLI sessions" }));
    expect(await within(manage).findByRole("button", { name: "Clean CLI sessions & storage" })).toBeTruthy();

    await openManageSection("Maintenance");
    fireEvent.click(within(manage).getByRole("button", { name: "Reclaim safe memory" }));
    const memoryDialog = await screen.findByRole("dialog", { name: "Reclaim safe memory" });
    fireEvent.click(within(memoryDialog).getByRole("button", { name: "Cancel" }));

    fireEvent.click(within(manage).getByRole("button", { name: "Close Manage" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Workspace" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    if (!screen.queryByRole("dialog", { name: "Resources" })) fireEvent.click(await workspaceAction("Resources"));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    expect(metricLabel(within(resources).getByRole("button", { name: /^Sessions/ }))).toBe(cliMetricLabel);
    expect(metricLabel(within(resources).getByRole("button", { name: /^System.*RAM/ }))).toBe(ramMetricLabel);
  });

  it("runs the protected ADMIN history purge flow from the mobile server menu", async () => {
    setViewport(390, 844);
    const { requestBodies } = installFetchFixture({
      role: "ADMIN",
      panes: terminalPanes("room:responsive", 1)
    });

    render(<App />);
    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();

    // The mobile server sheet became the grouped Manage page (ecc0af72fb).
    const action = await currentWorkspaceAction("Manage", "Utilities", true);
    const trigger = screen.getByRole("button", { name: "Workspace" });
    expect(action.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(action);
    const sheet = await openManageSection("Maintenance");
    fireEvent.click(within(sheet).getByRole("button", { name: "Purge inactive history" }));

    expect(screen.getByRole("dialog", { name: "Workspace" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Purge inactive history" })).toBeNull();
    const dialog = await within(sheet).findByRole("region", { name: "Purge history" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview history purge" }));
    expect(await within(dialog).findByText(/3 active threads are protected/i)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Type PURGE HISTORY to confirm"), {
      target: { value: "PURGE HISTORY" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Purge history" }));

    await waitFor(() => expect(requestBodies).toEqual(expect.arrayContaining([
      {
        url: "/api/admin/codex-history-purge-previews",
        body: JSON.stringify({})
      },
      {
        url: "/api/admin/codex-history-purges",
        body: JSON.stringify({
          previewId: "9943e22b-97a3-48b6-ae84-1a2cced6a353",
          confirmation: "PURGE HISTORY"
        })
      }
    ])));
    expect((await within(dialog).findByRole("status")).textContent).toMatch(
      /12 native threads and 7 shared CLI tasks purged/i
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close Purge history" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Purge history" })).toBeNull());
    fireEvent.click(await within(sheet).findByRole("button", { name: "Close Manage" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Workspace" })).getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Workspace" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it.each([390, 1440])("does not expose server actions to OPERATOR users at %ipx", async (width) => {
    setViewport(width, width === 390 ? 844 : 900);
    installFetchFixture({ role: "OPERATOR", panes: terminalPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    expect(screen.queryByRole("button", { name: "Server restart" })).toBeNull();
    let popup: HTMLElement;
    if (width === 390) {
      fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
      popup = await screen.findByRole("dialog", { name: "Workspace" });
      fireEvent.change(within(popup).getByRole("textbox"), { target: { value: "server" } });
    } else {
      expect(screen.queryByRole("button", { name: "Admin mode" })).toBeNull();
      popup = (await openDesktopMenu("Workspace")).menu;
      fireEvent.change(within(popup).getByRole("textbox"), { target: { value: "server" } });
    }
    for (const name of ["Server restart", "Codex speed defaults", "Purge inactive history", "Add CLI ROOT"]) {
      expect(within(popup).queryByRole("button", { name })).toBeNull();
    }
  });

  it.each([["ADMIN", 1440], ["OPERATOR", 390]] as const)("shows one %s CLI launcher at %ipx and keeps root outside its selector", async (role, width) => {
    setViewport(width, width === 390 ? 844 : 900);
    installFetchFixture({ role, panes: reviewPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    expect(screen.queryByRole("button", { name: "Add Claude Code CLI" })).toBeNull();
    let selector: HTMLElement;
    let trigger: HTMLElement;
    const opened = await openDesktopMenu("Create");
    selector = opened.menu;
    trigger = opened.trigger;
    await within(selector).findByRole("button", { name: "Add OpenCode CLI" });
    const options = Array.from(selector.querySelectorAll('.cli-launcher-option'));
    expect(options.map(item => item.getAttribute("aria-label"))).toEqual([
      "Add OpenCode CLI", "Add Codex CLI", "Add Claude Code CLI", "Add Gemini CLI",
      "Add Autohand Code CLI", "Add Qwen Code CLI", "Add Kimi Code CLI", "Add Grok Build CLI"
    ]);
    expect(selector.querySelectorAll('.cli-launcher-option img[data-terminal-runtime-brand]')).toHaveLength(8);
    expect(within(selector).queryByText("CLI ROOT")).toBeNull();
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(selector.isConnected).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    if (role === "ADMIN") {
      expect((await workspaceAction("Add CLI ROOT")).querySelector(".lucide-shield-check")).toBeTruthy();
    } else {
      expect(screen.queryByRole("button", { name: "Add CLI ROOT" })).toBeNull();
    }
  });

  it("opens the CLI selector at the 16-pane cap so an existing login pane can be retried", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: reviewPanes("room:responsive", 16) });
    render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    const { menu, trigger } = await openDesktopMenu("Create");
    expect(trigger).toHaveProperty("disabled", false);
    expect(await within(menu).findByRole("button", { name: "Add Codex CLI" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(await workspaceAction("Add CLI ROOT")).toHaveProperty("disabled", true);
  });

  it("closes the CLI selector when the user switches the active room", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      rooms: [{ id: "room:launcher-source", name: "Launcher source" }, { id: "room:launcher-target", name: "Launcher target" }],
      panesByRoom: {
        "room:launcher-source": reviewPanes("room:launcher-source", 1),
        "room:launcher-target": reviewPanes("room:launcher-target", 1)
      }
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Launcher source" });
    const { menu } = await openDesktopMenu("Create");
    expect(await within(menu).findByRole("button", { name: "Add Codex CLI" })).toBeTruthy();
    const target = screen.getByRole("button", { name: "Open Launcher target" });
    fireEvent.pointerDown(target);
    fireEvent.click(target);
    expect(await screen.findByRole("heading", { name: "Launcher target" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create" })).toBeNull());
  });

  it("keeps focus in desktop task history after activating it from pane actions", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: chatPanes("room:responsive", 1) });

    render(<App />);
    expect(await screen.findByLabelText("Chat 1 agent 1")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "More pane actions Chat 1" });
    expect(trigger.getAttribute("aria-controls")).toBe("pane-actions-pane:room:responsive:chat-1");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Pane actions Chat 1" });
    expect(menu.id).toBe("pane-actions-pane:room:responsive:chat-1");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Task history" }));

    const history = await screen.findByRole("dialog", { name: "Open Codex task history" });
    const search = within(history).getByRole("searchbox", { name: "Search Codex tasks" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.queryByRole("menu", { name: "Pane actions Chat 1" })).toBeNull();
  });

  it("focuses the first desktop pane action after the positioned portal becomes visible", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: chatPanes("room:responsive", 1) });
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function focus(
      this: HTMLElement,
      options?: FocusOptions
    ) {
      const actionManager = this.closest<HTMLElement>(".icon-action-manager");
      if (actionManager?.style.visibility === "hidden") return;
      nativeFocus.call(this, options);
    });

    render(<App />);
    expect(await screen.findByLabelText("Chat 1 agent 1")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "More pane actions Chat 1" });
    fireEvent.click(trigger);

    const menu = await screen.findByRole("menu", { name: "Pane actions Chat 1" });
    const firstItem = within(menu).getByRole("menuitem", { name: "New task" });
    await waitFor(() => expect(menu.style.visibility).toBe("visible"));
    await waitFor(() => expect(document.activeElement).toBe(firstItem));
  });

  it("keeps desktop Chat Quick Actions inside the pane below or above the trigger", async () => {
    setViewport(1200, 900);
    installFetchFixture({ panes: chatPanes("room:responsive", 1) });
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    let paneBounds = { left: 240, top: 120, width: 360, height: 500 };
    let triggerBounds = { left: 540, top: 130, width: 40, height: 40 };
    const domRect = ({ left, top, width, height }: typeof paneBounds) => ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({ left, top, width, height })
    }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
      this: HTMLElement
    ) {
      if (this.classList.contains("pane-card")) return domRect(paneBounds);
      if (this.classList.contains("icon-action-manager")) {
        return domRect({ left: 0, top: 0, width: 320, height: 360 });
      }
      if (this.getAttribute("aria-label") === "More pane actions Chat 1") return domRect(triggerBounds);
      return nativeRect.call(this);
    });

    render(<App />);
    const pane = await screen.findByLabelText("Chat 1 agent 1");
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions Chat 1" }));
    const menu = await screen.findByRole("menu", { name: "Pane actions Chat 1" });

    await waitFor(() => expect(menu.getAttribute("data-placement")).toBe("pane-inside-below"));
    expect(menu.style.left).toBe("260px");
    expect(menu.style.top).toBe("178px");
    expect(menu.style.width).toBe("320px");
    expect(menu.style.maxHeight).toBe("360px");

    paneBounds = { left: 600, top: 120, width: 360, height: 500 };
    triggerBounds = { left: 900, top: 130, width: 40, height: 40 };
    fireEvent.scroll(window);
    await waitFor(() => expect(menu.style.left).toBe("620px"));
    expect(menu.getAttribute("data-placement")).toBe("pane-inside-below");

    paneBounds = { left: 10, top: 100, width: 1180, height: 700 };
    triggerBounds = { left: 1100, top: 700, width: 40, height: 40 };
    fireEvent.resize(window);
    await waitFor(() => expect(menu.getAttribute("data-placement")).toBe("pane-inside-above"));
    expect(menu.style.left).toBe("820px");
    expect(menu.style.top).toBe("332px");
  });

  it("keeps focus in the mobile goal editor and skips a disabled pane action", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: chatPanes("room:responsive", 1) });

    render(<App />);
    expect(await screen.findByLabelText("Chat 1 agent 1")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "More pane actions Chat 1" });
    expect(trigger.getAttribute("aria-controls")).toBe("pane-actions-pane:room:responsive:chat-1");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(trigger);

    const actions = await screen.findByRole("dialog", { name: "Pane actions Chat 1" });
    expect(actions.id).toBe("pane-actions-pane:room:responsive:chat-1");
    expect(within(actions).queryAllByRole("button", { name: /^(Show|Hide) / })).toHaveLength(0);
    const disabledMove = within(actions).getByRole("button", { name: "Cannot move Chat 1 without another room" });
    expect((disabledMove as HTMLButtonElement).disabled).toBe(true);
    const keyboardButtons = within(actions)
      .getAllByRole("button")
      .filter((button) => !(button as HTMLButtonElement).disabled);
    expect(keyboardButtons).not.toContain(disabledMove);
    keyboardButtons.at(-1)!.focus();
    fireEvent.keyDown(keyboardButtons.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(keyboardButtons[0]);

    fireEvent.click(within(actions).getByRole("button", { name: "Manage goal" }));

    const goal = await screen.findByRole("dialog", { name: "Manage goal Chat 1" });
    const objective = within(goal).getByRole("textbox", { name: "Goal objective" });
    await waitFor(() => expect(document.activeElement).toBe(objective));
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.queryByRole("dialog", { name: "Pane actions Chat 1" })).toBeNull();
  });

  it("keeps the CLI floats toggle global across rooms and restores it from local storage", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    const fixture = installFetchFixture({
      role: "OPERATOR",
      rooms: [
        { id: "room:first", name: "First room" },
        { id: "room:second", name: "Second room" }
      ],
      panesByRoom: {
        "room:first": reviewPanes("room:first", 1),
        "room:second": reviewPanes("room:second", 1)
      }
    });

    // Preferences sync per user through /api/user-settings since fad8c85608; the toggle itself
    // still never writes room or pane state.
    const nonSettingsWrites = () => fixture.requestBodies.filter((request) => request.url !== "/api/user-settings");
    const nonSettingsFetchWrites = () => vi.mocked(fetch).mock.calls
      .filter(([url, init]) => (init?.method ?? "GET") !== "GET" && String(url) !== "/api/user-settings");
    const syncedCliFloats = (hidden: boolean) => fixture.requestBodies.some((request) =>
      request.url === "/api/user-settings" && (JSON.parse(request.body) as { cliFloatsHidden?: boolean }).cliFloatsHidden === hidden
    );

    const firstMount = render(<App />);
    expect(await screen.findByRole("heading", { name: "First room" })).toBeTruthy();
    expect(firstMount.container.querySelector(".space-shell")?.getAttribute("data-cli-floats-hidden")).toBe("false");

    fireEvent.click((await workspaceAction("Hide CLI floats")));

    expect(window.localStorage.getItem("space.cliFloatsHidden")).toBe("true");
    expect(within(await workspaceAction("Show CLI floats")).getByText("Off")).toBeTruthy();
    expect(firstMount.container.querySelector(".space-shell")?.getAttribute("data-cli-floats-hidden")).toBe("true");
    expect(nonSettingsWrites()).toHaveLength(0);
    expect(nonSettingsFetchWrites()).toHaveLength(0);
    await waitFor(() => expect(syncedCliFloats(true)).toBe(true));

    fireEvent.click(await workspaceAction("Next room"));
    expect(await screen.findByRole("heading", { name: "Second room" })).toBeTruthy();
    expect(within(await workspaceAction("Show CLI floats")).getByText("Off")).toBeTruthy();
    expect(nonSettingsWrites()).toHaveLength(0);
    expect(nonSettingsFetchWrites()).toHaveLength(0);

    firstMount.unmount();
    const secondMount = render(<App />);
    expect((await workspaceAction("Show CLI floats"))).toBeTruthy();
    expect(secondMount.container.querySelector(".space-shell")?.getAttribute("data-cli-floats-hidden")).toBe("true");

    fireEvent.click((await workspaceAction("Show CLI floats")));
    expect(window.localStorage.getItem("space.cliFloatsHidden")).toBe("false");
    expect(within(await workspaceAction("Hide CLI floats")).queryByText("Off")).toBeNull();
    expect(secondMount.container.querySelector(".space-shell")?.getAttribute("data-cli-floats-hidden")).toBe("false");
    expect(nonSettingsWrites()).toHaveLength(0);
    expect(nonSettingsFetchWrites()).toHaveLength(0);
    await waitFor(() => expect(syncedCliFloats(false)).toBe(true));
  });

  it("exposes all six system metrics in the narrow mobile room action sheet", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile");
    fireEvent.click(await workspaceAction("Resources"));
    const resources = await screen.findByRole("dialog", { name: "Resources" });
    expect(within(resources).getByRole("button", { name: "Close Resources" })).toBeTruthy();
    // The merged Resources overview (ecc0af72fb) groups account usage, CLI sessions, CPU/RAM and
    // latency into summary rows plus the alerts entry; the embedded view has no expand toggle.
    for (const metric of [/^AI usage/, /^Sessions/, /^System.*CPU.*RAM/, /^Connection/, /^(Alerts & thresholds|\d+ alerts? need attention|Some measurements are unavailable)$/]) {
      expect(within(resources).getByRole("button", { name: metric })).toBeTruthy();
    }
    expect(within(resources).getAllByRole("button").length).toBeGreaterThanOrEqual(6);
    expect(container.querySelector(".pane-card")).toBeTruthy();
  });

  it("keeps the title, metrics, and floating utility controls usable at 756px", async () => {
    setViewport(756, 844);
    installFetchFixture({
      roomName: "A very long room title that must truncate before it can move toolbar controls",
      panes: terminalPanes("room:responsive", 1),
    });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile");
    const toolbar = container.querySelector(".board-toolbar") as HTMLElement;
    expect(toolbar.querySelector(".board-title-row")).toBeTruthy();
    expect(within(toolbar).queryByRole("button", { name: "Resources" })).toBeNull();
    expect(await workspaceAction("Resources")).toBeTruthy();
    expect(toolbar.querySelector(".toolbar-actions-fixed")?.querySelectorAll("button")).toHaveLength(1);
    expect(toolbar.querySelector(".toolbar-actions-scroll")?.querySelector("button")).toBeTruthy();
  });

  it("keeps the selected mobile pane visible when another pane remains maximized", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toContain(".pane-grid.maximized .pane-card:not(.is-maximized)");
    expect(css).toContain('.space-shell[data-shell-mode="mobile"] .pane-grid.maximized .pane-card.is-target');
  });

  it("defines responsive upload preview sizing and equal circular badge tokens", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toContain("--terminal-upload-preview-size");
    expect(css).toContain("--terminal-upload-badge-size");
    expect(css).toContain("--terminal-upload-badge-offset");
    expect(css).toContain("grid-template-columns: repeat(auto-fit");
    expect(css).toContain(".terminal-stage .terminal-upload-index,\n.terminal-stage .terminal-upload-preview-picker .terminal-upload-preview-delete {");
    expect(css).toContain("width: var(--terminal-upload-badge-size);");
    expect(css).toContain("min-height: 0;");
    // Photo colors follow the active theme, accent and color mode; no per-mode copies.
    expect(css).toContain("--photo-accent: var(--modern-accent, var(--room-accent, #6db7aa));");
    expect(css).not.toMatch(/data-color-mode="light"[^{]*\.terminal-upload-/);
  });

  it("keeps the terminal model popover inside narrow pane containers", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toContain("right: var(--codex-model-popover-inline-end, calc(-36px - 0.5rem));");
    expect(css).toContain("width: min(21rem, calc(100cqw - 1.5rem));");
  });

  it("keeps cramped pane actions in a second toolbar row without a floating title", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toMatch(/\.pane-card \{[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);[\s\S]*?\}/);
    expect(css).toContain(".pane-card > header.is-actions-stacked");
    expect(css).toContain('"badge title fixed"');
    expect(css).toContain('"actions actions actions"');
    expect(css).toMatch(/\.pane-body \{[\s\S]*?grid-row: 2;[\s\S]*?\}/);
    expect(css).not.toContain(".pane-floating-title");
    expect(css).not.toContain("--pane-floating-title-offset");
    expect(css).not.toContain(".pane-card.is-title-floating");
    // Narrowed with operator approval (2026-10-11): styles.css now uses !important for unrelated
    // theme and state overrides (since 6fa32d43da); the pane header layout rules covered here must not.
    const paneHeaderRules = cssRulesFor(
      css,
      /^(?:\.space-shell(?:\[data-shell-mode="(?:mobile|tablet|desktop)"\]|\.shell-mobile)? )?(?:\.pane-card(?: > header\b.*)?$|\.pane-body$|\.pane-actions(?:-fixed)?\b|\.pane-header-identity\b)/
    );
    expect(paneHeaderRules.flatMap((rule) => rule.selectors)).toEqual(expect.arrayContaining([
      ".pane-card", ".pane-card > header", ".pane-card > header.is-actions-stacked", ".pane-body", ".pane-actions", ".pane-actions-fixed"
    ]));
    expect(paneHeaderRules.filter((rule) => rule.declarations.includes("!important")).map((rule) => rule.selectors.join(", "))).toEqual([]);
  });

  it("keeps one mobile pane full size with room controls and no layout toggle", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 2, 0) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    const paneGrid = container.querySelector(".pane-grid");
    expect(paneGrid?.classList.contains("maximized")).toBe(false);
    expect(paneGrid?.getAttribute("data-visible-pane-count")).toBe("1");
    expect(within(activePane).queryByRole("button", { name: "Maximize pane" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Grow pane width" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset pane width" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pane layout" })).toBeNull();
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(container.querySelector(".topbar")).toBeNull();
    expect(container.querySelectorAll(".space-brand-control")).toHaveLength(1);
  });

  it("switches the single mobile pane without persisting maximize changes", async () => {
    setViewport(390, 844);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("1");
    expect(container.querySelectorAll(".space-brand-control")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(screen.getByLabelText("CLI 1 agent 1")).toBe(activePane);
    fireEvent.touchStart(activePane.querySelector(".pane-title-block")!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(activePane.querySelector(".pane-title-block")!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("CLI 2 agent 2").getAttribute("data-shell-visible")).toBe("true"));
    expect(activePane.getAttribute("data-shell-visible")).toBe("false");
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMaximized"'))).toBe(false);
  });

  it("keeps exactly one logo while navigating mobile panes", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(container.querySelectorAll(".space-brand-control")).toHaveLength(1);
    fireEvent.touchStart(activePane.querySelector(".pane-title-block")!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(activePane.querySelector(".pane-title-block")!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("CLI 2 agent 2").getAttribute("data-shell-visible")).toBe("true"));
    expect(container.querySelector(".topbar")).toBeNull();
    expect(container.querySelectorAll(".space-brand-control")).toHaveLength(1);
  });

  it("keeps room chrome and one pane at a 744px mobile viewport", async () => {
    setViewport(744, 1698);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile");
    expect(container.querySelector(".board-toolbar")).toBeTruthy();

    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("1");
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(screen.getByLabelText("CLI 1 agent 1")).toBe(activePane);
    expect(within(activePane).queryByRole("button", { name: "Next pane" })).toBeNull();
    expect(within(activePane).queryByRole("button", { name: "Maximize pane" })).toBeNull();
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMaximized"'))).toBe(false);
  });

  it("preserves pane layout when the shell leaves mobile", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(within(activePane).queryByRole("button", { name: "Maximize pane" })).toBeNull();
    expect(container.querySelector(".board-toolbar")).toBeTruthy();

    setViewport(769, 844);

    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("tablet"));
    expect(container.querySelector(".space-shell")?.hasAttribute("data-mobile-pane-focus")).toBe(false);
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(within(activePane).getByRole("button", { name: "Maximize pane" })).toBeTruthy();
  });

  it("renders every shown room and pane toolbar action in mobile icon rows", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const pane = await screen.findByLabelText("CLI 1 agent 1");
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile");
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:responsive");

    expect(container.querySelectorAll(".toolbar-actions-scroll > button")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Workspace" })).toBeTruthy();
    for (const action of ["Open tasks", "Open Agent Files", "Open clipboard", "Workspace text size", "Resources", "On-screen keyboard", "Open settings dock"]) {
      expect(await workspaceAction(action)).toBeTruthy();
    }
    expect(screen.queryByRole("tab", { name: "Notes & widgets" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));

    expect(pane.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    expect(pane.querySelectorAll(".pane-actions-fixed button")).toHaveLength(2);
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions CLI 1" }));
    const paneSheet = await screen.findByRole("dialog", { name: "Pane actions CLI 1" });
    const paneSheetLabels = Array.from(paneSheet.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"));
    // CLI and Chat menus follow AGENT_PANE_ACTION_ORDER since 3b584b24c6: task actions, then
    // clipboard and files, then pane layout, with Reconnect last.
    expect(paneSheetLabels).toEqual([
      "Close Pane actions CLI 1",
      "New task CLI 1",
      "Stop CLI 1",
      "Enable Plan mode CLI 1",
      "Resume CLI 1",
      "Save CLI 1 to memory",
      "Copy CLI contents CLI 1",
      // Clipboard paste and file attachment actions were added in f682ca3742.
      "Paste into CLI CLI 1",
      "Attach clipboard as file CLI 1",
      "Import files CLI 1",
      "Add pane from CLI 1",
      "Cannot move CLI 1 without another room",
      "Reconnect CLI CLI 1"
    ]);
    fireEvent.click(within(paneSheet).getByRole("button", { name: "Close Pane actions CLI 1" }));
  });

  it("opens DeepSeek Harness as a dedicated Harness pane", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(await workspaceAction("Open DeepSeek Harness"));

    expect(await screen.findByLabelText("Harness 2 agent 2")).toBeTruthy();
    const paneCreate = fixture.requestBodies.find((request) => request.url === "/api/panes");
    expect(JSON.parse(paneCreate?.body ?? "{}")).toMatchObject({
      title: "Harness 2",
      mode: "HARNESS"
    });
    expect(fixture.requestBodies.some((request) => request.url.endsWith("/browser/session"))).toBe(false);
  });

  it("opens the standard pane menu from the Harness icon", async () => {
    setViewport(1440, 900);
    const harness = pane({
      id: "pane:harness-menu",
      roomId: "room:responsive",
      order: 0,
      title: "Harness Board",
      mode: "HARNESS"
    });
    const fixture = installFetchFixture({ panes: [harness] });
    render(<App />);

    const card = await screen.findByLabelText("Harness Board agent 1");
    fireEvent.contextMenu(card.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 32, clientY: 48 });
    const menu = await screen.findByRole("menu", { name: "Pane menu Harness Board" });
    expect(within(menu).getByRole("menuitem", { name: "Copy session info" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Edit pane title" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Generate pane title" })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Pane category color" })).toBeTruthy();

    fireEvent.click(within(menu).getByRole("button", { name: "Set category color purple" }));
    await waitFor(() => expect(fixture.requestBodies.some((request) =>
      request.url === "/api/panes/pane%3Aharness-menu" && request.body.includes('"categoryColor":"purple"')
    )).toBe(true));
  });

  it("routes on-screen keyboard input to the active CLI pane", async () => {
    setViewport(1280, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 2) });
    const terminalActions: unknown[] = [];
    const recordTerminalAction = (event: Event) => {
      if (event instanceof CustomEvent) terminalActions.push(event.detail);
    };
    window.addEventListener("space:terminal-pane-action", recordTerminalAction);

    render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.pointerDown(await screen.findByLabelText("CLI 2 agent 2"));
    fireEvent.click((await workspaceAction("On-screen keyboard")));
    const keyboard = await screen.findByRole("dialog", { name: "On-screen keyboard" });
    fireEvent.click(within(keyboard).getByRole("button", { name: "q" }));

    // The target CLI pane acknowledges each action it consumes with handled: true (ef3d77952e).
    expect(terminalActions).toContainEqual({ paneId: "pane:room:responsive:cli-2", action: "keyboard_input", text: "q", handled: true });
    // The CLI shortcuts bar is hidden behind its toggle by default (138dabb0d4).
    fireEvent.click(within(keyboard).getByRole("button", { name: "Show CLI shortcuts" }));
    for (const [label, commandId] of [["Plan mode", "plan"], ["Permissions", "permissions"]]) {
      fireEvent.click(within(keyboard).getByRole("button", { name: label }));
      expect(terminalActions).toContainEqual({ paneId: "pane:room:responsive:cli-2", action: "cli_shortcut", commandId, handled: true });
    }
    window.removeEventListener("space:terminal-pane-action", recordTerminalAction);
  });

  it("opens a single-image picker on mobile, treats cancel as a no-op, and routes the chosen image to the original CLI target", async () => {
    setViewport(390, 844);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia }
    });
    const terminalActions: unknown[] = [];
    const recordTerminalAction = (event: Event) => {
      if (event instanceof CustomEvent) terminalActions.push(event.detail);
    };
    window.addEventListener("space:terminal-pane-action", recordTerminalAction);

    const { container } = render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click((await railToolAction("Clip Tool")));

    const picker = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/png,image/jpeg,image/webp"]'
    );
    expect(picker).toBeTruthy();
    expect(picker?.multiple).toBe(false);
    fireEvent.change(picker!, { target: { files: [] } });
    expect(fixture.requests.some((request) => request.method === "POST" && request.url.includes("screen-capture"))).toBe(false);
    expect(fixture.requests.some((request) => request.method === "POST" && request.url.includes("file-uploads"))).toBe(false);
    expect(getDisplayMedia).not.toHaveBeenCalled();

    // Clip Tool ignores a new capture for 1.2 s after the previous one (555c3a5d2a).
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_300));
    });
    fireEvent.click((await railToolAction("Clip Tool")));
    const screenshot = new File(["data"], "phone-screen.png", { type: "image/png" });
    fireEvent.change(picker!, { target: { files: [screenshot] } });

    await waitFor(() =>
      expect(terminalActions).toContainEqual({
        paneId: "pane:room:responsive:cli-1",
        action: "attach_clip_image",
        file: screenshot,
        // The target CLI pane acknowledges the attachment (ef3d77952e).
        handled: true
      })
    );
    expect(picker?.value).toBe("");
    expect(fixture.requests.some((request) => request.method === "POST" && request.url.includes("screen-capture"))).toBe(false);
    window.removeEventListener("space:terminal-pane-action", recordTerminalAction);
  });

  it("uploads a tablet Clip Tool selection to chat attachments without submitting a prompt", async () => {
    setViewport(834, 1112);
    const fixture = installFetchFixture({ panes: chatPanes("room:responsive", 1) });
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia }
    });

    const { container } = render(<App />);
    const chat = await screen.findByLabelText("Chat 1 agent 1");
    fireEvent.click((await railToolAction("Clip Tool")));
    const picker = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/png,image/jpeg,image/webp"]'
    );
    const screenshot = new File(["data"], "tablet-screen.webp", { type: "image/webp" });
    fireEvent.change(picker!, { target: { files: [screenshot] } });

    expect(await within(chat).findByRole("img", { name: "screen.png" })).toBeTruthy();
    expect(fixture.requests).toContainEqual({
      method: "POST",
      url: "/api/artifacts/file-uploads?roomId=room%3Aresponsive&source=SCREEN_CAPTURE&paneId=pane%3Aroom%3Aresponsive%3Achat-1"
    });
    expect(fixture.requests.some((request) => request.url.includes("/agent/messages"))).toBe(false);
    expect(fixture.requests.some((request) => request.url.includes("screen-capture"))).toBe(false);
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("keeps desktop display capture, stops every media track, and avoids the server screen-capture fallback", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 1) });
    const stopVideo = vi.fn();
    const stopAudio = vi.fn();
    const stream = {
      getVideoTracks: () => [{ getSettings: () => ({ width: 12, height: 8 }) }],
      getTracks: () => [{ stop: stopVideo }, { stop: stopAudio }]
    };
    const getDisplayMedia = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["png"], { type: "image/png" }));
    });

    render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click((await railToolAction("Clip Tool")));

    await waitFor(() => expect(stopVideo).toHaveBeenCalledTimes(1));
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toContainEqual({
      method: "POST",
      url: "/api/artifacts/file-uploads?roomId=room%3Aresponsive&source=SCREEN_CAPTURE&paneId=pane%3Aroom%3Aresponsive%3A1"
    });
    expect(fixture.requests.some((request) => request.url.includes("screen-capture"))).toBe(false);
  });

  it("opens the image picker on Windows desktop when display capture is unavailable", async () => {
    setViewport(1440, 900);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {}
    });
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click((await railToolAction("Clip Tool")));
    const picker = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/png,image/jpeg,image/webp"]'
    );
    expect(picker).toBeTruthy();
    const screenshot = new File(["data"], "windows-screen.jpeg", { type: "image/jpeg" });
    fireEvent.change(picker!, { target: { files: [screenshot] } });

    await waitFor(() =>
      expect(fixture.requests).toContainEqual({
        method: "POST",
        url: "/api/artifacts/file-uploads?roomId=room%3Aresponsive&source=SCREEN_CAPTURE&paneId=pane%3Aroom%3Aresponsive%3A1"
      })
    );
    expect(fixture.requests.some((request) => request.url.includes("screen-capture"))).toBe(false);
  });

  it("opens dynamic links without creating panes or unmounting the current board", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const paneBeforeOpen = await screen.findByLabelText("Review 1 agent 1");
    const paneGridBeforeOpen = container.querySelector(".pane-grid");

    fireEvent.click((await workspaceAction("Show links")));
    for (const link of userLinks.filter((item) => item.openMode === "EMBEDDED")) {
      fireEvent.click(await screen.findByRole("button", { name: `Open ${link.title}` }));
      const dialog = await screen.findByRole("dialog", { name: link.title });
      expect(within(dialog).getByTitle(`${link.title} link`).getAttribute("src")).toBe(link.url);
      expect(screen.getByLabelText("Review 1 agent 1")).toBe(paneBeforeOpen);
      expect(container.querySelector(".pane-grid")).toBe(paneGridBeforeOpen);
      fireEvent.click(within(dialog).getByRole("button", { name: `Close ${link.title}` }));
    }

    const paneCreateRequests = vi.mocked(fetch).mock.calls.filter(([request, init]) => {
      const url = typeof request === "string" ? request : request.toString();
      return url === "/api/panes" && (init?.method ?? "GET") === "POST";
    });
    expect(paneCreateRequests).toHaveLength(0);
  });

  it("opens NEW_TAB links with protected window features instead of an iframe", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });
    const openedWindow = { opener: {} };
    const open = vi.spyOn(window, "open").mockReturnValue(openedWindow as unknown as Window);
    render(<App />);
    fireEvent.click((await workspaceAction("Show links")));
    fireEvent.click(await screen.findByRole("button", { name: "Open OpenAI Status" }));
    expect(open).toHaveBeenCalledWith("https://status.openai.com/", "_blank", "noopener,noreferrer");
    expect(openedWindow.opener).toBeNull();
    expect(screen.queryByRole("dialog", { name: "OpenAI Status" })).toBeNull();
  });

  it("keeps new Links actions visible and retires dashboard icons with an older saved toolbar order", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem(
      "space.roomToolbar.actionOrder.v3",
      JSON.stringify(["surface-rooms", "memory-workspace", "add-chat", "add-cli", "reload-room"])
    );
    window.localStorage.setItem("space.roomToolbar.hiddenActionIds.v3", JSON.stringify(["vibe-music"]));
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    render(<App />);

    expect((await workspaceAction("Show links"))).toBeTruthy();
    const music = (await workspaceAction("Music"));
    expect(music.closest(".desktop-menu-actions")).toBeTruthy();
    // Workspace actions explicitly opt out of native dragging (draggable="false").
    expect(music.getAttribute("draggable")).toBe("false");
    expect((await workspaceAction("Quick Links"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Headroom dashboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Codex LB dashboard" })).toBeNull();
    await waitFor(() => {
      const hidden = JSON.parse(window.localStorage.getItem("space.roomToolbar.hiddenActionIds.v3") ?? "[]") as string[];
      expect(hidden).not.toContain("vibe-music");
    });
  });

  it("preserves the add-cli slot and hidden preference while removing retired provider action IDs", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem(
      "space.roomToolbar.actionOrder.v3",
      JSON.stringify([
        "surface-rooms",
        "add-claude-code-cli",
        "add-cli",
        "add-opencode-cli",
        "reload-room",
        "add-kimi-code-cli"
      ])
    );
    window.localStorage.setItem(
      "space.roomToolbar.hiddenActionIds.v3",
      JSON.stringify(["add-cli", "add-claude-code-cli", "add-opencode-cli", "add-kimi-code-cli"])
    );
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    render(<App />);
    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add CLI pane" })).toBeNull();

    await waitFor(() => {
      const order = JSON.parse(window.localStorage.getItem("space.roomToolbar.actionOrder.v3") ?? "[]") as string[];
      const hidden = JSON.parse(window.localStorage.getItem("space.roomToolbar.hiddenActionIds.v3") ?? "[]") as string[];
      expect(order.indexOf("surface-rooms")).toBeLessThan(order.indexOf("add-cli"));
      expect(order.indexOf("add-cli")).toBeLessThan(order.indexOf("reload-room"));
      expect(hidden).toContain("add-cli");
      for (const retiredId of ["add-claude-code-cli", "add-opencode-cli", "add-kimi-code-cli"]) {
        expect(order).not.toContain(retiredId);
        expect(hidden).not.toContain(retiredId);
      }
    });
  });

  it("keeps live music connected while switching rooms and closing the player panel", async () => {
    setViewport(1440, 900);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    installFetchFixture({
      rooms: [
        { id: "room:music-source", name: "Music source" },
        { id: "room:music-target", name: "Music target" }
      ],
      panesByRoom: {
        "room:music-source": reviewPanes("room:music-source", 1),
        "room:music-target": reviewPanes("room:music-target", 1)
      }
    });

    const { container } = render(<App />);
    const musicButton = (await workspaceAction("Music"));
    fireEvent.click(musicButton);
    fireEvent.click(await screen.findByRole("button", { name: "Play Code Radio" }));
    await waitFor(() => expect(screen.getByText("Playing")).toBeTruthy());

    const audioBeforeSwitch = container.querySelector<HTMLAudioElement>("audio[data-vibe-music-audio]");
    expect(audioBeforeSwitch?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);
    fireEvent.click(screen.getByRole("button", { name: "Close Vibe Music" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Music target" }));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:music-target"));

    expect(container.querySelector("audio[data-vibe-music-audio]")).toBe(audioBeforeSwitch);
    expect(audioBeforeSwitch?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);
    fireEvent.click((await workspaceAction("Music")));
    expect(await screen.findByText("Playing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause Code Radio" }));
    expect(audioBeforeSwitch?.hasAttribute("src")).toBe(false);
  });

  it.each(["classic", "modern"])("keeps %s playback mounted through Help and never stacks Music with Quick Links", async (theme) => {
    window.localStorage.setItem("space.uiTheme.v1", theme);
    setViewport(1440, 900);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    const music = (await workspaceAction("Music"));
    // Quick Links, Music and Help open as pages of the Workspace menu (4d2bc9d1a4), so only one
    // of them is shown at a time while the music audio element stays mounted.
    fireEvent.click((await workspaceAction("Quick Links")));
    expect(await screen.findByRole("tabpanel", { name: "Quick Links" })).toBeTruthy();
    fireEvent.click(await workspaceAction("Music"));
    expect(screen.queryByRole("tabpanel", { name: "Quick Links" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Vibe Music" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play Code Radio" }));
    await waitFor(() => expect(screen.getByText("Playing")).toBeTruthy());
    const audio = container.querySelector<HTMLAudioElement>("audio[data-vibe-music-audio]");
    expect(audio?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);

    fireEvent.click(await workspaceAction("Help"));
    expect(await screen.findByRole("heading", { name: "Space Help" })).toBeTruthy();
    expect(container.querySelector("audio[data-vibe-music-audio]")).toBe(audio);
    expect(audio?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);

    fireEvent.click(screen.getByRole("button", { name: "Back to Space" }));
    const quickLinks = (await workspaceAction("Quick Links"));
    fireEvent.click(quickLinks);
    expect(await screen.findByRole("tabpanel", { name: "Quick Links" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Vibe Music" })).toBeNull();
    expect(audio?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);

    fireEvent.click((await workspaceAction("Music")));
    expect(await screen.findByRole("dialog", { name: "Vibe Music" })).toBeTruthy();
    act(() => {
      window.history.pushState({ spaceView: "help" }, "", "/help");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("heading", { name: "Space Help" })).toBeTruthy();
    window.history.replaceState({ spaceView: "workspace" }, "", "/");
    expect(screen.queryByRole("dialog", { name: "Vibe Music" })).toBeNull();
    expect(audio?.getAttribute("src")).toBe(CODE_RADIO_PRIMARY_STREAM_URL);
  });

  it("keeps the font-down preference slot while removing only the retired font-up action", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem(
      "space.roomToolbar.actionOrder.v3",
      JSON.stringify(["surface-rooms", "font-up", "font-down", "add-chat"])
    );
    window.localStorage.setItem(
      "space.roomToolbar.hiddenActionIds.v3",
      JSON.stringify(["font-up", "add-browser"])
    );
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect((await workspaceAction("Workspace text size"))).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Workspace text size" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Increase workspace text size" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decrease workspace text size" })).toBeNull();
    await waitFor(() => {
      const order = JSON.parse(window.localStorage.getItem("space.roomToolbar.actionOrder.v3") ?? "[]") as string[];
      const hidden = JSON.parse(window.localStorage.getItem("space.roomToolbar.hiddenActionIds.v3") ?? "[]") as string[];
      expect(order).toContain("font-down");
      expect(order).toContain("add-chat");
      expect(order).not.toContain("font-up");
      expect(hidden).toContain("add-browser");
      expect(hidden).not.toContain("font-up");
    });
  });

  it("rounds a legacy decimal text size and restores it across reloads", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.terminal.fontSize", "13.6");
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const firstRender = render(<App />);
    const firstPane = await screen.findByLabelText("CLI 1 agent 1");
    expect(firstPane.querySelector('[data-workspace-text-size="14"]')).toBeTruthy();
    expect((await workspaceAction("Workspace text size")).getAttribute("title")).toBe("Workspace text size: 14 px");
    await waitFor(() => expect(window.localStorage.getItem("space.terminal.fontSize")).toBe("14"));

    firstRender.unmount();
    render(<App />);
    const reloadedPane = await screen.findByLabelText("CLI 1 agent 1");
    expect(reloadedPane.querySelector('[data-workspace-text-size="14"]')).toBeTruthy();
  });

  it.each([
    ["desktop", 1440, 900],
    ["mobile", 390, 844]
  ])("keeps the %s embedded-link shell inside the viewport", async (_mode, width, height) => {
    setViewport(width, height);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    const { container } = render(<App />);
    fireEvent.click(await workspaceAction(_mode === "mobile" ? "Open links" : "Show links"));
    fireEvent.click(await screen.findByRole("button", { name: "Open Headroom" }));

    const dialog = await screen.findByRole("dialog", { name: "Headroom" });
    expect(dialog.classList.contains("embedded-dashboard-dialog")).toBe(true);
    // Links opened from the Workspace menu preview inside its portal (4d2bc9d1a4), outside the shell container.
    expect(dialog.querySelector(".embedded-dashboard-frame")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe(_mode);
  });

  it("switches between mobile CLI panes despite a previously maximized pane", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 3, 0) });

    const { container } = render(<App />);

    expect((await screen.findByLabelText("CLI 1 agent 1")).getAttribute("data-shell-visible")).toBe("true");
    let title = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(title!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("CLI 2 agent 2").getAttribute("data-shell-visible")).toBe("true"));
    expect(screen.getByLabelText("CLI 1 agent 1").getAttribute("data-shell-visible")).toBe("false");

    title = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(title!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("CLI 3 agent 3").getAttribute("data-shell-visible")).toBe("true"));
    expect(screen.getByLabelText("CLI 2 agent 2").getAttribute("data-shell-visible")).toBe("false");
  });

  it("uses a mobile action sheet with plain CLI actions while restoring trigger focus", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(screen.queryByLabelText("Reconnect CLI CLI 1")).toBeNull();

    const firstTrigger = screen.getByRole("button", { name: "More pane actions CLI 1" });
    fireEvent.click(firstTrigger);
    const firstSheet = await screen.findByRole("dialog", { name: "Pane actions CLI 1" });
    expect(within(firstSheet).queryByRole("button", { name: /(Hide|Show) Reconnect CLI/ })).toBeNull();
    expect(within(firstSheet).getByRole("button", { name: "Reconnect CLI CLI 1" })).toBeTruthy();
    fireEvent.click(within(firstSheet).getByRole("button", { name: "Close Pane actions CLI 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pane actions CLI 1" })).toBeNull());
    expect(document.activeElement).toBe(firstTrigger);

    const secondTrigger = screen.getByRole("button", { name: "More pane actions CLI 1" });
    fireEvent.click(secondTrigger);
    const secondSheet = await screen.findByRole("dialog", { name: "Pane actions CLI 1" });
    expect(within(secondSheet).getByRole("button", { name: "Reconnect CLI CLI 1" })).toBeTruthy();
    fireEvent.click(within(secondSheet).getByRole("button", { name: "Close Pane actions CLI 1" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pane actions CLI 1" })).toBeNull());
    expect(document.activeElement).toBe(secondTrigger);
  });

  it("keeps an overflowing mobile pane title inline without changing the icon row", async () => {
    setViewport(390, 844);
    const longTitle = "Investigate the very long CLI task title that cannot fit beside mobile pane controls";
    // Automatic task titles are shown as a bounded six-word summary (be883970e1).
    const headerTitle = "Investigate the very long CLI task";
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function offsetHeight(this: HTMLElement) {
      return this.tagName === "HEADER" && this.closest(".pane-card") ? 96 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 560 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 120 : 0;
    });
    installFetchFixture({
      panes: [
        pane({
          id: "pane:responsive:long-title",
          roomId: "room:responsive",
          order: 0,
          title: longTitle,
          mode: "TERMINAL"
        })
      ]
    });

    const { container } = render(<App />);

    const paneCard = await screen.findByLabelText(`${longTitle} agent 1`);
    expect(paneCard.classList.contains("is-mobile-title-floating")).toBe(false);
    expect(container.querySelector(".pane-floating-title")).toBeNull();
    expect(within(paneCard).getByText(headerTitle).classList.contains("pane-title-text")).toBe(true);
    expect(within(paneCard).queryByRole("button", { name: `Edit pane title ${longTitle}` })).toBeNull();
    expect(within(paneCard).getByRole("button", { name: `More pane actions ${longTitle}` })).toBeTruthy();
    // Mobile panes keep only More and Close in their fixed icon row (540a5b46a5).
    expect(within(paneCard).getByRole("button", { name: "Close pane" })).toBeTruthy();
    expect(within(paneCard).queryByRole("button", { name: "Maximize pane" })).toBeNull();
    const details = paneCard.querySelector("details.pane-title-details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await within(paneCard).findByRole("button", { name: "Rename" })).toBeTruthy();
    expect(within(paneCard).getAllByText(headerTitle)).toHaveLength(2);
    // The task details popover has no Close title button since be883970e1; Escape closes it.
    fireEvent.keyDown(within(paneCard).getByRole("region", { name: "Task details" }), { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector("summary"));
  });

  it("keeps an overflowing desktop pane title inline without hiding title tools", async () => {
    setViewport(1280, 900);
    const longTitle = "Investigate the very long CLI task title that cannot fit beside desktop pane controls";
    // Automatic task titles are shown as a bounded six-word summary (be883970e1).
    const headerTitle = "Investigate the very long CLI task";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 620 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 180 : 0;
    });
    installFetchFixture({
      panes: [
        pane({
          id: "pane:responsive:desktop-long-title",
          roomId: "room:responsive",
          order: 0,
          title: longTitle,
          mode: "TERMINAL"
        })
      ]
    });

    const { container } = render(<App />);

    const paneCard = await screen.findByLabelText(`${longTitle} agent 1`);
    await waitFor(() => expect(paneCard.classList.contains("is-title-floating")).toBe(false));
    expect(container.querySelector(".pane-floating-title")).toBeNull();
    expect(within(paneCard).getByText(headerTitle).classList.contains("pane-title-text")).toBe(true);
    expect(within(paneCard).getByRole("button", { name: `More pane actions ${longTitle}` })).toBeTruthy();
    expect(within(paneCard).queryByRole("button", { name: `Edit pane title ${longTitle}` })).toBeNull();
    expect(within(paneCard).queryByRole("button", { name: `Generate pane title with AI ${longTitle}` })).toBeNull();
  });

  it("keeps title tools visible when an overflowing pane title is remeasured", async () => {
    setViewport(1280, 900);
    const longTitle = "Investigate the very long CLI task title that used to flicker when title tools disappeared";
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 360 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (!this.classList?.contains("pane-title-text")) return 0;
      return this.closest(".pane-card")?.querySelector(".pane-actions-fixed") ? 180 : 440;
    });
    installFetchFixture({
      panes: [
        pane({
          id: "pane:responsive:flicker-title",
          roomId: "room:responsive",
          order: 0,
          title: longTitle,
          mode: "TERMINAL"
        })
      ]
    });

    render(<App />);

    const paneCard = await screen.findByLabelText(`${longTitle} agent 1`);
    expect(paneCard.classList.contains("is-title-floating")).toBe(false);
    fireEvent(window, new Event("resize"));
    expect(paneCard.classList.contains("is-title-floating")).toBe(false);
    expect(paneCard.querySelector(".pane-floating-title")).toBeNull();
    expect(within(paneCard).queryByRole("button", { name: `Edit pane title ${longTitle}` })).toBeNull();
    expect(within(paneCard).queryByRole("button", { name: `Generate pane title with AI ${longTitle}` })).toBeNull();
  });

  it("keeps a fitting mobile pane title inline", async () => {
    setViewport(390, 844);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 96 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 160 : 0;
    });
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const paneCard = await screen.findByLabelText("CLI 1 agent 1");
    await waitFor(() => expect(paneCard.classList.contains("is-mobile-title-floating")).toBe(false));
    expect(within(paneCard).getByText("CLI 1")).toBeTruthy();
    expect(container.querySelector(".pane-floating-title")).toBeNull();

    fireEvent.contextMenu(paneCard.querySelector(".pane-agent-badge") as HTMLElement, { clientX: 40, clientY: 80 });
    fireEvent.click(within(await screen.findByRole("menu", { name: "Pane menu CLI 1" })).getByRole("menuitem", { name: "Edit pane title" }));
    expect(within(paneCard).getByRole("textbox", { name: "Pane title" })).toBeTruthy();
    expect(container.querySelector(".pane-floating-title")).toBeNull();
  });

  it("keeps a fitting desktop pane title inline with compact fixed actions", async () => {
    setViewport(1280, 900);
    const title = "CLI compact header";
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 560;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      if (this.classList?.contains("pane-title-text")) return 200;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.closest(".pane-actions")) return 36;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function offsetHeight(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 84;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 148 : 0;
    });
    installFetchFixture({
      panes: [
        pane({
          id: "pane:responsive:stacked-header",
          roomId: "room:responsive",
          order: 0,
          title,
          mode: "TERMINAL"
        })
      ]
    });

    render(<App />);

    const paneCard = await screen.findByLabelText(`${title} agent 1`);
    expect(paneCard.querySelector("header")?.classList.contains("is-actions-stacked")).toBe(false);
    expect(paneCard.classList.contains("is-title-floating")).toBe(false);
    expect(paneCard.querySelector(".pane-floating-title")).toBeNull();
    expect(within(paneCard).getByText(title)).toBeTruthy();
    expect(paneCard.getAttribute("style")).not.toContain("--pane-floating-title-offset");
  });

  it("stacks a 520px pane header when its fixed controls consume the remaining inline space", async () => {
    setViewport(1440, 900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 520;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      if (this.classList?.contains("pane-title-text")) return 160;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.closest(".pane-actions")) return 36;
      if (this.tagName === "BUTTON" && this.closest(".pane-actions-fixed")) return 36;
      if (this.classList?.contains("pane-actions-overflow")) return 36;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 148 : 0;
    });
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });

    render(<App />);

    const paneCard = await screen.findByLabelText("Review 1 agent 1");
    await waitFor(() => expect(paneCard.querySelector("header")?.classList.contains("is-actions-stacked")).toBe(true));
    expect(paneCard.querySelector(".pane-actions-fixed")?.parentElement).toBe(paneCard.querySelector("header"));
    expect(paneCard.querySelectorAll(".pane-actions > button")).toHaveLength(6);
  });

  it("keeps an ordinary stacked desktop title in the upper row", async () => {
    setViewport(1432, 900);
    const title = "MCP DevTools History";
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function clientWidth(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 343;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      if (this.classList?.contains("pane-title-text")) return 259;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(this: HTMLElement) {
      if (this.tagName === "BUTTON" && this.closest(".pane-actions")) return 36;
      if (this.classList?.contains("pane-agent-badge")) return 32;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function offsetHeight(this: HTMLElement) {
      if (this.tagName === "HEADER" && this.closest(".pane-card")) return 134;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function scrollWidth(this: HTMLElement) {
      return this.classList?.contains("pane-title-text") ? 264 : 0;
    });
    installFetchFixture({
      panes: [
        pane({
          id: "pane:responsive:stacked-no-float",
          roomId: "room:responsive",
          order: 0,
          title,
          mode: "TERMINAL"
        })
      ]
    });

    render(<App />);

    const paneCard = await screen.findByLabelText(`${title} agent 1`);
    await waitFor(() => expect(paneCard.querySelector("header")?.classList.contains("is-actions-stacked")).toBe(true));
    expect(paneCard.classList.contains("is-title-floating")).toBe(false);
    expect(paneCard.querySelector(".pane-floating-title")).toBeNull();
    expect(within(paneCard).getByText(title)).toBeTruthy();
    expect(paneCard.getAttribute("style")).not.toContain("--pane-floating-title-offset");
  });

  it("stores the CLI photo preview limit from the mobile cli dock", async () => {
    setViewport(390, 844);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    fireEvent.click((await workspaceAction(/^(Open|Show) cli dock$/)));
    await openCliDockSection("Image previews");
    const limitInput = await screen.findByLabelText("CLI photo preview limit");
    expect((limitInput as HTMLInputElement).value).toBe("12");

    fireEvent.change(limitInput, { target: { value: "16" } });

    expect(window.localStorage.getItem("space.cliUpload.maxImagePreviews")).toBe("16");
    await waitFor(() => expect(fixture.requestBodies
      .filter(request => request.url === "/api/user-settings")
      .map(request => JSON.parse(request.body))
      .filter(body => Object.hasOwn(body, "cliImagePreviewLimit")))
      .toEqual([{ cliImagePreviewLimit: 16 }]));
  });

  it("persists the warm connected pane limit and shows the fixed warm-room capacity", async () => {
    setViewport(390, 844);
    window.localStorage.setItem("space.warmRoom.connectedPaneLimit.v1", "24");
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    fireEvent.click((await workspaceAction("Open cli dock")));
    await openCliDockSection("Room cache");
    const enabledToggle = await screen.findByRole("switch", { name: "Enable warm room cache" });
    expect((enabledToggle as HTMLInputElement).checked).toBe(true);
    const limitInput = screen.getByLabelText("Warm connected pane limit") as HTMLInputElement;
    expect(limitInput.value).toBe("24");
    fireEvent.change(limitInput, { target: { value: "32" } });
    expect(window.localStorage.getItem("space.warmRoom.connectedPaneLimit.v1")).toBe("32");

    fireEvent.click(enabledToggle);
    expect((enabledToggle as HTMLInputElement).checked).toBe(false);
    expect(window.localStorage.getItem("space.warmRoom.enabled.v1")).toBe("false");

    fireEvent.click(enabledToggle);
    expect((enabledToggle as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem("space.warmRoom.enabled.v1")).toBe("true");
  });

  it("opens the memory workspace across the whole shell window", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    fireEvent.click((await workspaceAction("Open memory workspace")));
    const workspace = await screen.findByRole("region", { name: "Memory workspace" });
    const workspaceRoot = workspace.parentElement as HTMLElement;

    expect(workspaceRoot.className).toBe("memory-workspace-root");
    // Updated with operator approval (2026-10-11) for b8125e6d3f: Memory covers the whole workspace
    // stage of the shell while the room workspace stays mounted, inert and hidden beneath it.
    const cover = workspaceRoot.parentElement as HTMLElement;
    const stage = cover.parentElement as HTMLElement;
    expect(cover.className).toBe("workspace-cover");
    expect(stage.className).toBe("workspace-stage");
    expect(stage.parentElement).toBe(container.querySelector(".space-shell"));
    const retainedWorkspace = stage.querySelector<HTMLElement>(":scope > section.workspace");
    expect(retainedWorkspace?.hasAttribute("inert")).toBe(true);
    expect(retainedWorkspace?.getAttribute("aria-hidden")).toBe("true");

    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.memory-workspace-root \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*display: flex;[^}]*flex-direction: column;[^}]*\}/s);
    expect(css).toMatch(/\.workspace-stage \{[^}]*position: relative;[^}]*flex: 1;[^}]*min-height: 0;[^}]*\}/s);
    expect(css).toMatch(/\.workspace-cover \{[^}]*position: absolute;[^}]*inset: 0;[^}]*display: flex;[^}]*flex-direction: column;[^}]*\}/s);
  });

  it("keeps the collapsed right rail options visible when memory workspace is open", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
    expect(container.querySelector(".room-toolbar-collapsed")).toBeTruthy();

    const toolsButton = screen.getByRole("button", { name: "Workspace tools" });
    fireEvent.click(toolsButton);
    const memoryButton = await screen.findByRole("button", { name: "Open memory workspace" });
    fireEvent.click(memoryButton);

    await waitFor(() => expect(container.querySelector(".memory-workspace-root")).toBeTruthy());
    expect(container.querySelector(".room-toolbar-collapsed")).toBeTruthy();
  });

  it.each([320, 768, 1024, 1440])("keeps Telegram setup accessible at %ipx", async (width) => {
    setViewport(width, width <= 768 ? 844 : 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    fireEvent.click((await workspaceAction(/^(Open|Show) settings dock$/)));
    await openSettingsSection("Telegram notifications");
    const telegramSettings = await screen.findByRole("region", { name: "Telegram notifications" });

    // The disclosure renders while the secure integration status is still loading.
    expect(await within(telegramSettings).findByText("Disconnected")).toBeTruthy();
    expect((within(telegramSettings).getByLabelText("Telegram bot token") as HTMLInputElement).type).toBe("password");
    expect(within(telegramSettings).getByRole("link", { name: "Open BotFather" })).toBeTruthy();
  });

  it("uses a dense two-column tablet shell for 6-pane rooms", async () => {
    setViewport(900, 1112);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function offsetHeight(this: HTMLElement) {
      return this.tagName === "HEADER" && this.closest(".pane-card") ? 72 : 0;
    });
    installFetchFixture({ panes: reviewPanes("room:responsive", 6) });

    const { container } = render(<App />);

    const firstPane = await screen.findByLabelText("Review 1 agent 1");
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("tablet");
    expect(firstPane.getAttribute("style")).not.toContain("--pane-floating-title-offset");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-density")).toBe("dense");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("6");
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(screen.queryByLabelText("Rooms")).toBeNull();
    expect(screen.queryByLabelText("Settings dock")).toBeNull();

    fireEvent.click((await workspaceAction("Open settings dock")));
    expect(await screen.findByLabelText("Settings dock")).toBeTruthy();
  });

  it("stacks all ten Modern PC panes at 768px without entering mobile focus", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    setViewport(768, 1112);
    installFetchFixture({ panes: terminalPanes("room:responsive", 10) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(await screen.findByLabelText("CLI 10 agent 10")).toBeTruthy();
    const shell = container.querySelector(".space-shell");
    const grid = container.querySelector(".pane-grid");
    expect(shell?.getAttribute("data-shell-mode")).toBe("tablet");
    expect(shell?.getAttribute("data-ui-theme")).toBe("modern");
    expect(shell?.hasAttribute("data-mobile-pane-focus")).toBe(false);
    expect(grid?.getAttribute("data-column-count")).toBe("1");
    expect(grid?.getAttribute("data-visible-pane-count")).toBe("10");
    expect(container.querySelectorAll("[data-space-pane-id]")).toHaveLength(10);
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect((await workspaceAction("Pane layout"))).toBeTruthy();
    expect(within(screen.getByLabelText("CLI 1 agent 1")).getByRole("button", { name: "Minimize pane CLI 1" })).toBeTruthy();
  });

  it.each([769, 1024])("keeps the Modern tablet pane grid two-column at %ipx", async (width) => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    setViewport(width, 1112);
    installFetchFixture({ panes: reviewPanes("room:responsive", 10) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("Review 10 agent 10")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("tablet");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("2");
    expect(container.querySelectorAll("[data-space-pane-id]")).toHaveLength(10);
  });

  it("contains stacked xterm surfaces inside pane bodies with stable internal scrolling", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toMatch(
      /\.space-shell\[data-shell-mode="tablet"\] \.pane-grid\[data-column-count="1"\] \{[^}]*grid-auto-rows: minmax\(28rem, auto\);/
    );
    expect(css).toMatch(/\.terminal-pane \{[^}]*min-height: 0;/);
    expect(css).toMatch(/\.pane-body \{[^}]*min-height: 0;[^}]*overflow: hidden;/);
    expect(css).toMatch(
      /\.terminal-viewport\.live \.terminal-xterm \.xterm-viewport \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;/
    );
  });

  it.each([
    { paneCount: 2, sideBySideColumns: 2 },
    { paneCount: 3, sideBySideColumns: 3 }
  ])("switches $paneCount panes between stacked and side-by-side layouts without creating panes", async ({ paneCount, sideBySideColumns }) => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", paneCount) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    const beforeIds = Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.spacePaneId);

    const layoutTrigger = (await workspaceAction("Pane layout"));
    fireEvent.click(layoutTrigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: `1 column, ${paneCount} visible panes, ${paneCount} rows` }));
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("1"));
    // The Pane layout tab stays open inside the Workspace menu (4d2bc9d1a4) after a choice;
    // Escape returns focus to the Workspace trigger.
    const layoutMenu = screen.getByRole("menu", { name: "Pane layout presets" });
    expect(within(layoutMenu).getByRole("menuitemradio", { name: `1 column, ${paneCount} visible panes, ${paneCount} rows` }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Workspace" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Workspace" })));
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.gridRowIndex)).toEqual(
      Array.from({ length: paneCount }, (_, index) => String(index))
    );

    fireEvent.click((await workspaceAction("Pane layout")));
    fireEvent.click(
      await screen.findByRole("menuitemradio", {
        name: `Automatic, ${paneCount} visible panes, 1 row`
      })
    );
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe(String(sideBySideColumns)));
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.gridRowIndex)).toEqual(
      Array.from({ length: paneCount }, () => "0")
    );
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.spacePaneId)).toEqual(beforeIds);
    expect(container.querySelectorAll("[data-space-pane-id]")).toHaveLength(paneCount);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/panes" && init?.method === "POST")).toBe(false);
    expect(fixture.requestBodies.filter((request) => request.url.endsWith("/pane-layout"))).toHaveLength(2);
  });

  it.each([
    { paneCount: 6, columns: 3, selectionLabel: "3 columns", paneLayoutColumns: 3, expectedRows: ["0", "0", "0", "1", "1", "1"] },
    { paneCount: 8, columns: 4, selectionLabel: "Automatic", paneLayoutColumns: null, expectedRows: ["0", "0", "0", "0", "1", "1", "1", "1"] },
    { paneCount: 16, columns: 4, selectionLabel: "Automatic", paneLayoutColumns: null, expectedRows: ["0", "0", "0", "0", "1", "1", "1", "1", "2", "2", "2", "2", "3", "3", "3", "3"] }
  ])("applies a $columns-column layout to $paneCount panes in row-major order", async ({ paneCount, columns, selectionLabel, paneLayoutColumns, expectedRows }) => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", paneCount) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    const beforeIds = Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.spacePaneId);
    fireEvent.pointerDown(screen.getByLabelText(`Review ${Math.min(2, paneCount)} agent ${Math.min(2, paneCount)}`));
    expect(screen.getByRole("button", { name: `Target Review ${Math.min(2, paneCount)}` }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click((await workspaceAction("Pane layout")));
    const option = await screen.findByRole("menuitemradio", {
      name: `${selectionLabel}, ${paneCount} visible panes, ${Math.ceil(paneCount / columns)} rows`
    });
    expect(within(option).getAllByTestId("pane-layout-preview-pane")).toHaveLength(paneCount);
    fireEvent.click(option);

    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe(String(columns)));
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.gridRowIndex)).toEqual(expectedRows);
    expect(Array.from(container.querySelectorAll<HTMLElement>("[data-space-pane-id]"), (element) => element.dataset.spacePaneId)).toEqual(beforeIds);
    expect(screen.getByRole("button", { name: `Target Review ${Math.min(2, paneCount)}` }).getAttribute("aria-pressed")).toBe("true");
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/panes" && init?.method === "POST")).toBe(false);
    expect(fixture.requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/api/rooms/room%3Aresponsive/pane-layout",
          // Preset selections also reset the height multiplier (6fa32d43da).
          body: JSON.stringify({ paneLayoutColumns, paneLayoutHeight: 1 })
        })
      ])
    );
  });

  it("applies the height multiplier to the pane grid without resetting column spans", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 4) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click((await workspaceAction("Pane layout")));
    await screen.findByRole("menu", { name: "Pane layout presets" });

    const height2Btn = screen.getByRole("button", { name: "Height 2" });
    fireEvent.click(height2Btn);

    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-pane-layout-height")).toBe("2"));
    expect(fixture.requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/api/rooms/room%3Aresponsive/pane-layout",
          body: JSON.stringify({ paneLayoutHeight: 2 })
        })
      ])
    );
    const grid = container.querySelector(".pane-grid") as HTMLElement;
    expect(grid.style.gridAutoRows).toMatch(/px$/);
    expect(grid.style.gridTemplateRows).toMatch(/^repeat\(/);
  });

  it("allows dragging a pane to reposition it next to another pane with edge drop indicators and empty slot support", async () => {
    setViewport(1440, 900);
    const topPane = pane({
      id: "pane:top",
      roomId: "room:responsive",
      order: 0,
      title: "Top CLI",
      mode: "TERMINAL",
      columnSpan: 1
    });
    const youtubePane = pane({
      id: "pane:youtube",
      roomId: "room:responsive",
      order: 1,
      title: "YouTube",
      mode: "YOUTUBE",
      columnSpan: 2
    });
    const bottomPane = pane({
      id: "pane:bottom",
      roomId: "room:responsive",
      order: 2,
      title: "Bottom CLI",
      mode: "TERMINAL",
      columnSpan: 1
    });
    const fixture = installFetchFixture({
      paneLayoutColumns: 2,
      panes: [topPane, youtubePane, bottomPane]
    });
    const { container } = render(<App />);

    await screen.findByLabelText("Top CLI agent 1");
    const bottomCard = container.querySelector('[data-space-pane-id="pane:bottom"]') as HTMLElement;
    const topCard = container.querySelector('[data-space-pane-id="pane:top"]') as HTMLElement;

    // Drag start from bottom card header
    const bottomHeader = bottomCard.querySelector("header") as HTMLElement;
    fireEvent.dragStart(bottomHeader);

    // Empty slot should now appear in the 2-column grid next to top card (row 0, col 2)
    await waitFor(() => expect(container.querySelectorAll(".pane-grid-drop-slot").length).toBeGreaterThan(0));

    const currentTopCard = container.querySelector('[data-space-pane-id="pane:top"]') as HTMLElement;
    vi.spyOn(currentTopCard, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      right: 600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => {}
    });

    // Drag over right half of top card indicates position 'after'
    const dragOverEvent = createEvent.dragOver(currentTopCard);
    Object.defineProperty(dragOverEvent, "clientX", { value: 500 });
    fireEvent(currentTopCard, dragOverEvent);

    expect(currentTopCard.classList.contains("is-drop-target")).toBe(true);
    expect(currentTopCard.getAttribute("data-drop-position")).toBe("after");

    // Drop on top card with 'after'
    fireEvent.drop(currentTopCard);

    // Expect API call with [topPane, bottomPane, youtubePane]
    await waitFor(() => {
      expect(fixture.requestBodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "/api/rooms/room%3Aresponsive/panes/reorder",
            body: JSON.stringify({ paneIds: ["pane:top", "pane:bottom", "pane:youtube"] })
          })
        ])
      );
    });
  });

  it("allows dragging a pane directly from its title text to an empty grid slot with column anchoring", async () => {
    setViewport(1440, 900);
    const topPane = pane({
      id: "pane:top",
      roomId: "room:responsive",
      order: 0,
      title: "Top CLI",
      mode: "TERMINAL",
      columnSpan: 1
    });
    const bottomPane = pane({
      id: "pane:bottom",
      roomId: "room:responsive",
      order: 1,
      title: "Bottom CLI",
      mode: "TERMINAL",
      columnSpan: 1
    });
    const fixture = installFetchFixture({
      paneLayoutColumns: 3,
      panes: [topPane, bottomPane]
    });
    const { container } = render(<App />);

    await screen.findByLabelText("Top CLI agent 1");
    const bottomCard = container.querySelector('[data-space-pane-id="pane:bottom"]') as HTMLElement;
    const titleText = bottomCard.querySelector(".pane-title-text") as HTMLElement;
    expect(titleText).toBeTruthy();

    // Drag start from bottom card title text (inside TaskTitleDetails summary)
    fireEvent.dragStart(titleText);

    // Empty slot should now appear in the 3-column grid
    await waitFor(() => expect(container.querySelectorAll(".pane-grid-drop-slot").length).toBeGreaterThan(0));

    const dropSlot = container.querySelector(".pane-grid-drop-slot") as HTMLElement;
    expect(dropSlot).toBeTruthy();

    // Drop onto empty slot
    fireEvent.drop(dropSlot);

    await waitFor(() => {
      expect(fixture.requestBodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "/api/rooms/room%3Aresponsive/panes/reorder"
          })
        ])
      );
    });
    expect(bottomCard.style.gridColumn).toContain("span 1");
  });

  it("applies the Fullscreen layout with one visible pane and header arrows that cycle panes", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 4) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click((await workspaceAction("Pane layout")));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Fullscreen, 4 visible panes, one at a time" }));

    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-fullscreen-layout")).toBe("true"));
    expect(container.querySelector(".pane-grid")?.getAttribute("data-pane-layout-columns")).toBe("0");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("1");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("1");
    expect(container.querySelectorAll<HTMLElement>('[data-shell-visible="true"]')).toHaveLength(1);
    expect(fixture.requestBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/api/rooms/room%3Aresponsive/pane-layout",
          body: JSON.stringify({ paneLayoutColumns: 0, paneLayoutHeight: 1 })
        })
      ])
    );

    const visiblePaneId = () =>
      container.querySelector<HTMLElement>('[data-shell-visible="true"]')?.getAttribute("data-space-pane-id") ?? null;
    const firstVisibleId = visiblePaneId();
    const firstVisibleIndex = Number(firstVisibleId?.split(":").pop());

    expect(container.querySelectorAll<HTMLElement>('[data-shell-visible="true"]')).toHaveLength(1);
    expect(screen.getByText(`${firstVisibleIndex} / 4`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next pane" }));
    const nextIndex = (firstVisibleIndex % 4) + 1;
    await waitFor(() => expect(visiblePaneId()).toBe(`pane:room:responsive:${nextIndex}`));
    expect(screen.getByText(`${nextIndex} / 4`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous pane" }));
    await waitFor(() => expect(visiblePaneId()).toBe(`pane:room:responsive:${firstVisibleIndex}`));
    expect(screen.getByText(`${firstVisibleIndex} / 4`)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous pane" }));
    const wrapIndex = firstVisibleIndex === 1 ? 4 : firstVisibleIndex - 1;
    await waitFor(() => expect(visiblePaneId()).toBe(`pane:room:responsive:${wrapIndex}`));
    expect(screen.getByText(`${wrapIndex} / 4`)).toBeTruthy();
  });

  it("navigates previous and next pane via horizontal swipe on the mobile pane title", async () => {
    setViewport(390, 844);
    installFetchFixture({ panes: reviewPanes("room:responsive", 4) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    const visiblePaneId = () =>
      container.querySelector<HTMLElement>('[data-shell-visible="true"]')?.getAttribute("data-space-pane-id") ?? null;

    expect(visiblePaneId()).toBe("pane:room:responsive:1");

    const titleBlock = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    expect(titleBlock).toBeTruthy();
    expect(titleBlock?.getAttribute("data-swipe-nav")).toBe("true");

    // Swipe left (finger moves right to left: start at 200, end at 100) -> navigate next
    fireEvent.touchStart(titleBlock!, {
      touches: [{ clientX: 200, clientY: 100 }]
    });
    fireEvent.touchEnd(titleBlock!, {
      changedTouches: [{ clientX: 100, clientY: 105 }]
    });

    await waitFor(() => expect(visiblePaneId()).toBe("pane:room:responsive:2"));

    // Swipe left again -> navigate to pane 3
    const pane3TitleBlock = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(pane3TitleBlock!, {
      touches: [{ clientX: 200, clientY: 100 }]
    });
    fireEvent.touchEnd(pane3TitleBlock!, {
      changedTouches: [{ clientX: 120, clientY: 100 }]
    });

    await waitFor(() => expect(visiblePaneId()).toBe("pane:room:responsive:3"));

    // Swipe right (finger moves left to right: start at 100, end at 200) -> navigate previous
    const pane2TitleBlock = container.querySelector<HTMLElement>('[data-shell-visible="true"] .pane-title-block');
    fireEvent.touchStart(pane2TitleBlock!, {
      touches: [{ clientX: 100, clientY: 100 }]
    });
    fireEvent.touchEnd(pane2TitleBlock!, {
      changedTouches: [{ clientX: 200, clientY: 100 }]
    });

    await waitFor(() => expect(visiblePaneId()).toBe("pane:room:responsive:2"));

    // Vertical swipe gesture should NOT trigger navigation
    fireEvent.touchStart(pane2TitleBlock!, {
      touches: [{ clientX: 100, clientY: 100 }]
    });
    fireEvent.touchEnd(pane2TitleBlock!, {
      changedTouches: [{ clientX: 110, clientY: 250 }]
    });

    // Still at pane 2
    expect(visiblePaneId()).toBe("pane:room:responsive:2");
  });

  it("defines touch-action pan-y and user-select none for swipeable pane titles", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toContain('.pane-title-block[data-swipe-nav="true"] {');
    expect(css).toContain("touch-action: pan-y;");
  });

  it("caps stored presets on tablet, preserves mobile focus, and restores Automatic responsive columns", async () => {
    setViewport(900, 1112);
    installFetchFixture({ paneLayoutColumns: 4, panes: reviewPanes("room:responsive", 6) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("2");
    fireEvent.click((await workspaceAction("Pane layout")));
    await screen.findByRole("menu", { name: "Pane layout presets" });
    expect(screen.queryByRole("menuitemradio", { name: "Automatic, 6 visible panes, 3 rows" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "4 columns, 6 visible panes, 3 rows" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "1 column, 6 visible panes, 6 rows" }));
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("1"));

    fireEvent.click((await workspaceAction("Pane layout")));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Automatic, 6 visible panes, 3 rows" }));
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-pane-layout-columns")).toBe("automatic"));
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("2");

    act(() => setViewport(1440, 900));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("desktop"));
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("4");

    act(() => setViewport(320, 720));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("mobile"));
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("1");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("1");
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(screen.queryByRole("group", { name: /Pane navigation/ })).toBeNull();
  });

  it("honors explicit one-column Modern layout at 1076px and restores responsive Automatic without recreating panes", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem("space.modern.iconPack.v1", "material-rounded");
    setViewport(1076, 720);
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0, paneLayoutColumns: 1 },
        { id: "room:beta", name: "Beta", order: 1, paneLayoutColumns: null }
      ],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 4),
        "room:beta": reviewPanes("room:beta", 2)
      }
    });
    const firstRender = render(<App />);
    const { container } = firstRender;

    await waitFor(() => expect(container.querySelector('[data-room-runtime-id="room:alpha"]')).toBeTruthy());
    const alphaRuntime = container.querySelector('[data-room-runtime-id="room:alpha"]')!;
    await within(alphaRuntime as HTMLElement).findByLabelText("Review 1 agent 1");
    const initialPaneIds = Array.from(
      alphaRuntime.querySelectorAll<HTMLElement>("[data-space-pane-id]"),
      (element) => element.dataset.spacePaneId
    );

    expect(container.querySelector(".space-shell")?.getAttribute("data-ui-theme")).toBe("modern");
    expect(container.querySelector(".space-shell")?.getAttribute("data-icon-pack")).toBe("material-rounded");
    await waitFor(() => expect(document.body.getAttribute("data-ui-theme")).toBe("modern"));
    expect(document.body.getAttribute("data-icon-pack")).toBe("material-rounded");
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("tablet");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("1");
    expect(Array.from(
      alphaRuntime.querySelectorAll<HTMLElement>("[data-space-pane-id]"),
      (element) => element.dataset.gridRowIndex
    )).toEqual(["0", "1", "2", "3"]);

    fireEvent.click((await workspaceAction("Pane layout")));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Automatic, 4 visible panes, 2 rows" }));
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-pane-layout-columns")).toBe("automatic"));
    expect(container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("2");
    expect(Array.from(
      alphaRuntime.querySelectorAll<HTMLElement>("[data-space-pane-id]"),
      (element) => element.dataset.gridRowIndex
    )).toEqual(["0", "0", "1", "1"]);
    expect(Array.from(
      alphaRuntime.querySelectorAll<HTMLElement>("[data-space-pane-id]"),
      (element) => element.dataset.spacePaneId
    )).toEqual(initialPaneIds);
    expect(alphaRuntime.querySelectorAll("[data-space-pane-id]")).toHaveLength(4);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/panes" && init?.method === "POST")).toBe(false);
    expect(fixture.requestBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: "/api/rooms/room%3Aalpha/pane-layout",
        body: JSON.stringify({ paneLayoutColumns: null, paneLayoutHeight: 1 })
      })
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous room" }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(container.querySelector('[data-room-runtime-id="room:alpha"] .pane-grid')?.getAttribute("data-column-count")).toBe("2");

    firstRender.unmount();
    const reloaded = render(<App />);
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(reloaded.container.querySelector(".pane-grid")?.getAttribute("data-pane-layout-columns")).toBe("automatic");
    expect(reloaded.container.querySelector(".pane-grid")?.getAttribute("data-column-count")).toBe("2");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    // Workspace categories follow the rail (c5a09f4a97); tab text also carries an action count.
    expect(within(screen.getByRole("dialog", { name: "Workspace" })).getAllByRole("tab").map(tab => tab.getAttribute("aria-label"))).toEqual([
      "Create", "Pane layout", "Room", "Docks", "Input & media", "Desktop widgets", "Utilities", "Quick toggles"
    ]);
    await waitFor(() => expect(window.localStorage.getItem("space.modern.toolbar.room.actionOrder.v1")).not.toBeNull());
    await waitFor(() => expect(window.localStorage.getItem("space.modern.toolbar.pane.REVIEW.actionOrder.v1")).not.toBeNull());
    expect(window.localStorage.getItem("space.roomToolbar.hiddenActionIds.v3")).toBeNull();
    expect(window.localStorage.getItem("space.roomToolbar.actionOrder.v3")).toBeNull();
    expect(window.localStorage.getItem("space.paneToolbar.actionOrder.REVIEW")).toBeNull();
  });

  it.each(["dark", "light"] as const)("persists a visible Modern %s room palette across the shell and body", async (appearance) => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem("space.modern.appearance.mode.v1", appearance);
    window.localStorage.setItem("space.room.theme", "contrast");
    setViewport(1024, 768);
    installFetchFixture({ panes: reviewPanes("room:responsive", 2) });
    const { container, unmount } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-theme")).toBe("contrast");
    fireEvent.click((await workspaceAction("Room theme")));
    const themeMenu = screen.getByRole("menu", { name: "Room theme options" });
    const copperOption = within(themeMenu).getByRole("menuitemradio", { name: "Copper" });
    fireEvent.pointerDown(copperOption);
    fireEvent.click(copperOption);

    expect(container.querySelector(".space-shell")?.getAttribute("data-room-theme")).toBe("copper");
    await waitFor(() => expect(document.body.getAttribute("data-room-theme")).toBe("copper"));
    expect(window.localStorage.getItem("space.room.theme")).toBe("copper");
    // The embedded Workspace theme picker (4d2bc9d1a4) stays open on selection and closes with Escape.
    expect(screen.getByRole("menuitemradio", { name: "Copper" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(screen.getByRole("menu", { name: "Room theme options" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Room theme options" })).toBeNull();

    unmount();
    expect(document.body.getAttribute("data-room-theme")).toBeNull();
  });

  it("keeps Modern pane actions beyond the primary limit executable from desktop overflow", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem(
      "space.modern.toolbar.pane.REVIEW.actionOrder.v1",
      JSON.stringify(["target", "add", "grow-width", "move", "reset-width"])
    );
    setViewport(768, 1112);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 2) });
    fixture.addRoom({ id: "room:other", name: "Other room" });
    render(<App />);

    const pane = await screen.findByLabelText("Review 1 agent 1");
    expect(within(pane).queryByRole("button", { name: "Move Review 1 to another room" })).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions Review 1" }));
    const overflow = await screen.findByRole("menu", { name: "Pane actions Review 1" });
    fireEvent.click(within(overflow).getByRole("menuitem", { name: "Move Review 1 to another room" }));

    expect(await screen.findByRole("dialog", { name: "Move pane to another room" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Pane actions Review 1" })).toBeNull();
  });

  it("keeps Modern CLI actions plain in More without restoring header icons", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem(
      "space.modern.toolbar.pane.sharedCodex.actionOrder.v1",
      JSON.stringify(["new-task", "import", "reconnect", "move", "resume"])
    );
    setViewport(768, 1112);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    render(<App />);

    const pane = await screen.findByLabelText("CLI 1 agent 1");
    expect(within(pane).queryByRole("button", { name: "Resume CLI 1" })).toBeNull();
    expect(pane.querySelectorAll(".pane-actions > button")).toHaveLength(0);
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions CLI 1" }));
    const overflow = await screen.findByRole("menu", { name: "Pane actions CLI 1" });
    expect(within(overflow).getByRole("menuitem", { name: "New task CLI 1" })).toBeTruthy();
    expect(within(overflow).getByRole("menuitem", { name: "Reconnect CLI CLI 1" })).toBeTruthy();
    // Operator-approved (2026-10-11): Resume CLI task opens the shared CLI task history again.
    expect((within(overflow).getByRole("menuitem", { name: "Resume CLI 1" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(overflow).queryAllByRole("menuitemcheckbox")).toHaveLength(0);
    expect(within(overflow).queryByRole("menuitem", { name: "Show Reconnect CLI CLI 1" })).toBeNull();
    expect(within(pane).queryByRole("button", { name: "Reconnect CLI CLI 1" })).toBeNull();
    const userOrder = ["new-task", "import", "reconnect", "move", "resume"];
    expect(
      (JSON.parse(window.localStorage.getItem("space.modern.toolbar.pane.sharedCodex.actionOrder.v1") ?? "[]") as string[])
        .filter((id) => userOrder.includes(id))
    ).toEqual(userOrder);
  });

  it("allows reordering pane action items in desktop overflow with drag and drop", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem(
      "space.modern.toolbar.pane.sharedCodex.actionOrder.v1",
      JSON.stringify(["new-task", "import", "reconnect", "move", "resume"])
    );
    setViewport(1200, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    render(<App />);

    const pane = await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions CLI 1" }));
    const overflow = await screen.findByRole("menu", { name: "Pane actions CLI 1" });

    const newTaskBtn = within(overflow).getByRole("menuitem", { name: "New task CLI 1" });
    const reconnectBtn = within(overflow).getByRole("menuitem", { name: "Reconnect CLI CLI 1" });
    const newTaskRow = newTaskBtn.closest(".icon-action-manager-row");
    const reconnectRow = reconnectBtn.closest(".icon-action-manager-row");
    expect(newTaskRow?.getAttribute("draggable")).toBe("true");
    expect(reconnectRow?.getAttribute("draggable")).toBe("true");

    fireEvent.dragStart(reconnectRow!, { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    const targetRow = within(overflow).getByRole("menuitem", { name: "New task CLI 1" }).closest(".icon-action-manager-row")!;
    const dragOverEv = createEvent.dragOver(targetRow);
    Object.assign(dragOverEv, { clientY: 5 });
    fireEvent(targetRow, dragOverEv);
    fireEvent.drop(targetRow);

    await waitFor(() => {
      const storedOrder = JSON.parse(
        window.localStorage.getItem("space.modern.toolbar.pane.sharedCodex.actionOrder.v1") ?? "[]"
      );
      expect((storedOrder as string[]).filter((id) => ["new-task", "import", "reconnect", "move", "resume"].includes(id)))
        .toEqual(["reconnect", "new-task", "import", "move", "resume"]);
    });
  });

  it("disables pane updates the API would reject while the pane's CLI runtime is switched off", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    setViewport(1600, 1000);
    onTestFinished(() => liveApi.resetCliRuntimeSettingsCache());
    liveApi.resetCliRuntimeSettingsCache();
    const updatedAt = "2026-10-11T00:00:00.000Z";
    installFetchFixture({
      panes: [
        pane({ id: "pane:gemini-off", roomId: "room:responsive", order: 0, title: "Gemini Off", mode: "TERMINAL", terminalRuntimeId: "cli:gemini" }),
        pane({ id: "pane:codex-on", roomId: "room:responsive", order: 1, title: "Codex On", mode: "TERMINAL", terminalRuntimeId: "cli:codex" })
      ],
      cliRuntimeSettings: {
        settings: cliToggleRuntimeIds.map((runtimeId) => ({ runtimeId, enabled: runtimeId !== "cli:gemini", vpnEnabled: false, updatedAt, updatedBy: null })),
        runtimes: [{ id: "cli:gemini", displayName: "Gemini CLI" }],
        vpnSupported: false,
        vpnApplications: [],
        checkedAt: updatedAt
      }
    });
    render(<App />);

    const geminiPane = await screen.findByLabelText("Gemini Off agent 1");
    await waitFor(() =>
      expect((within(geminiPane).getByRole("button", { name: "Minimize pane Gemini Off" }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect(within(geminiPane).getByRole("button", { name: "Minimize pane Gemini Off" }).getAttribute("title")).toBe("Enable Gemini CLI in Settings");
    expect((within(geminiPane).getByRole("button", { name: "Maximize pane" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(geminiPane).getByRole("button", { name: "More pane actions Gemini Off" }));
    const menu = await screen.findByRole("menu", { name: "Pane actions Gemini Off" });
    for (const name of ["Add pane from Gemini Off", "Grow pane width", "Maximize pane", "Minimize pane Gemini Off"]) {
      const item = within(menu).getByRole("menuitem", { name }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
    }
    expect(within(menu).getByRole("menuitem", { name: "Add pane from Gemini Off" }).getAttribute("title")).toBe("Enable Gemini CLI in Settings");
    fireEvent.keyDown(menu, { key: "Escape" });

    const codexPane = screen.getByLabelText("Codex On agent 2");
    expect((within(codexPane).getByRole("button", { name: "Minimize pane Codex On" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Add pane with the reason once the room holds its maximum of panes", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    setViewport(1600, 1000);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 16) });
    render(<App />);

    const pane = await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click(within(pane).getByRole("button", { name: "More pane actions CLI 1" }));
    const menu = await screen.findByRole("menu", { name: "Pane actions CLI 1" });
    const add = within(menu).getByRole("menuitem", { name: "Add pane from CLI 1" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toBe("This room already has the maximum of 16 panes.");
    fireEvent.click(add);
    expect(fixture.requests.filter((request) => request.method === "POST" && request.url === "/api/panes")).toHaveLength(0);
  });

  it("keeps the desktop CLI menu compact with window tiles, native key hints and a resettable order", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    setViewport(1200, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    const dispatched: Array<{ action?: string }> = [];
    const recordAction = (event: Event) => dispatched.push((event as CustomEvent<{ action?: string }>).detail);
    window.addEventListener("space:terminal-pane-action", recordAction);
    try {
      render(<App />);
      const pane = await screen.findByLabelText("CLI 1 agent 1");
      const openMenu = async () => {
        fireEvent.click(within(pane).getByRole("button", { name: "More pane actions CLI 1" }));
        return screen.findByRole("menu", { name: "Pane actions CLI 1" });
      };
      let menu = await openMenu();

      const quickActions = within(menu).getByRole("group", { name: "Quick actions" });
      expect(Array.from(quickActions.querySelectorAll(".icon-action-manager-quick-button")).map((button) => button.textContent)).toEqual([
        "Maximize",
        "Minimize"
      ]);
      expect(menu.querySelector(".icon-action-manager-section-label")).toBeNull();
      expect(menu.querySelector(".action-disabled-reason")).toBeNull();
      expect((within(menu).getByRole("menuitem", { name: "Resume CLI 1" }) as HTMLButtonElement).disabled).toBe(false);
      expect(within(menu).queryByRole("menuitem", { name: "Reset pane width" })).toBeNull();
      const actionIds = () => Array.from(menu.querySelectorAll<HTMLElement>("[data-action-id]")).map((item) => item.dataset.actionId);
      expect(actionIds()).toEqual([
        "new-task", "stop", "plan", "resume", "memory", "copy", "paste", "paste_file", "import", "add", "move", "grow-width", "reconnect"
      ]);
      const stop = within(menu).getByRole("menuitem", { name: "Stop CLI 1" });
      expect(stop.textContent).toBe("Stop taskEsc");
      expect(stop.classList.contains("is-danger")).toBe(true);
      expect(within(menu).getByRole("menuitem", { name: "Enable Plan mode CLI 1" }).querySelector("kbd")).toBeNull();
      expect(within(menu).queryByRole("menuitem", { name: "Reset order" })).toBeNull();

      // Before the CLI attaches, every item that needs a session is disabled and says why.
      const disabledReasons = Object.fromEntries(
        Array.from(menu.querySelectorAll<HTMLButtonElement>("[data-action-id]"))
          .filter((item) => item.disabled)
          .map((item) => [item.dataset.actionId, item.title])
      );
      expect(disabledReasons).toEqual({
        stop: "Attach a running CLI first. (Esc)",
        plan: "Attach a running CLI first.",
        memory: "Attach a running CLI first.",
        copy: "There is no CLI output to copy yet.",
        paste: "Attach a running CLI first.",
        paste_file: "Attach a running CLI first.",
        import: "Attach a running CLI first.",
        move: "Create another room before moving a pane",
        "grow-width": "Already uses the available columns. Choose a multi-column layout to grow this pane."
      });
      fireEvent.click(stop);
      expect(dispatched).toHaveLength(0);

      const firstItem = within(menu).getByRole("menuitem", { name: "New task CLI 1" });
      await waitFor(() => expect(document.activeElement).toBe(firstItem));
      fireEvent.keyDown(menu, { key: "ArrowUp", altKey: true });
      expect(document.activeElement).toBe(firstItem);
      within(menu).getByRole("menuitem", { name: "Add pane from CLI 1" }).focus();
      fireEvent.keyDown(menu, { key: "ArrowUp", altKey: true });
      await waitFor(() => expect(actionIds().indexOf("add")).toBeLessThan(actionIds().indexOf("import")));

      fireEvent.click(await within(menu).findByRole("menuitem", { name: "Reset order" }));
      await waitFor(() => expect(actionIds().indexOf("add")).toBeGreaterThan(actionIds().indexOf("import")));
      expect(within(menu).queryByRole("menuitem", { name: "Reset order" })).toBeNull();

      fireEvent.keyDown(menu, { key: "Tab" });
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane actions CLI 1" })).toBeNull());

      menu = await openMenu();
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Reconnect CLI CLI 1" }));
      expect(dispatched.at(-1)?.action).toBe("reconnect");
      expect(screen.queryByRole("menu", { name: "Pane actions CLI 1" })).toBeNull();
    } finally {
      window.removeEventListener("space:terminal-pane-action", recordAction);
    }
  });

  it("creates one empty room from Modern Light without blocking the rooms surface", async () => {
    window.localStorage.setItem("space.uiTheme.v1", "modern");
    window.localStorage.setItem("space.modern.appearance.mode.v1", "light");
    setViewport(768, 1112);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 2) });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    const roomsSurface = await screen.findByRole("dialog", { name: "Rooms" });
    const newRoomButton = within(roomsSurface).getByRole("button", { name: "New room" });

    fireEvent.click(newRoomButton);
    fireEvent.click(newRoomButton);

    await waitFor(() =>
      expect(fixture.requests.filter((request) => request.method === "POST" && request.url === "/api/rooms")).toHaveLength(1)
    );
    // Generated rooms use the fixed name sequence Alex, Bruno, Cleo… (e356cdad4d).
    expect(await within(roomsSurface).findByRole("button", { name: "Open Alex" })).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:new-1");
    expect(screen.getByRole("dialog", { name: "Rooms" })).toBeTruthy();
  });

  it("skips an already-used generated room name after rooms were deleted", async () => {
    setViewport(768, 1112);
    const fixture = installFetchFixture({
      // Generated rooms use the fixed name sequence Alex, Bruno, Cleo… (e356cdad4d); Bruno was deleted.
      rooms: [
        { id: "room:space", name: "Space" },
        { id: "room:alex", name: "Alex" },
        { id: "room:cleo", name: "Cleo" }
      ]
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Open rooms" }));
    const roomsSurface = await screen.findByRole("dialog", { name: "Rooms" });
    fireEvent.click(within(roomsSurface).getByRole("button", { name: "New room" }));

    await waitFor(() => expect(fixture.requestBodies).toContainEqual({
      url: "/api/rooms",
      body: JSON.stringify({ name: "Bruno", initialPaneCount: 0, projectPath: "/opt/spaceapp" })
    }));
    expect(await within(roomsSurface).findByRole("button", { name: "Open Bruno" })).toBeTruthy();
  });

  it("lets the current preset reset pane widths and maximize state while preserving minimized panes", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    installFetchFixture({
      paneLayoutColumns: 3,
      panes: [
        pane({ id: "pane:room:responsive:1", roomId: "room:responsive", order: 0, title: "Review 1", columnSpan: 2 }),
        pane({ id: "pane:room:responsive:2", roomId: "room:responsive", order: 1, title: "Review 2", isMaximized: true }),
        pane({ id: "pane:room:responsive:3", roomId: "room:responsive", order: 2, title: "Review 3", isMinimized: true })
      ]
    });
    const { container } = render(<App />);

    const paneOne = await screen.findByLabelText("Review 1 agent 1");
    expect(paneOne.getAttribute("data-stored-column-span")).toBe("2");
    expect(container.querySelector(".pane-grid")?.classList.contains("maximized")).toBe(true);
    fireEvent.click((await workspaceAction("Pane layout")));
    const currentPreset = await screen.findByRole("menuitemradio", { name: "3 columns, 2 visible panes, 1 row" });
    expect(currentPreset.getAttribute("aria-checked")).toBe("true");
    expect((currentPreset as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(currentPreset);

    await waitFor(() => expect(paneOne.getAttribute("data-stored-column-span")).toBe("1"));
    expect(container.querySelector(".pane-grid")?.classList.contains("maximized")).toBe(false);
    expect(screen.getByLabelText("Review 3 agent 3").getAttribute("data-minimized")).toBe("true");
  });

  it("keeps the menu open with a clear error after an API failure and closes it on outside click", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    installFetchFixture({ role: "OPERATOR", failPaneLayout: true, panes: reviewPanes("room:responsive", 3) });
    render(<><App /><button type="button">Outside control</button></>);

    await screen.findByLabelText("Review 1 agent 1");
    const trigger = (await workspaceAction("Pane layout"));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "2 columns, 3 visible panes, 2 rows" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Pane layout update failed");
    expect(screen.getByRole("menu", { name: "Pane layout presets" })).toBeTruthy();

    // The presets live in the Workspace menu (4d2bc9d1a4), which closes on an outside press
    // without pulling focus back from the pressed element.
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    fireEvent.pointerDown(outside);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Pane layout presets" })).toBeNull());
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Workspace" }).getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(outside);
  });

  it("grows a desktop pane across adjacent columns and resets it to one column", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 3) });

    render(<App />);

    const paneOne = await screen.findByLabelText("Review 1 agent 1");
    const paneTwo = screen.getByLabelText("Review 2 agent 2");
    const paneThree = screen.getByLabelText("Review 3 agent 3");

    expect(screen.getAllByRole("button", { name: "Grow pane width" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Reset pane width" })).toHaveLength(3);
    expect(paneOne.getAttribute("data-column-span")).toBe("1");
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");

    fireEvent.click(within(paneOne).getByRole("button", { name: "Grow pane width" }));
    await waitFor(() => expect(paneOne.getAttribute("data-column-span")).toBe("2"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("3");

    fireEvent.click(within(paneOne).getByRole("button", { name: "Grow pane width" }));
    await waitFor(() => expect(paneOne.getAttribute("data-column-span")).toBe("3"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneTwo.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("1");
    expect((within(paneOne).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(paneOne).getByRole("button", { name: "Reset pane width" }));
    await waitFor(() => expect(paneOne.getAttribute("data-column-span")).toBe("1"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("0");
    expect(
      fixture.requestBodies.filter(
        (request) =>
          request.url.startsWith("/api/panes/pane%3Aroom%3Aresponsive%3A1") && request.body.includes("\"columnSpan\":")
      )
    ).toHaveLength(3);
  });

  it("toggles a desktop pane between one and two columns on badge double-click", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 3) });

    render(<App />);

    const paneOne = await screen.findByLabelText("Review 1 agent 1");
    const paneTwo = screen.getByLabelText("Review 2 agent 2");
    const paneThree = screen.getByLabelText("Review 3 agent 3");
    const badge = paneOne.querySelector(".pane-agent-badge") as HTMLElement;

    expect(paneOne.getAttribute("data-column-span")).toBe("1");
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");

    fireEvent.doubleClick(badge);
    await waitFor(() => expect(paneOne.getAttribute("data-column-span")).toBe("2"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("3");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("1");

    fireEvent.doubleClick(badge);
    await waitFor(() => expect(paneOne.getAttribute("data-column-span")).toBe("1"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("3");

    const columnSpanRequests = fixture.requestBodies.filter(
      (request) =>
        request.url.startsWith("/api/panes/pane%3Aroom%3Aresponsive%3A1") && request.body.includes("\"columnSpan\":")
    );
    expect(columnSpanRequests).toHaveLength(2);
    expect(columnSpanRequests[0]!.body).toContain("\"columnSpan\":2");
    expect(columnSpanRequests[1]!.body).toContain("\"columnSpan\":1");
  });

  it("keeps a pane at one column when the room has a single-column grid", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({
      paneLayoutColumns: 1,
      panes: reviewPanes("room:responsive", 2)
    });

    render(<App />);

    const paneOne = await screen.findByLabelText("Review 1 agent 1");
    const badge = paneOne.querySelector(".pane-agent-badge") as HTMLElement;

    expect(paneOne.getAttribute("data-column-span")).toBe("1");
    fireEvent.doubleClick(badge);
    await waitFor(() => {
      expect(
        fixture.requestBodies.filter(
          (request) =>
            request.url.startsWith("/api/panes/pane%3Aroom%3Aresponsive%3A1") && request.body.includes("\"columnSpan\":")
        )
      ).toHaveLength(0);
    });
    expect(paneOne.getAttribute("data-column-span")).toBe("1");
  });

  it("keeps a middle desktop pane anchored while it grows and lets later panes reflow around it", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 4) });

    render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    const paneTwo = screen.getByLabelText("Review 2 agent 2");
    const paneThree = screen.getByLabelText("Review 3 agent 3");
    const paneFour = screen.getByLabelText("Review 4 agent 4");

    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("3");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("4");

    fireEvent.click(within(paneTwo).getByRole("button", { name: "Grow pane width" }));
    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("2"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("4");
    expect(paneFour.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("1");

    fireEvent.click(within(paneTwo).getByRole("button", { name: "Grow pane width" }));
    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("3"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneFour.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("2");
    expect((within(paneTwo).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(paneTwo).getByRole("button", { name: "Reset pane width" }));
    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("1"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("3");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("4");
    expect(paneFour.getAttribute("data-grid-row-index")).toBe("0");
    expect((within(paneTwo).getByRole("button", { name: "Reset pane width" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      fixture.requestBodies.filter(
        (request) =>
          request.url.startsWith("/api/panes/pane%3Aroom%3Aresponsive%3A2") && request.body.includes("\"columnSpan\":")
      )
    ).toHaveLength(3);
  });

  it("keeps a persisted two-column desktop pane growable to three columns after reload", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({
      panes: [
        pane({ id: "pane:room:responsive:1", roomId: "room:responsive", order: 0, title: "Review 1" }),
        pane({ id: "pane:room:responsive:2", roomId: "room:responsive", order: 1, title: "Review 2", columnSpan: 2 }),
        pane({ id: "pane:room:responsive:3", roomId: "room:responsive", order: 2, title: "Review 3" }),
        pane({ id: "pane:room:responsive:4", roomId: "room:responsive", order: 3, title: "Review 4" })
      ]
    });

    render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    const paneTwo = screen.getByLabelText("Review 2 agent 2");
    const paneThree = screen.getByLabelText("Review 3 agent 3");
    const paneFour = screen.getByLabelText("Review 4 agent 4");
    const growButton = within(paneTwo).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement;

    expect(paneTwo.getAttribute("data-column-span")).toBe("2");
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneTwo.getAttribute("data-grid-row-index")).toBe("0");
    expect(growButton.disabled).toBe(false);
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("4");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("0");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneFour.getAttribute("data-grid-row-index")).toBe("1");

    fireEvent.click(growButton);

    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("3"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneTwo.getAttribute("data-grid-row-index")).toBe("0");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneFour.getAttribute("data-grid-column-start")).toBe("2");
    expect(paneFour.getAttribute("data-grid-row-index")).toBe("1");
    expect(growButton.disabled).toBe(false);
    fireEvent.click(growButton);
    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("4"));
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneTwo.getAttribute("data-grid-row-index")).toBe("1");
    expect(growButton.disabled).toBe(true);
    expect(
      fixture.requestBodies.filter(
        (request) =>
          request.url.startsWith("/api/panes/pane%3Aroom%3Aresponsive%3A2") && request.body.includes("\"columnSpan\":3")
      )
    ).toHaveLength(1);
  });

  it("keeps pane growth available at the end of a row and wraps the grown pane below", async () => {
    setViewport(900, 1112);
    installFetchFixture({ panes: reviewPanes("room:responsive", 3) });

    render(<App />);

    const paneOne = await screen.findByLabelText("Review 1 agent 1");
    const paneTwo = screen.getByLabelText("Review 2 agent 2");
    const paneThree = screen.getByLabelText("Review 3 agent 3");

    expect((within(paneOne).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(paneTwo).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement).disabled).toBe(false);
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("1");

    fireEvent.click(within(paneTwo).getByRole("button", { name: "Grow pane width" }));
    await waitFor(() => expect(paneTwo.getAttribute("data-column-span")).toBe("2"));
    expect((within(paneTwo).getByRole("button", { name: "Grow pane width" }) as HTMLButtonElement).disabled).toBe(true);
    expect(paneTwo.getAttribute("data-grid-row-index")).toBe("1");
    expect(paneTwo.getAttribute("data-grid-column-start")).toBe("1");
    expect(paneThree.getAttribute("data-grid-row-index")).toBe("0");
    expect(paneThree.getAttribute("data-grid-column-start")).toBe("2");
  });

  it("fills the first available desktop grid gap when a new CLI pane is added", async () => {
    setViewport(900, 1112);
    installFetchFixture({
      panes: [
        pane({ id: "pane:room:responsive:1", roomId: "room:responsive", order: 0, title: "Review 1" }),
        pane({ id: "pane:room:responsive:2", roomId: "room:responsive", order: 1, title: "Review 2" }),
        pane({ id: "pane:room:responsive:3", roomId: "room:responsive", order: 2, title: "Review 3" }),
        pane({ id: "pane:room:responsive:4", roomId: "room:responsive", order: 3, title: "Review 4", columnSpan: 2 })
      ]
    });

    render(<App />);

    const fullWidthPane = await screen.findByLabelText("Review 4 agent 4");
    expect(fullWidthPane.getAttribute("data-grid-row-index")).toBe("2");
    expect(fullWidthPane.getAttribute("data-grid-column-start")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const launcher = await screen.findByRole("dialog", { name: "Create" });
    fireEvent.click(await within(launcher).findByRole("button", { name: "Add Codex CLI" }));

    const newPane = await screen.findByLabelText("CLI 5 agent 5");
    expect(newPane.getAttribute("data-grid-row-index")).toBe("1");
    expect(newPane.getAttribute("data-grid-column-start")).toBe("2");
  });

  it("keeps the left surface controls available with a saved desktop room focus preference", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.roomFocusMode", "true");
    window.sessionStorage.setItem("space.selectedRoomId", "room:responsive");
    installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(document.querySelector(".space-shell")?.classList.contains("room-focus-mode")).toBe(true);
    expect(screen.getByLabelText("Rooms")).toBeTruthy();
    // Health is no longer a dock (5aa3a6fdc4); the other left-surface docks stay reachable.
    expect(await workspaceAction(/^(Open|Show) media dock$/)).toBeTruthy();
    expect(screen.queryByText("Space agent room control plane")).toBeNull();
    expect(screen.getByRole("button", { name: "Play Space logo animation" })).toBeTruthy();
    expect(document.querySelector(".board-title-row .space-brand-control")).toBeTruthy();
  });

  it("remembers a saved desktop room focus preference after remount", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.roomFocusMode", "true");
    window.sessionStorage.setItem("space.selectedRoomId", "room:responsive");
    installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    const firstRender = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(document.querySelector(".space-shell")?.classList.contains("room-focus-mode")).toBe(true);
    expect(window.localStorage.getItem("space.roomFocusMode")).toBe("true");

    firstRender.unmount();
    render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(document.querySelector(".space-shell")?.classList.contains("room-focus-mode")).toBe(true);
  });

  it("keeps desktop pane maximize server-backed", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: terminalPanes("room:responsive", 2) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click(within(activePane).getByRole("button", { name: "Maximize pane" }));

    await waitFor(() => expect(activePane.classList.contains("is-maximized")).toBe(true));
    expect(within(activePane).getByRole("button", { name: "Restore pane" }).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".pane-grid")?.classList.contains("maximized")).toBe(true);
    expect(container.querySelector(".space-shell")?.hasAttribute("data-mobile-pane-focus")).toBe(false);
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMaximized":true'))).toBe(true);
  });

  it("fits a maximized desktop pane to one grid row instead of every layout row", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      paneLayoutColumns: 2,
      panes: reviewPanes("room:responsive", 8).map((entry, index) => ({ ...entry, isMaximized: index === 1 }))
    });
    const { container } = render(<App />);

    const maximizedPane = await screen.findByLabelText("Review 2 agent 2");
    const grid = container.querySelector(".pane-grid") as HTMLElement;
    expect(grid.classList.contains("maximized")).toBe(true);
    expect(grid.style.gridTemplateRows).toBe("minmax(0, 1fr)");

    fireEvent.click(within(maximizedPane).getByRole("button", { name: "Restore pane" }));

    await waitFor(() => expect(grid.classList.contains("maximized")).toBe(false));
    expect(grid.style.gridTemplateRows).toMatch(/^repeat\(4, \d+px\)$/);
  });

  it("treats only a maximized desktop pane as shell-visible and terminal-output writable", async () => {
    setViewport(1440, 900);
    const panes = terminalPanes("room:responsive", 3, 0);
    installFetchFixture({ panes });

    expect(shellVisiblePaneIds(panes, panes[0]!.id, "desktop")).toEqual([panes[0]!.id]);

    render(<App />);

    const maximizedPane = await screen.findByLabelText("CLI 1 agent 1");
    const hiddenPaneTwo = await screen.findByLabelText("CLI 2 agent 2");
    const hiddenPaneThree = await screen.findByLabelText("CLI 3 agent 3");
    expect(maximizedPane.getAttribute("data-shell-visible")).toBe("true");
    expect(maximizedPane.getAttribute("data-terminal-output-state")).toBe("writable");
    expect(hiddenPaneTwo.getAttribute("data-shell-visible")).toBe("false");
    expect(hiddenPaneTwo.getAttribute("data-terminal-output-state")).toBe("buffering");
    expect(hiddenPaneThree.getAttribute("data-shell-visible")).toBe("false");
    expect(hiddenPaneThree.getAttribute("data-terminal-output-state")).toBe("buffering");
  });

  it("keeps desktop actions discoverable despite legacy hidden preferences", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.roomToolbar.hiddenActionIds.v3", JSON.stringify(["surface-settings"]));
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });
    render(<App />);
    await screen.findByLabelText("CLI 1 agent 1");
    const { trigger, menu } = await openDesktopMenu("Workspace");
    // The Settings tab was removed; the Settings dock is listed under Docks (02b7726406, c5a09f4a97).
    fireEvent.click(within(menu).getByRole("tab", { name: "Docks" }));
    expect(within(menu).getByRole("button", { name: "Show settings dock" })).toBeTruthy();
    fireEvent.change(within(menu).getByRole("textbox"), { target: { value: "settings" } });
    expect(within(menu).getByRole("button", { name: "Show settings dock" })).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("dialog", { name: "Find an action" })).toBeNull();
  });

  it("keeps room utility controls in a compact floating group and pane controls in their headers", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const pane = await screen.findByLabelText("CLI 1 agent 1");
    const paneFixedControls = pane.querySelector(".pane-actions-fixed");
    expect(paneFixedControls).toBeTruthy();
    expect(within(paneFixedControls as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "More pane actions CLI 1",
      "Maximize pane",
      "Minimize pane CLI 1",
      "Close pane"
    ]);

    const roomFixedControls = container.querySelector(".toolbar-actions-fixed");
    expect(roomFixedControls).toBeTruthy();
    expect(roomFixedControls?.classList.contains("room-toolbar-floating-controls")).toBe(false);
    expect(roomFixedControls?.getAttribute("aria-label")).toBe("Room utility controls");
    expect(within(roomFixedControls as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Hide room toolbar"
    ]);
    expect(container.querySelector(".topbar")?.querySelector('[aria-label="Sign out"]')).toBeFalsy();

    for (const surface of [pane.querySelector("header"), roomFixedControls]) {
      const iconNames = Array.from(surface?.querySelectorAll("button > svg") ?? []).map((icon) =>
        Array.from(icon.classList).find((className) => className.startsWith("lucide-") && className !== "lucide")
      );
      expect(iconNames.every(Boolean)).toBe(true);
      const duplicateIconNames = [...new Set(iconNames.filter((iconName, index) => iconNames.indexOf(iconName) !== index))];
      expect(duplicateIconNames).toEqual([]);
    }
  });

  it("hides the room toolbar without remounting the active pane and restores it from the bottom-right float", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    const activePane = await screen.findByLabelText("CLI 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));

    expect(container.querySelector(".board-toolbar")).toBeNull();
    const hiddenToolbarControl = screen.getByRole("region", { name: "Room toolbar hidden" });
    expect(hiddenToolbarControl.classList.contains("room-toolbar-floating-controls")).toBe(true);
    expect(screen.getByRole("button", { name: "Show room toolbar" })).toBeTruthy();
    expect(screen.getByLabelText("CLI 1 agent 1")).toBe(activePane);
    expect(within(activePane).getByRole("button", { name: "Maximize pane" })).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-toolbar-hidden")).toBe("true");
    expect(window.localStorage.getItem("space.roomToolbar.hidden.v1")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Show room toolbar" }));

    expect(container.querySelector(".board-toolbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide room toolbar" })).toBeTruthy();
    expect(screen.getByLabelText("CLI 1 agent 1")).toBe(activePane);
    expect(container.querySelector(".space-shell")?.hasAttribute("data-room-toolbar-hidden")).toBe(false);
    expect(window.localStorage.getItem("space.roomToolbar.hidden.v1")).toBe("false");
  });

  it("restores a room toolbar that starts hidden from the saved browser preference", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.roomToolbar.hidden.v1", "true");
    installFetchFixture({ panes: terminalPanes("room:responsive", 1) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("CLI 1 agent 1")).toBeTruthy();
    expect(container.querySelector(".board-toolbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show room toolbar" }));
    expect(container.querySelector(".board-toolbar")).toBeTruthy();
  });

  it("offers fixed minimize controls for every pane mode on desktop", async () => {
    setViewport(1440, 900);
    const modes: Pane["mode"][] = ["CHAT", "CODE", "BROWSER", "REVIEW", "SWARM", "DESIGN", "TERMINAL", "YOUTUBE"];
    installFetchFixture({
      panes: modes.map((mode, index) =>
        pane({
          id: `pane:room:responsive:${mode.toLowerCase()}`,
          roomId: "room:responsive",
          order: index,
          title: mode === "TERMINAL" ? "CLI mode" : `${mode} mode`,
          mode
        })
      )
    });

    render(<App />);

    for (const [index, mode] of modes.entries()) {
      const title = mode === "TERMINAL" ? "CLI mode" : `${mode} mode`;
      const paneCard = await screen.findByLabelText(`${title} agent ${index + 1}`);
      expect(within(paneCard).getByRole("button", { name: `Minimize pane ${title}` })).toBeTruthy();
    }
  });

  it("keeps minimized panes mounted, selects the next pane, and restores focus after the pane becomes visible", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: reviewPanes("room:responsive", 2) });
    const { container } = render(<App />);

    const firstPane = await screen.findByLabelText("Review 1 agent 1");
    const secondPane = screen.getByLabelText("Review 2 agent 2");
    fireEvent.click(within(firstPane).getByRole("button", { name: "Minimize pane Review 1" }));

    // The bar is parked, so the float toggle is the restore affordance that takes focus.
    const toggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    await waitFor(() => expect(firstPane.classList.contains("is-minimized")).toBe(true));
    expect(container.querySelector('[data-space-pane-id="pane:room:responsive:1"]')).toBe(firstPane);
    expect(firstPane.getAttribute("aria-hidden")).toBe("true");
    expect(secondPane.classList.contains("is-target")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(toggle));

    fireEvent.click(toggle);
    const restoreItem = await screen.findByRole("button", { name: "Restore pane Review 1" });
    expect(restoreItem.getAttribute("title")).toBe("Review 1");

    const restoredHeader = firstPane.querySelector<HTMLElement>("header")!;
    const focusRestoredHeader = restoredHeader.focus.bind(restoredHeader);
    vi.spyOn(restoredHeader, "focus").mockImplementation(() => {
      if (!firstPane.classList.contains("is-minimized")) focusRestoredHeader();
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });

    fireEvent.click(restoreItem);

    await waitFor(() => expect(firstPane.classList.contains("is-minimized")).toBe(false));
    expect(firstPane.classList.contains("is-target")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(restoredHeader));
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMinimized":true'))).toBe(true);
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMinimized":false'))).toBe(true);
  });

  it("restores all panes from the all-minimized state in pane order", async () => {
    setViewport(1440, 900);
    const panes = reviewPanes("room:responsive", 3).map((item) => ({ ...item, isMinimized: true }));
    const fixture = installFetchFixture({ panes });
    const { container } = render(<App />);

    await showMinimizedBar();
    expect(await screen.findByText("All panes minimized")).toBeTruthy();
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Restore all minimized panes" }));

    await waitFor(() => expect(screen.queryByText("All panes minimized")).toBeNull());
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("3");
    expect(container.querySelector('[data-space-pane-id="pane:room:responsive:1"]')?.classList.contains("is-target")).toBe(true);
    expect(
      fixture.requestBodies.filter(
        (request) => request.body.includes('"isMinimized":false') && request.body.includes('"isMaximized":false')
      )
    ).toHaveLength(3);
  });

  it("carries pane category color and run indicator onto the minimized strip button", async () => {
    setViewport(1440, 900);
    const panes: Pane[] = [
      {
        ...pane({ id: "pane:color-run", roomId: "room:responsive", order: 0, title: "Colored runner", isMinimized: true }),
        categoryColor: "green"
      }
    ];
    installFetchFixture({ panes });
    const { container } = render(<App />);

    await showMinimizedBar();
    const restoreItem = await screen.findByRole("button", { name: "Restore pane Colored runner" });
    expect(restoreItem.getAttribute("data-category-color")).toBe("green");
    expect(container.querySelector(".minimized-pane-run-indicator")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent("space:pane-run-lifecycle", {
        detail: {
          roomId: "room:responsive",
          paneId: "pane:color-run",
          runKey: "run:color-1",
          status: "STARTED",
          occurredAt: new Date().toISOString()
        }
      }));
    });
    await waitFor(() => expect(container.querySelector(".minimized-pane-run-indicator")).toBeTruthy());
    expect(restoreItem.classList.contains("is-running")).toBe(true);

    act(() => {
      window.dispatchEvent(new CustomEvent("space:pane-run-lifecycle", {
        detail: {
          roomId: "room:responsive",
          paneId: "pane:color-run",
          runKey: "run:color-1",
          status: "COMPLETED",
          occurredAt: new Date().toISOString()
        }
      }));
    });
    await waitFor(() => expect(container.querySelector(".minimized-pane-run-indicator")).toBeNull());
    expect(restoreItem.classList.contains("is-running")).toBe(false);
  });

  it("clears pane maximize during restore all and reports partial failures after reconciliation", async () => {
    setViewport(1440, 900);
    const panes = [
      pane({ id: "pane:maximized", roomId: "room:responsive", order: 0, title: "Maximized", isMaximized: true }),
      pane({ id: "pane:restore-ok", roomId: "room:responsive", order: 1, title: "Restore OK", isMinimized: true }),
      pane({ id: "pane:restore-fails", roomId: "room:responsive", order: 2, title: "Restore fails", isMinimized: true })
    ];
    installFetchFixture({ panes, failPanePatchIds: ["pane:restore-fails"] });
    const { container } = render(<App />);

    await showMinimizedBar();
    fireEvent.click(screen.getByRole("button", { name: "Restore all minimized panes" }));

    expect(await screen.findByText("Restore all partially failed for 1 pane. Room state was refreshed.")).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-space-pane-id="pane:maximized"]')?.classList.contains("is-maximized")).toBe(false));
    expect(screen.getByRole("button", { name: "Restore pane Restore fails" })).toBeTruthy();
  });

  it("plays the original logo GIF and minimizes visible room panes on click, then restores them", async () => {
    setViewport(1440, 900);
    const fixture = installFetchFixture({ panes: [
      pane({ id: "pane:brand-min-a", roomId: "room:responsive", order: 0, title: "First" }),
      pane({ id: "pane:brand-min-b", roomId: "room:responsive", order: 1, title: "Second" }),
      pane({ id: "pane:brand-min-c", roomId: "room:responsive", order: 2, title: "Hidden", isMinimized: true })
    ] });
    const { container } = render(<App />);
    const brand = await screen.findByRole("button", { name: "Play Space logo animation" });
    expect(brand.querySelector("img")?.getAttribute("src")).toBe("/brand/space-logo-2048.png");
    fireEvent.click(brand);
    expect(brand.querySelector("img")?.getAttribute("src")).toBe("/brand/space-logo.gif");
    await screen.findByRole("button", { name: "Show minimized panes bar (3 minimized panes)" });
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("0"));
    expect(fixture.requestBodies.filter(request => request.body.includes('"isMinimized":true'))).toHaveLength(2);
    fireEvent.click(brand);
    expect(fixture.requestBodies.filter(request => request.body.includes('"isMinimized":true'))).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show minimized panes bar (3 minimized panes)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore all minimized panes" }));
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("3"));
  });

  it("parks the minimized panes bar behind one room toolbar toggle and still minimizes every visible pane", async () => {
    setViewport(1440, 900);
    const panes = [
      pane({ id: "pane:min-all-shown", roomId: "room:responsive", order: 0, title: "Already minimized", isMinimized: true }),
      pane({ id: "pane:min-all-a", roomId: "room:responsive", order: 1, title: "Hide me" }),
      pane({ id: "pane:min-all-b", roomId: "room:responsive", order: 2, title: "Hide me too" })
    ];
    const fixture = installFetchFixture({ panes });
    const { container } = render(<App />);

    // The bar is parked: one room toolbar control, no bar and no floating layer anywhere.
    const toggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    expect(container.querySelector(".minimized-pane-bar")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("minimized-pane-bar");
    expect(toggle.getAttribute("data-rail-id")).toBe("minimized-bar");
    expect(toggle.textContent).toBe("1");
    expect(container.querySelectorAll(".minimized-pane-bar-toggle")).toHaveLength(1);
    expect(container.querySelectorAll(".minimized-pane-floats, .minimized-pane-bar-toggle-layer")).toHaveLength(0);

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole("button", { name: "Minimize all visible panes" }));

    expect(await screen.findByText("All panes minimized")).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("0"));
    expect(
      fixture.requestBodies.filter((request) => request.body.includes('"isMinimized":true'))
    ).toHaveLength(2);
    // Still one icon, now reporting all three minimized panes and offering to park the bar again.
    expect(container.querySelectorAll(".minimized-pane-bar-toggle")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Hide minimized panes bar (3 minimized panes)" })).toBeTruthy();
  });

  it("brings the minimized panes bar back with a labelled chip and parks it again on a second click", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      panes: [
        pane({ id: "pane:float-a", roomId: "room:responsive", order: 0, title: "Float me" }),
        pane({ id: "pane:float-b", roomId: "room:responsive", order: 1, title: "Also visible" })
      ]
    });
    const { container } = render(<App />);

    const secondPane = await screen.findByLabelText("Also visible agent 2");
    fireEvent.click(within(secondPane).getByRole("button", { name: "Minimize pane Also visible" }));

    const toggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    expect(container.querySelector(".minimized-pane-bar")).toBeNull();
    expect(toggle.getAttribute("title")).toBe("Show minimized panes bar (1 minimized pane)");
    expect(toggle.closest(".toolbar-actions-fixed")).toBeTruthy();
    expect(toggle.hasAttribute("style")).toBe(false);

    fireEvent.click(toggle);

    const chip = await screen.findByRole("button", { name: "Restore pane Also visible" });
    expect(chip.querySelector(".minimized-pane-chip-label")?.textContent).toBe("Also visible");
    expect(chip.querySelector(".minimized-pane-chip-icon")).toBeTruthy();
    expect(chip.getAttribute("data-status")).toBe("idle");
    expect(chip.getAttribute("title")).toBe("Also visible");
    expect(container.querySelector("#minimized-pane-bar")).toBeTruthy();
    expect(container.querySelectorAll(".minimized-pane-bar-toggle")).toHaveLength(1);
    expect(container.querySelectorAll(".minimized-pane-floats")).toHaveLength(0);

    fireEvent.click(container.querySelector<HTMLButtonElement>(".minimized-pane-bar-toggle")!);
    await waitFor(() => expect(container.querySelector(".minimized-pane-bar")).toBeNull());
    expect(screen.queryByRole("button", { name: "Restore pane Also visible" })).toBeNull();
  });

  it("toggles the preview bar height and displays real preview cards when preview toggle is clicked", async () => {
    setViewport(1440, 900);
    installFetchFixture({
      panes: [
        pane({ id: "pane:prev-a", roomId: "room:responsive", order: 0, title: "Gemini CLI" }),
        pane({ id: "pane:prev-b", roomId: "room:responsive", order: 1, title: "Visible terminal" })
      ]
    });
    const { container } = render(<App />);

    const secondPane = await screen.findByLabelText("Visible terminal agent 2");
    fireEvent.click(within(secondPane).getByRole("button", { name: "Minimize pane Visible terminal" }));

    const toggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    fireEvent.click(toggle);

    const bar = container.querySelector(".minimized-pane-bar");
    expect(bar).toBeTruthy();
    expect(bar?.classList.contains("is-preview-mode")).toBe(false);

    const previewToggle = container.querySelector<HTMLButtonElement>(".minimized-preview-toggle");
    expect(previewToggle).toBeTruthy();
    expect(previewToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(previewToggle?.getAttribute("title")).toBe("Expand pane preview");

    // Click to toggle preview mode
    fireEvent.click(previewToggle!);
    expect(bar?.classList.contains("is-preview-mode")).toBe(true);
    expect(previewToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(previewToggle?.getAttribute("title")).toBe("Collapse pane preview");

    // Preview card is rendered
    const previewCard = container.querySelector(".minimized-preview-card");
    expect(previewCard).toBeTruthy();
    expect(previewCard?.textContent).toContain("Visible terminal");

    // Click preview toggle again to collapse
    fireEvent.click(previewToggle!);
    expect(bar?.classList.contains("is-preview-mode")).toBe(false);
    expect(container.querySelectorAll(".minimized-preview-card")).toHaveLength(0);
  });

  it("keeps the minimized panes toggle with the room toolbar controls instead of the pane board", async () => {
    setViewport(1440, 900);
    window.localStorage.clear();
    installFetchFixture({
      panes: [
        pane({ id: "pane:rail-a", roomId: "room:responsive", order: 0, title: "Rail me" }),
        pane({ id: "pane:rail-b", roomId: "room:responsive", order: 1, title: "Visible friend" })
      ]
    });
    const firstRender = render(<App />);

    const secondPane = await screen.findByLabelText("Visible friend agent 2");
    fireEvent.click(within(secondPane).getByRole("button", { name: "Minimize pane Visible friend" }));

    // Toolbar visible: a fixed room utility control sitting right before "Hide room toolbar".
    const toggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    expect(toggle.closest(".toolbar-actions-fixed")).toBeTruthy();
    expect(toggle.hasAttribute("style")).toBe(false);
    expect(toggle.closest(".room-runtime-stack")).toBeNull();
    expect(firstRender.container.querySelectorAll(".minimized-pane-floats, .minimized-pane-bar-toggle-layer")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Hide room toolbar" }).previousElementSibling).toBe(toggle);

    // Toolbar hidden: the same control joins the upper floating rail, keeping minimized panes toggle visible even with resource indicators off.
    firstRender.unmount();
    window.localStorage.setItem("space.roomToolbar.hidden.v1", "true");
    const railRender = render(<App />);
    const railToggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    expect(railToggle.getAttribute("data-rail-id")).toBe("minimized-bar");
    expect(railToggle.closest(".health-indicator-rail")).toBeTruthy();
    expect(railRender.container.querySelector(".health-rail-items")).toBeNull();
    expect(railRender.container.querySelector(".health-rail-expander")).toBeNull();
    expect(railRender.container.querySelector(".minimized-pane-bar")).toBeNull();

    fireEvent.click(railToggle);
    expect(railRender.container.querySelector("#minimized-pane-bar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore pane Visible friend" })).toBeTruthy();

    // When resource indicators are enabled, resource items appear alongside the toggle in health-indicator-rail
    railRender.unmount();
    window.localStorage.setItem("space.systemHealth.indicators.v1.user:operator", "true");
    const healthRailRender = render(<App />);
    const healthRailToggle = await screen.findByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    expect(healthRailToggle.closest(".health-indicator-rail")).toBeTruthy();
    expect(healthRailRender.container.querySelector(".health-rail-items")).toBeTruthy();
    expect(healthRailRender.container.querySelector(".health-rail-expander")).toBeTruthy();
  });

  it("keeps minimized state across room switches and a remount", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": [pane({ id: "pane:alpha", roomId: "room:alpha", order: 0, title: "Alpha pane" })],
        "room:beta": [pane({ id: "pane:beta", roomId: "room:beta", order: 0, title: "Beta pane" })]
      }
    });
    const firstRender = render(<App />);

    const alphaPane = await screen.findByLabelText("Alpha pane agent 1");
    fireEvent.click(within(alphaPane).getByRole("button", { name: "Minimize pane Alpha pane" }));
    await showMinimizedBar();
    expect(await screen.findByRole("button", { name: "Restore pane Alpha pane" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore pane Alpha pane" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Previous room" }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    await showMinimizedBar();
    expect(await screen.findByRole("button", { name: "Restore pane Alpha pane" })).toBeTruthy();

    firstRender.unmount();
    render(<App />);
    await showMinimizedBar();
    expect(await screen.findByRole("button", { name: "Restore pane Alpha pane" })).toBeTruthy();
    expect(fixture.requestBodies.some((request) => request.body.includes('"isMinimized":true'))).toBe(true);
  });


  it("keeps warm room pane instances mounted across A to B to A switches", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    setViewport(1440, 900);
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": terminalPanes("room:alpha", 16),
        "room:beta": terminalPanes("room:beta", 16)
      }
    });
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:alpha"]')).toHaveLength(16));
    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:beta"]')).toHaveLength(16));
    const alphaPanes = Array.from(container.querySelectorAll<HTMLElement>('[data-space-room-id="room:alpha"]'));
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:beta"]')).toHaveLength(16));
    const betaPanes = Array.from(container.querySelectorAll<HTMLElement>('[data-space-room-id="room:beta"]'));
    expect(container.querySelector('[data-room-runtime-id="room:alpha"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-room-runtime-id="room:alpha"]')?.hasAttribute("inert")).toBe(true);
    expect(container.querySelectorAll(".room-runtime-layer")).toHaveLength(2);

    const warmSessionRequestsBeforeReturn = fixture.requests.filter(
      (request) => request.method === "GET" && /\/api\/panes\/[^/]+\/cli\/session\?includeTranscript=false$/.test(request.url)
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Previous room" }));
    await waitFor(() => expect(container.querySelector('[data-room-runtime-id="room:alpha"]')?.getAttribute("aria-hidden")).toBe("false"));
    for (const [index, alphaPane] of alphaPanes.entries()) {
      expect(container.querySelector(`[data-space-pane-id="pane:room:alpha:cli-${index + 1}"]`)).toBe(alphaPane);
    }
    for (const [index, betaPane] of betaPanes.entries()) {
      expect(container.querySelector(`[data-space-pane-id="pane:room:beta:cli-${index + 1}"]`)).toBe(betaPane);
    }
    expect(container.querySelectorAll(".room-runtime-layer")).toHaveLength(2);
    expect(
      fixture.requests.filter(
        (request) => request.method === "GET" && /\/api\/panes\/[^/]+\/cli\/session\?includeTranscript=false$/.test(request.url)
      )
    ).toHaveLength(warmSessionRequestsBeforeReturn);

    const completedSwitches = readLifecycleDebugSnapshot().events.filter((event) => event.type === "room_switch_loaded");
    expect(completedSwitches.map((event) => ({
      toRoomId: event.roomSwitch?.toRoomId,
      temperature: event.roomSwitch?.temperature
    }))).toEqual([
      { toRoomId: "room:beta", temperature: "warm" },
      { toRoomId: "room:alpha", temperature: "warm" }
    ]);
    expect(completedSwitches.every((event) => typeof event.roomSwitch?.durationMs === "number")).toBe(true);
    const hydrationMetrics = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "space:app-diagnostics-performance")
      .map((event) => (event as CustomEvent).detail)
      .filter((detail) => detail.metric === "ROOM_HYDRATION");
    expect(hydrationMetrics).toContainEqual(expect.objectContaining({
      roomId: "room:alpha",
      phase: "COMPLETE",
      durationMs: expect.any(Number)
    }));
    expect(hydrationMetrics).toContainEqual(expect.objectContaining({
      roomId: "room:beta",
      phase: "COMPLETE",
      durationMs: expect.any(Number)
    }));
    expect(
      hydrationMetrics.filter((detail) =>
        detail.roomId === "room:alpha" && detail.phase === "START"
      )
    ).toHaveLength(1);
    expect(
      hydrationMetrics.filter((detail) =>
        detail.roomId === "room:alpha" && detail.phase === "COMPLETE"
      )
    ).toHaveLength(1);
  });

  it("holds the outgoing room until a cold target can be presented atomically", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    setViewport(1440, 900);
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const betaGate = deferred<void>();
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 2),
        "room:beta": reviewPanes("room:beta", 2)
      },
      paneRequestDeferredByRoom: { "room:beta": betaGate.promise }
    });
    const { container } = render(<App />);

    const alphaPane = await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));

    const stack = container.querySelector(".room-runtime-stack");
    const alphaLayer = container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]');
    const betaLayer = container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]');
    expect(stack?.getAttribute("aria-busy")).toBe("true");
    expect(alphaLayer?.dataset.presentationState).toBe("held");
    expect(betaLayer?.dataset.presentationState).toBe("preparing");
    expect(container.querySelector(".board-title-heading h2")?.textContent).toBe("Alpha");
    expect(container.querySelector(".board-toolbar")?.hasAttribute("inert")).toBe(true);
    expect(alphaLayer?.hasAttribute("inert")).toBe(true);
    expect(betaLayer?.hasAttribute("inert")).toBe(true);
    expect(alphaLayer?.querySelector<HTMLElement>('[data-space-pane-id="pane:room:alpha:1"]')?.dataset.terminalOutputState)
      .toBe("buffering");
    expect(alphaLayer?.querySelector('[data-space-pane-id="pane:room:alpha:1"]')).toBe(alphaPane);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".room-runtime-layer"))
        .filter((layer) => ["displayed", "held"].includes(layer.dataset.presentationState ?? ""))
    ).toHaveLength(1);

    await act(async () => {
      betaGate.resolve();
      await betaGate.promise;
    });

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
        .toBe("displayed");
    });
    expect(container.querySelector(".room-runtime-stack")?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector(".board-title-heading h2")?.textContent).toBe("Beta");
    expect(container.querySelector(".board-toolbar")?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("hidden");
    const presentationMetrics = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "space:app-diagnostics-performance")
      .map((event) => (event as CustomEvent).detail)
      .filter((detail) => detail.metric === "ROOM_PRESENTATION" && detail.roomId === "room:beta");
    expect(presentationMetrics.map((detail) => detail.phase)).toEqual(["START", "READY", "COMPLETE"]);
    expect(presentationMetrics.every((detail) =>
      typeof detail.durationMs === "number" && typeof detail.value === "number"
    )).toBe(true);
  });

  it("does not hold a stale persisted room that is absent from the startup catalog", async () => {
    window.sessionStorage.setItem("space.selectedRoomId", "room:deleted");
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    setViewport(1440, 900);
    installFetchFixture({
      rooms: [{ id: "room:alpha", name: "Alpha", order: 0 }],
      panesByRoom: { "room:alpha": reviewPanes("room:alpha", 1) }
    });
    const { container } = render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(container.querySelector('[data-room-runtime-id="room:deleted"]')).toBeNull();
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("displayed");
    expect(container.querySelector(".room-runtime-stack")?.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the last displayed room through rapid A to B to C switches", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    setWarmRoomTelemetry({
      hardwareConcurrency: 6,
      usedBytes: 256 * 1024 ** 2,
      heapLimitBytes: 8 * 1024 ** 3,
      deviceMemoryGiB: 16
    });
    setViewport(1440, 900);
    const betaGate = deferred<void>();
    const gammaGate = deferred<void>();
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 },
        { id: "room:gamma", name: "Gamma", order: 2 }
      ],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 1),
        "room:beta": reviewPanes("room:beta", 1),
        "room:gamma": reviewPanes("room:gamma", 1)
      },
      paneRequestDeferredByRoom: {
        "room:beta": betaGate.promise,
        "room:gamma": gammaGate.promise
      }
    });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
        .toBe("preparing");
    });
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:gamma"]')?.dataset.presentationState)
        .toBe("preparing");
    });

    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("held");
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
      .toBe("hidden");

    await act(async () => {
      betaGate.resolve();
      await betaGate.promise;
    });
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("held");
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:gamma"]')?.dataset.presentationState)
      .toBe("preparing");

    await act(async () => {
      gammaGate.resolve();
      await gammaGate.promise;
    });
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:gamma"]')?.dataset.presentationState)
        .toBe("displayed");
    });
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("hidden");
  });

  it("keeps preparing a slow existing room beyond the performance budget without cancelling the switch", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    setViewport(1440, 900);
    const betaGate = deferred<void>();
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 1),
        "room:beta": reviewPanes("room:beta", 1)
      },
      paneRequestDeferredByRoom: { "room:beta": betaGate.promise }
    });
    const { container } = render(<App />);

    await screen.findByLabelText("Review 1 agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
        .toBe("preparing");
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    });
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta");
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("held");
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
      .toBe("preparing");
    expect(screen.queryByText("The target room did not become paint-ready. The previous room was preserved; try again."))
      .toBeNull();

    await act(async () => {
      betaGate.resolve();
      await betaGate.promise;
    });
    await waitFor(() => {
      expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState)
        .toBe("displayed");
    });
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState)
      .toBe("hidden");
  });






  it("defaults the warm room cache on and reuses the previous room", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": reviewPanes("room:alpha", 2),
        "room:beta": reviewPanes("room:beta", 2)
      }
    });
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:alpha"]')).toHaveLength(2));
    const originalAlphaPane = container.querySelector('[data-space-pane-id="pane:room:alpha:1"]');
    expect(container.querySelector(".space-shell")?.getAttribute("data-warm-room-cache-enabled")).toBe("true");

    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:beta"]')).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:beta"]')).toHaveLength(2));
    expect(container.querySelector('[data-room-runtime-id="room:alpha"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelectorAll(".room-runtime-layer")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Previous room" }));
    await waitFor(() => expect(container.querySelectorAll('[data-space-room-id="room:alpha"]')).toHaveLength(2));
    expect(container.querySelector('[data-space-pane-id="pane:room:alpha:1"]')).toBe(originalAlphaPane);
    expect(container.querySelectorAll(".room-runtime-layer")).toHaveLength(2);

    const completedSwitches = readLifecycleDebugSnapshot().events.filter((event) => event.type === "room_switch_loaded");
    expect(completedSwitches.map((event) => event.roomSwitch?.temperature)).toEqual(["warm", "warm"]);
  });

  it("does not let a slow inactive room response replace the active room", async () => {
    window.sessionStorage.clear();
    window.localStorage.setItem("space.warmRoom.enabled.v1", "true");
    setViewport(1440, 900);
    const betaGate = deferred<void>();
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: {
        "room:alpha": [pane({ id: "pane:alpha", roomId: "room:alpha", order: 0, title: "Alpha pane" })],
        "room:beta": [pane({ id: "pane:beta", roomId: "room:beta", order: 0, title: "Beta pane" })]
      },
      paneRequestDeferredByRoom: { "room:beta": betaGate.promise }
    });
    const { container } = render(<App />);

    const alphaPane = await screen.findByLabelText("Alpha pane agent 1");
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));
    fireEvent.click(screen.getByRole("button", { name: "Previous room" }));
    await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));

    await act(async () => {
      betaGate.resolve();
      await betaGate.promise;
    });

    await waitFor(() => expect(container.querySelector('[data-room-runtime-id="room:alpha"]')?.getAttribute("aria-hidden")).toBe("false"));
    expect(container.querySelector('[data-space-pane-id="pane:alpha"]')).toBe(alphaPane);
    expect(container.querySelector('[data-room-runtime-id="room:beta"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows persisted minimized panes as full mobile panes without a minimize bar", async () => {
    setViewport(390, 844);
    installFetchFixture({
      panes: [
        pane({ id: "pane:hidden", roomId: "room:responsive", order: 0, title: "Hidden review", isMinimized: true }),
        pane({ id: "pane:visible-1", roomId: "room:responsive", order: 1, title: "Visible one" }),
        pane({ id: "pane:visible-2", roomId: "room:responsive", order: 2, title: "Visible two" })
      ]
    });

    render(<App />);

    const visiblePane = await screen.findByLabelText("Visible one agent 2");
    expect(within(visiblePane).queryByRole("button", { name: /Minimize pane/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Minimize pane/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Room panes" })).toBeNull();
    expect(screen.queryByRole("group", { name: /Pane navigation/ })).toBeNull();
    const title = visiblePane.querySelector<HTMLElement>(".pane-title-block");
    fireEvent.touchStart(title!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(title!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("Visible two agent 3").getAttribute("data-shell-visible")).toBe("true"));
    expect(screen.queryByRole("region", { name: "Minimized panes" })).toBeNull();
    expect(screen.getByLabelText("Hidden review agent 1").getAttribute("data-minimized")).toBe("false");
    const nextTitle = screen.getByLabelText("Visible two agent 3").querySelector<HTMLElement>(".pane-title-block");
    fireEvent.touchStart(nextTitle!, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchEnd(nextTitle!, { changedTouches: [{ clientX: 100, clientY: 100 }] });
    await waitFor(() => expect(screen.getByLabelText("Hidden review agent 1").getAttribute("data-shell-visible")).toBe("true"));
  });

  it("keeps minimize available on tablet", async () => {
    setViewport(1024, 768);
    installFetchFixture({ panes: reviewPanes("room:responsive", 1) });
    render(<App />);

    const paneCard = await screen.findByLabelText("Review 1 agent 1");
    expect(within(paneCard).getByRole("button", { name: "Minimize pane Review 1" })).toBeTruthy();
  });

  it("moves the room actions to a second row whenever their measured content cannot fit", () => {
    expect(
      roomToolbarNeedsSecondRow({
        availableWidth: 1000,
        titleWidth: 248,
        lbWidth: 116,
        actionsWidth: 636,
        columnGap: 12
      })
    ).toBe(true);
    expect(
      roomToolbarNeedsSecondRow({
        availableWidth: 1280,
        titleWidth: 248,
        lbWidth: 116,
        actionsWidth: 636,
        columnGap: 12
      })
    ).toBe(false);
  });

  it("includes pane fixed controls when deciding whether the actions need a second row", () => {
    const shared = {
      availableWidth: 520,
      paddingLeft: 9,
      paddingRight: 9,
      badgeWidth: 36,
      titleWidth: 148,
      actionsWidth: 216,
      columnGap: 8
    };

    expect(paneHeaderNeedsSecondRow({ ...shared, fixedWidth: 0 })).toBe(false);
    expect(paneHeaderNeedsSecondRow({ ...shared, fixedWidth: 156 })).toBe(true);
  });

  it("defines wrapping room toolbar actions without horizontal scrolling", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toContain("--toolbar-control-size: 2.25rem;");
    expect(css).toContain("--toolbar-icon-size: 1rem;");
    expect(css).toContain(".toolbar-actions-scroll");
    expect(css).toContain(".pane-actions-fixed");
    expect(css).toContain("flex: 0 0 var(--toolbar-control-size);");
    expect(css).toContain("overflow-x: visible;");
    expect(css).toContain("flex-wrap: wrap;");
    expect(css).toContain('.board-toolbar[data-room-actions-stacked="true"]');
    expect(css).not.toContain(".horizontal-drag-scroll");
    expect(css).not.toContain(".pane-actions-scroll");
    expect(css).toMatch(/\.toolbar-lb-strip \{[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;/);
    expect(css).toMatch(/\.pane-actions \{[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;/);
    expect(css).toContain('"badge title fixed"');
    expect(css).toContain("width: var(--toolbar-control-size);");
    expect(css).toContain("width: var(--toolbar-icon-size);");
    expect(css).toContain('grid-template-areas: "title lb actions";');
    expect(css).toMatch(/"title lb"\s+"actions actions"/);
    expect(css).toMatch(/\.room-toolbar-floating-controls \{[^}]*position: fixed;[^}]*right: max\([^}]*bottom: max\(/);
    expect(css).toMatch(/\.room-toolbar-floating-controls \{[^}]*--toolbar-control-size: 2rem;/);
    expect(css).toMatch(/\.board \{[^}]*position: relative;[^}]*grid-template-rows: minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.board-toolbar \{[^}]*position: absolute;/);
    expect(css).toMatch(/\.board.has-pane-navigation \{\s*grid-template-rows: auto minmax\(0, 1fr\);/);
    expect(css).not.toMatch(/\[data-room-toolbar-hidden="true"\][^{]*\.board[^{]*\{/);
    expect(css).toMatch(/\.space-shell\[data-shell-mode="mobile"\][^{]*\.board-toolbar[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?"title lb"\s+"actions actions"/);
    expect(css).toContain("@media (max-width: 680px)");
    expect(css).toMatch(/@media \(max-width: 680px\)[\s\S]*?"title"\s+"actions"/);
    expect(css).toMatch(/@media \(max-width: 680px\)[\s\S]*?\.toolbar-lb-strip \{\s*display: none;/);
    expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*?grid-template-areas:\s*"title"\s*"actions"/);
    expect(css).toMatch(/\.board-toolbar\[data-room-actions-stacked="true"\] \.board-title-row \{[^}]*flex-wrap: nowrap;/);
    expect(css).toMatch(/\.board-toolbar\[data-room-actions-stacked="true"\] \.board-title-heading \{[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.space-shell\[data-shell-mode="mobile"\] \.board-title-heading \{[^}]*overflow: hidden;/);
    expect(css).toContain('.space-shell[data-shell-mode="mobile"] .toolbar-actions-scroll {');
    expect(css).toContain('.space-shell[data-shell-mode="mobile"] .toolbar-lb-strip,');
    expect(css).toContain('.space-shell[data-shell-mode="mobile"] .room-title-nav button:disabled');
    expect(css).toContain(".embedded-dashboard-dialog[open]");
    expect(css).toContain("height: 100dvh;");
    expect(css).toContain("min-height: 44px;");
    expect(css).toContain("overflow: hidden;");
    expect(css).toContain("@keyframes embedded-dashboard-spin");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain('button[aria-expanded="true"]:has(> svg)');
    expect(css).toContain('button[aria-pressed="true"]:has(> svg)');
    expect(css).toContain("--active-icon-border: #ff4d5e;");
    expect(css.lastIndexOf('button[aria-expanded="true"]:has(> svg)')).toBeGreaterThan(css.lastIndexOf(".space-shell[data-room-theme] button:hover"));
    expect(css).toMatch(/\.space-brand-control \{[^}]*width: var\(--toolbar-control-size\);[^}]*height: var\(--toolbar-control-size\);/);
    expect(css).not.toContain("--space-brand-reserved-space");
    expect(css).not.toMatch(/\.space-brand-control \{[^}]*position: fixed;/);
    expect(css).not.toMatch(/\.room-focus-mode \.board-toolbar \{[^}]*padding-left:/);
    expect(css).not.toMatch(/\.room-focus-mode \.side-surface-inline \{[^}]*padding-top:/);
    expect(css).toContain(".pane-header-identity {");
    expect(css).toContain('"badge title fixed"');
    expect(css).toContain('"actions actions actions"');
    // Narrowed with operator approval (2026-10-11): styles.css now uses !important for unrelated
    // theme and state overrides (since 6fa32d43da). The room toolbar and pane action rules covered
    // here, including the active-icon rule above, must not. The red active-state overrides
    // (4399759d7d) are :is(...) rules outside this scope; the disabled room-arrow override
    // (e1916ab7e2) intentionally beats them with !important.
    const roomToolbarRules = cssRulesFor(
      css,
      /^(?:(?:\.space-shell(?:\[data-shell-mode="(?:mobile|tablet|desktop)"\]|\.shell-mobile)? )?\.(?:toolbar-actions-scroll|toolbar-lb-strip|board|board-toolbar|board-title-row|board-title-heading|room-toolbar-floating-controls|space-brand-control|room-title-nav|pane-actions|pane-actions-fixed|pane-header-identity)\b|\.space-shell button\[aria-(?:expanded|pressed)="true"\]:has\(> svg\))/
    );
    expect(roomToolbarRules.flatMap((rule) => rule.selectors)).toEqual(expect.arrayContaining([
      ".toolbar-actions-scroll", ".toolbar-lb-strip", ".pane-actions", ".board", ".board-toolbar",
      ".room-toolbar-floating-controls", ".space-brand-control", '.space-shell button[aria-expanded="true"]:has(> svg):where(:not(.side-surface-room-panel *))'
    ]));
    expect(roomToolbarRules
      .filter((rule) => rule.declarations.includes("!important"))
      .map((rule) => rule.selectors.join(", "))
      .filter((selectorList) => selectorList !== ".room-title-nav button:disabled")).toEqual([]);
  });

  it("adds previous and next room arrow controls next to the active room title", async () => {
    window.sessionStorage.clear();
    setWarmRoomTelemetry({
      hardwareConcurrency: 6,
      usedBytes: 256 * 1024 ** 2,
      heapLimitBytes: 8 * 1024 ** 3,
      deviceMemoryGiB: 16
    });
    setViewport(1440, 900);
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 },
        { id: "room:gamma", name: "Gamma", order: 2 }
      ],
      panes: reviewPanes("room:alpha", 1),
      cliCountsByRoom: { "room:alpha": 2 },
      cliRuntimeIdsByRoom: { "room:alpha": ["cli:codex", "cli:opencode"] }
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    const titleControls = document.querySelector(".board-title-controls");
    expect(titleControls).toBeTruthy();
    expect(within(titleControls as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Rename Alpha",
      "Previous room",
      "Next room"
    ]);
    expect((screen.getByRole("button", { name: "Previous room" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Next room" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    expect(await screen.findByRole("heading", { name: "Beta" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous room" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    expect(await screen.findByRole("heading", { name: "Gamma" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next room" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders previous and next room buttons on the collapsed rail conditionally", async () => {
    setViewport(1440, 900);
    window.localStorage.setItem("space.roomToolbar.hidden.v1", "true");
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 },
        { id: "room:gamma", name: "Gamma", order: 2 }
      ],
      panes: reviewPanes("room:alpha", 1),
      cliCountsByRoom: { "room:alpha": 2 },
      cliRuntimeIdsByRoom: { "room:alpha": ["cli:codex", "cli:opencode"] }
    });

    const { container } = render(<App />);
    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    const rail = screen.getByRole("region", { name: "Room toolbar hidden" });
    expect(rail).toBeTruthy();

    // On Alpha: next room exists, previous does not
    expect(within(rail as HTMLElement).queryByRole("button", { name: "Previous room" })).toBeNull();
    expect(within(rail as HTMLElement).getByRole("button", { name: "Next room" })).toBeTruthy();

    // Navigate to Beta
    fireEvent.click(within(rail as HTMLElement).getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(document.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));

    // On Beta: both previous and next exist
    expect(within(rail as HTMLElement).getByRole("button", { name: "Previous room" })).toBeTruthy();
    expect(within(rail as HTMLElement).getByRole("button", { name: "Next room" })).toBeTruthy();

    // Navigate to Gamma
    fireEvent.click(within(rail as HTMLElement).getByRole("button", { name: "Next room" }));
    await waitFor(() => expect(document.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:gamma"));

    // On Gamma: previous room exists, next does not
    expect(within(rail as HTMLElement).getByRole("button", { name: "Previous room" })).toBeTruthy();
    expect(within(rail as HTMLElement).queryByRole("button", { name: "Next room" })).toBeNull();
  });

  it("keeps a dense desktop overview for 16-pane rooms", async () => {
    setViewport(1440, 900);
    installFetchFixture({ panes: reviewPanes("room:responsive", 16) });

    const { container } = render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(await screen.findByLabelText("Review 16 agent 16")).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-shell-mode")).toBe("desktop");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-density")).toBe("tight");
    expect(container.querySelector(".pane-grid")?.getAttribute("data-visible-pane-count")).toBe("16");
    expect(screen.getByLabelText("Rooms")).toBeTruthy();
    expect(screen.queryByLabelText("Media dock")).toBeNull();

    showDock("Media dock");
    expect(await screen.findByLabelText("Media dock")).toBeTruthy();
    expect(screen.queryByLabelText("Rooms")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show rooms" }));
    expect(await screen.findByLabelText("Rooms")).toBeTruthy();
  });

  it("reorders rooms only while holding the right mouse button on the complete room card", async () => {
    setViewport(390, 844);
    const fixture = installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 },
        { id: "room:gamma", name: "Gamma", order: 2 }
      ],
      panes: reviewPanes("room:alpha", 1)
    });

    render(<App />);

    expect(await screen.findByLabelText("Review 1 agent 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    const roomsDrawer = await screen.findByLabelText("Rooms");

    const alphaItem = within(roomsDrawer).getByLabelText("Open Alpha").closest(".room-item") as HTMLDivElement | null;
    const gammaItem = within(roomsDrawer).getByLabelText("Open Gamma").closest(".room-item") as HTMLDivElement | null;
    expect(within(roomsDrawer).queryByRole("button", { name: "Reorder Alpha" })).toBeNull();
    expect(alphaItem?.hasAttribute("draggable")).toBe(false);
    expect(alphaItem?.getAttribute("title")).toBe("Hold the right mouse button to reorder Alpha");
    expect(gammaItem).toBeTruthy();
    expect(alphaItem?.querySelector(".room-warm-badge")).toBeNull();

    fireEvent.pointerDown(alphaItem as HTMLDivElement, { button: 2, buttons: 2, pointerId: 7 });
    fireEvent.pointerMove(gammaItem as HTMLDivElement, { buttons: 2, pointerId: 7 });
    fireEvent.pointerUp(gammaItem as HTMLDivElement, { button: 2, buttons: 0, pointerId: 7 });

    await waitFor(() =>
      expect(
        fixture.requestBodies.some(
          (request) =>
            request.url === "/api/rooms/reorder" &&
            request.body.includes("\"roomIds\":[\"room:beta\",\"room:alpha\",\"room:gamma\"]")
        )
      ).toBe(true)
    );
    expect(within(roomsDrawer).getAllByRole("button", { name: /^Open / }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Beta",
      "Open Alpha",
      "Open Gamma"
    ]);
  });

  it("keeps the mobile Rooms drawer open and marks the selected existing room as the pane target", async () => {
    setViewport(390, 844);
    installFetchFixture({
      rooms: [
        { id: "room:alpha", name: "Alpha", order: 0 },
        { id: "room:beta", name: "Beta", order: 1 }
      ],
      panesByRoom: { "room:alpha": [], "room:beta": [] }
    });

    render(<App />);
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    const drawer = await screen.findByRole("dialog", { name: "Rooms" });

    expect(within(drawer).getByRole("button", { name: "Open Alpha" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(drawer).getByRole("button", { name: "Open Beta" }));

    expect(await within(drawer).findByText("Add panes to Beta")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Rooms" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Open Beta" }).getAttribute("aria-current")).toBe("true");
    expect(within(drawer).getByRole("button", { name: "Open Alpha" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(within(drawer).getByRole("button", { name: /^Add panes to /, expanded: false }));
    // The composer starts collapsed (e4fcdef04d); its CLI runtime rows appear once runtimes load.
    fireEvent.click(await within(drawer).findByRole("button", { name: "Increase Codex panes" }));
    expect(within(drawer).getByRole("button", { name: "Add 1 pane" })).toHaveProperty("disabled", false);
  });

  it("refreshes the room catalog once when the Rooms surface opens without reloading room runtime", async () => {
    window.sessionStorage.clear();
    setViewport(390, 844);
    const fixture = installFetchFixture({
      rooms: [{ id: "room:workspace", name: "Workspace", kind: "WORKSPACE" }],
      panes: reviewPanes("room:workspace", 1)
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(fixture.requests.filter(isRoomCatalogRequest)).toHaveLength(1);
    await waitFor(() =>
      expect(fixture.requests.filter((request) => request.url === "/api/panes?roomId=room%3Aworkspace")).toHaveLength(2)
    );
    const paneRequestCountBeforeOpen = fixture.requests.filter(
      (request) => request.url === "/api/panes?roomId=room%3Aworkspace"
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Open rooms" }));
    const drawer = await screen.findByRole("dialog", { name: "Rooms" });

    await waitFor(() => expect(fixture.requests.filter(isRoomCatalogRequest)).toHaveLength(2));
    expect(within(drawer).getByRole("button", { name: "Open Workspace" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(
      fixture.requests.filter((request) => request.url === "/api/panes?roomId=room%3Aworkspace")
    ).toHaveLength(paneRequestCountBeforeOpen);
  });

  it("loads a bounded multi-page room catalog when the Rooms surface is visible", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    const rooms = Array.from({ length: 126 }, (_, index) => ({
      id: `room:catalog-${index + 1}`,
      name: index === 125 ? "Agent proof · diagnostics perf" : `Catalog room ${index + 1}`,
      kind: index === 125 ? "AGENT_PROOF" as const : "WORKSPACE" as const
    }));
    const fixture = installFetchFixture({
      defaultRoomPageSize: 25,
      rooms
    });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Catalog room 1" })).toBeTruthy();
    const roomsSurface = await screen.findByLabelText("Rooms");

    fireEvent.click(await within(roomsSurface).findByRole("button", { name: /Test rooms/ }));
    expect(
      await within(roomsSurface).findByRole("button", { name: "Open Agent proof · diagnostics perf" })
    ).toBeTruthy();
    // The bounded catalog reads every account's rooms (all=true) since 4399759d7d.
    expect(fixture.requests.some((request) => request.url === "/api/rooms?page=1&pageSize=100&all=true")).toBe(true);
    expect(fixture.requests.some((request) => request.url === "/api/rooms?page=2&pageSize=100&all=true")).toBe(true);
    // The ADMIN Agents dashboard summary polls pane metadata for every room (e9fdfdaffc);
    // nothing else may touch the Agent Proof room.
    expect(fixture.requests.filter((request) =>
      request.url.includes("room%3Acatalog-126") && request.url !== "/api/rooms/room%3Acatalog-126/dashboard-agents"
    )).toEqual([]);
  });

  it("keeps a persisted selected room active when it is beyond the default room page", async () => {
    // The persisted room selection is stored per user since 4399759d7d.
    window.sessionStorage.setItem("space.selectedRoomId.user:operator", "room:catalog-126");
    setViewport(768, 900);
    const rooms = Array.from({ length: 126 }, (_, index) => ({
      id: `room:catalog-${index + 1}`,
      name: index === 125 ? "Agent proof · selected" : `Catalog room ${index + 1}`,
      kind: index === 125 ? "AGENT_PROOF" as const : "WORKSPACE" as const
    }));
    const fixture = installFetchFixture({
      defaultRoomPageSize: 25,
      rooms,
      panesByRoom: {
        "room:catalog-126": reviewPanes("room:catalog-126", 1)
      }
    });

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent proof · selected" })).toBeTruthy();
    expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:catalog-126");
    expect(screen.queryByText(/no longer exists; switched to/i)).toBeNull();
    // The bounded catalog reads every account's rooms (all=true) since 4399759d7d.
    expect(fixture.requests.some((request) => request.url === "/api/rooms?page=1&pageSize=100&all=true")).toBe(true);
    expect(fixture.requests.some((request) => request.url === "/api/rooms?page=2&pageSize=100&all=true")).toBe(true);
  });

  it("adds Agent Proof rooms from global SSE without selecting or loading their runtime", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    const eventSources: TestEventSource[] = [];

    class TestEventSource extends EventTarget {
      onopen: ((this: EventSource, event: Event) => unknown) | null = null;
      onerror: ((this: EventSource, event: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
      readyState = 0;
      readonly withCredentials: boolean;

      constructor(readonly url: string, init?: EventSourceInit) {
        super();
        this.withCredentials = Boolean(init?.withCredentials);
        eventSources.push(this);
      }

      close() {
        this.readyState = 2;
      }

      emitSpaceEvent(type: string, data: Record<string, unknown>) {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
      }
    }

    vi.stubGlobal("EventSource", TestEventSource);
    const fixture = installFetchFixture({
      rooms: [{ id: "room:workspace", name: "Workspace", kind: "WORKSPACE" }],
      panes: reviewPanes("room:workspace", 1)
    });
    const visibilityChanges = vi.fn();
    window.addEventListener("space:cli-runtime-visibility-changed", visibilityChanges);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    await waitFor(() =>
      expect(eventSources.some((source) => source.url === "/api/events/stream?replayLimit=200")).toBe(true)
    );
    // The Rooms dock refreshes the catalog once startup is ready (9fe60ec24e); the baseline starts after it.
    await waitFor(() => expect(fixture.requests.some((request) => request.url === "/api/rooms/cli-activity")).toBe(true));
    const roomRequestCountBeforeEvent = fixture.requests.filter(isRoomCatalogRequest).length;
    const environmentRequestCountBeforeEvent = fixture.requests.filter(
      (request) => request.url === "/api/codex/environment"
    ).length;
    fixture.addRoom({ id: "room:proof", name: "Agent proof · mobile", kind: "AGENT_PROOF" });
    const globalSource = eventSources.find((source) => source.url === "/api/events/stream?replayLimit=200")!;
    const createdEvent = {
      id: "event:proof-created",
      roomId: "room:proof",
      paneId: null,
      turnId: null,
      workflowId: null,
      traceId: "req:proof-created",
      type: "ROOM_CREATED",
      message: "Agent proof room created.",
      payload: { roomId: "room:proof" },
      createdAt: "2026-07-20T12:01:00.000Z"
    };

    await act(async () => {
      globalSource.emitSpaceEvent("CAPABILITY_STATUS_CHANGED", {
        ...createdEvent,
        id: "event:capability-one",
        type: "CAPABILITY_STATUS_CHANGED"
      });
      globalSource.emitSpaceEvent("CAPABILITY_STATUS_CHANGED", {
        ...createdEvent,
        id: "event:capability-two",
        type: "CAPABILITY_STATUS_CHANGED"
      });
      await Promise.resolve();
    });
    expect(visibilityChanges).not.toHaveBeenCalled();

    await act(async () => {
      globalSource.dispatchEvent(new MessageEvent("replay-complete", { data: JSON.stringify({ count: 0 }) }));
      globalSource.emitSpaceEvent("ROOM_CREATED", createdEvent);
      globalSource.emitSpaceEvent("ROOM_CREATED", { ...createdEvent, id: "event:proof-created-duplicate" });
      await Promise.resolve();
    });
    expect(visibilityChanges).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(
      fixture.requests.filter((request) => request.url === "/api/codex/environment")
    ).toHaveLength(environmentRequestCountBeforeEvent + 1));

    const roomsSurface = await screen.findByLabelText("Rooms");
    // Agent Proof rooms wait in the collapsed "Test rooms" group.
    fireEvent.click(await within(roomsSurface).findByRole("button", { name: /Test rooms/ }));
    expect(within(roomsSurface).getByRole("button", { name: "Open Workspace" }).getAttribute("aria-current")).toBe("true");
    expect(within(roomsSurface).getByRole("button", { name: "Open Agent proof · mobile" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByLabelText("Review 1 agent 1")).toBeTruthy();
    expect(fixture.requests.filter(isRoomCatalogRequest)).toHaveLength(roomRequestCountBeforeEvent + 1);
    // The ADMIN Agents dashboard summary polls pane metadata for every room (e9fdfdaffc); nothing
    // else may load the proof room's runtime.
    expect(fixture.requests.some((request) =>
      request.url.includes("room%3Aproof") && !request.url.endsWith("/dashboard-agents")
    )).toBe(false);
    window.removeEventListener("space:cli-runtime-visibility-changed", visibilityChanges);
  });

  it("shows a room watchdog banner for a live alert only, never for one the room stream replays", async () => {
    window.sessionStorage.clear();
    setViewport(1440, 900);
    const eventSources: TestEventSource[] = [];
    class TestEventSource extends EventTarget {
      onopen = null; onerror = null; onmessage = null; readyState = 0;
      constructor(readonly url: string) { super(); eventSources.push(this); }
      close() { this.readyState = 2; }
    }
    vi.stubGlobal("EventSource", TestEventSource);
    installFetchFixture({ rooms: [{ id: "room:workspace", name: "Workspace", kind: "WORKSPACE" }], panes: reviewPanes("room:workspace", 1) });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    let roomSource!: TestEventSource;
    await waitFor(() => { roomSource = eventSources.find((source) => source.url.includes("roomId=room%3Aworkspace"))!; expect(roomSource).toBeTruthy(); });
    const alert = (id: string, message: string) => new MessageEvent("ROOM_WATCHDOG_ALERT", { data: JSON.stringify({ id, roomId: "room:workspace",
      paneId: null, turnId: null, workflowId: null, traceId: "trace:watchdog", type: "ROOM_WATCHDOG_ALERT", message, payload: {}, createdAt: "2026-10-17T13:58:38.000Z" }) });

    await act(async () => {
      roomSource.dispatchEvent(new MessageEvent("replay-start", { data: JSON.stringify({ count: 1 }) }));
      roomSource.dispatchEvent(alert("event:old", "Room watchdog: an old alert."));
      roomSource.dispatchEvent(new MessageEvent("replay-complete", { data: JSON.stringify({ count: 1 }) }));
      await Promise.resolve();
    });
    expect(screen.queryByText("Room watchdog: an old alert.")).toBeNull();

    await act(async () => { roomSource.dispatchEvent(alert("event:new", "Room watchdog: a new alert.")); await Promise.resolve(); });
    expect(await screen.findByText("Room watchdog: a new alert.")).toBeTruthy();
  });

  it("renders storage warning banner with close button and dismisses it on click", async () => {
    sessionStorage.clear();
    const warningMessage = "Root filesystem is above the 80% warning threshold.";
    installFetchFixture({
      storageWarning: warningMessage
    });

    render(<App />);

    const warningText = await screen.findByText(warningMessage);
    expect(warningText).toBeTruthy();

    const bannerContainer = warningText.closest(".banner.warn");
    expect(bannerContainer).toBeTruthy();

    const closeButton = bannerContainer!.querySelector("button.notice-close");
    expect(closeButton).toBeTruthy();

    fireEvent.click(closeButton!);

    await waitFor(() => {
      expect(screen.queryByText(warningMessage)).toBeNull();
    });

    expect(sessionStorage.getItem("space.dismissedStorageWarning")).toBe(warningMessage);
  });
});
