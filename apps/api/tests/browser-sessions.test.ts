import { browserSetViewportInputSchema } from "@space/contracts";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import {
  allocateDisplay,
  applyRestoreState,
  assertSafeBrowserTargetUrl,
  BrowserCapacityGate,
  nextBrowserFrameDeadline,
  BrowserRequestGuard,
  browserAgentNumberForPane,
  browserProfilePathFor,
  browserSessionNeedsNavigation,
  browserSessionRestoreUrls,
  createBrowserSessionManager,
  dispatchBrowserRuntimeInput,
  isPrivateOrReservedAddress,
  PANE_CHROME_STORAGE_ARGS,
  readPageMetadata,
  recordBrowserFramesInSegments,
  recoverInterruptedBrowserCaptureJobs,
  releaseDisplay,
  resolveBrowserStreamProfile
} from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";
import { BrowserControlHeldError } from "../src/browser-errors.js";

describe("browser startup lifecycle", () => {
  it.each([false, true])("shares one launch and closes failures without leaking capacity (Xvfb=%s)", async (xvfb) => {
    const root = await mkdtemp(join(tmpdir(), "browser-startup-"));
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Startup proof", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, mode: "BROWSER", title: "Startup" });
    const create = vi.spyOn(store, "createPaneBrowserSession");
    const manager = createBrowserSessionManager({ store, config: getApiConfig({
      SPACE_BROWSER_SESSIONS_ENABLED: "true", SPACE_BROWSER_SESSIONS_XVFB_ENABLED: String(xvfb), SPACE_BROWSER_SESSIONS_XVFB_PATH: "/usr/bin/false",
      SPACE_BROWSER_SESSIONS_CHROME_PATH: "/usr/bin/false", SPACE_BROWSER_SESSIONS_PROFILE_ROOT: root
    }) });
    try {
      const starts = Array.from({ length: 6 }, () => manager.startOrRestore({ pane, targetUrl: "http://127.0.0.1:4911/", traceId: "test" }));
      const stopped = manager.stopPane(pane.id);
      const outcomes = await Promise.allSettled(starts);
      await stopped;
      expect(outcomes.every(outcome => outcome.status === "rejected")).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      if (xvfb) expect((outcomes[0] as PromiseRejectedResult).reason).toMatchObject({ errorCode: "BROWSER_XVFB_UNAVAILABLE", message: expect.stringContaining("exited before display") });
      expect(store.getActivePaneBrowserSession(pane.id)).toBeNull();
      expect(manager.capacity?.()).toMatchObject({ activeSessions: 0, activeLiveWorkloads: 0 });
    } finally { await manager.closeAll(); await rm(root, { recursive: true, force: true }); }
  });
});

describe("browser runtime network guard", () => {
  it("blocks private, metadata and IPv4-mapped IPv6 destinations", async () => {
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe"
    ]) {
      expect(isPrivateOrReservedAddress(address), address).toBe(true);
    }
    expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false);

    const resolver = async () => [{ address: "8.8.8.8" }];
    const guard = new BrowserRequestGuard("http://127.0.0.1:4911", { resolver });
    await expect(guard.assertAllowed("http://metadata.google.internal/latest/meta-data"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
    await expect(guard.assertAllowed("http://[::ffff:7f00:1]/private"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
  });

  it("allows the exact blank new-tab document while rejecting other non-web targets", async () => {
    const guard = new BrowserRequestGuard("http://127.0.0.1:4911");
    await expect(guard.assertAllowed("about:blank")).resolves.toBe("about:blank");
    for (const url of ["about:config", "about:blank?url=http://localhost", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,test"]) {
      await expect(guard.assertAllowed(url)).rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
    }
  });

  it("allows only the explicitly configured loopback origins", async () => {
    const guard = new BrowserRequestGuard([
      "http://127.0.0.1:4911",
      "http://127.0.0.1:3080"
    ]);

    await expect(guard.assertAllowed("http://127.0.0.1:3080/session#latest"))
      .resolves.toBe("http://127.0.0.1:3080/session");
    await expect(guard.assertAllowed("http://127.0.0.1:3081/"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
    await expect(guard.assertAllowed("http://localhost:3080/"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
  });

  it("allows the Harness origin through the shared browser-host guard path", async () => {
    await expect(assertSafeBrowserTargetUrl(
      "http://10.254.240.21:3080/session#latest",
      "http://127.0.0.1:4911"
    )).resolves.toBe("http://10.254.240.21:3080/session");
    await expect(assertSafeBrowserTargetUrl(
      "http://127.0.0.1:3081/",
      "http://127.0.0.1:4911"
    )).rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
  });

  it("bounds and caches DNS checks while rejecting mixed or stalled answers", async () => {
    let resolutions = 0;
    const guard = new BrowserRequestGuard("http://127.0.0.1:4911", {
      resolver: async () => {
        resolutions += 1;
        return [{ address: "8.8.8.8" }];
      },
      cacheTtlMs: 10_000
    });
    await expect(guard.assertAllowed("https://public.example/one")).resolves.toBe("https://public.example/one");
    await expect(guard.assertAllowed("https://public.example/two")).resolves.toBe("https://public.example/two");
    expect(resolutions).toBe(1);

    const mixed = new BrowserRequestGuard("http://127.0.0.1:4911", {
      resolver: async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }]
    });
    await expect(mixed.assertAllowed("https://mixed.example/"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });

    const stalled = new BrowserRequestGuard("http://127.0.0.1:4911", {
      resolver: async () => new Promise(() => undefined),
      timeoutMs: 10
    });
    await expect(stalled.assertAllowed("https://stalled.example/"))
      .rejects.toMatchObject({ errorCode: "BROWSER_TARGET_BLOCKED" });
  });
});

describe("browser session navigation restore", () => {
  it("restores the active URL and unique background tabs after a host restart", () => {
    expect(browserSessionRestoreUrls({
      status: "READY",
      currentUrl: "https://active.example/",
      activePageId: "page:active",
      pages: [
        { pageId: "page:active", kind: "PAGE", url: "https://active.example/", title: "Active", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false },
        { pageId: "page:two", kind: "PAGE", url: "https://two.example/", title: "Two", isActive: false, openerPageId: null, canGoBack: false, canGoForward: false },
        { pageId: "page:duplicate", kind: "PAGE", url: "https://two.example/", title: "Two", isActive: false, openerPageId: null, canGoBack: false, canGoForward: false }
      ]
    })).toEqual({ activeUrl: "https://active.example/", backgroundUrls: ["https://two.example/"] });
  });

  it("keeps the background tabs, but not the active page, when Chrome restarts during a navigation", () => {
    // A navigation owns the active page, and one that never committed must not be
    // reloaded; the other tabs are unrelated to it and must survive the restart.
    expect(browserSessionRestoreUrls({
      status: "NAVIGATING",
      currentUrl: "https://active.example/",
      activePageId: "page:active",
      pages: [
        { pageId: "page:active", kind: "PAGE", url: "https://active.example/", title: "Active", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false },
        { pageId: "page:two", kind: "PAGE", url: "https://two.example/", title: "Two", isActive: false, openerPageId: null, canGoBack: false, canGoForward: false },
        { pageId: "page:duplicate", kind: "PAGE", url: "https://two.example/", title: "Two", isActive: false, openerPageId: null, canGoBack: false, canGoForward: false },
        { pageId: "page:same-as-active", kind: "PAGE", url: "https://active.example/", title: "Active copy", isActive: false, openerPageId: null, canGoBack: false, canGoForward: false }
      ]
    })).toEqual({ activeUrl: null, backgroundUrls: ["https://two.example/"] });
  });

  it("requires navigation for restored active sessions that still have no current URL", () => {
    expect(
      browserSessionNeedsNavigation({
        targetUrl: "https://www.google.com/",
        currentUrl: null,
        status: "READY"
      })
    ).toBe(true);
  });

  it("requires navigation for starting and error sessions with a target URL", () => {
    expect(
      browserSessionNeedsNavigation({
        targetUrl: "https://www.google.com/",
        currentUrl: "https://www.google.com/",
        status: "STARTING"
      })
    ).toBe(true);

    expect(
      browserSessionNeedsNavigation({
        targetUrl: "https://www.google.com/",
        currentUrl: "https://www.google.com/",
        status: "ERROR"
      })
    ).toBe(true);
  });

  it("does not navigate already loaded ready sessions or sessions without a target", () => {
    expect(
      browserSessionNeedsNavigation({
        targetUrl: "https://www.google.com/",
        currentUrl: "https://www.google.com/",
        status: "READY"
      })
    ).toBe(false);

    expect(
      browserSessionNeedsNavigation({
        targetUrl: null,
        currentUrl: null,
        status: "READY"
      })
    ).toBe(false);
  });
});

describe("browser runtime v2 stream profiles", () => {
  it("resolves adaptive modes to bounded capture profiles", () => {
    expect(resolveBrowserStreamProfile("AUTO")).toEqual({
      requestedMode: "AUTO",
      resolvedMode: "INTERACTIVE",
      framesPerSecond: 10,
      format: "jpeg",
      quality: 70
    });
    expect(resolveBrowserStreamProfile("SILENT")).toMatchObject({ resolvedMode: "SILENT", framesPerSecond: 0 });
    expect(resolveBrowserStreamProfile("PREVIEW")).toMatchObject({ resolvedMode: "PREVIEW", framesPerSecond: 1 });
    expect(resolveBrowserStreamProfile("REALTIME")).toMatchObject({ resolvedMode: "REALTIME", framesPerSecond: 35, quality: 72 });
  });

  it("downgrades AUTO when the pane is hidden or under resource pressure", () => {
    expect(resolveBrowserStreamProfile("AUTO", { visible: false }).resolvedMode).toBe("SILENT");
    expect(resolveBrowserStreamProfile("AUTO", { resourcePressure: true }).resolvedMode).toBe("PREVIEW");
    expect(resolveBrowserStreamProfile("AUTO", { focused: true }).resolvedMode).toBe("REALTIME");
  });
});

describe("browser runtime realtime input dispatch", () => {
  it("completes ordered CDP input without capturing a screenshot", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const client = {
      async send(method: string, params: Record<string, unknown>, sessionId?: string) {
        commands.push({ method, params, sessionId });
        return {};
      }
    };

    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "POINTER",
      leaseId: "browser_lease:test",
      eventType: "mouseMoved",
      x: 720,
      y: 450,
      button: "none",
      modifiers: 2
    });

    expect(commands).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseMoved",
          x: 720,
          y: 450,
          button: "none",
          clickCount: 0,
          deltaX: 0,
          deltaY: 0,
          modifiers: 2
        },
        sessionId: "cdp-session:test"
      }
    ]);
    expect(commands.some((command) => command.method === "Page.captureScreenshot")).toBe(false);
  });

  it("inserts bounded multi-character text without dispatching an invalid CDP char event", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const client = {
      async send(method: string, params: Record<string, unknown>, sessionId?: string) {
        commands.push({ method, params, sessionId });
        return {};
      }
    };

    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "KEY",
      leaseId: "browser_lease:test",
      eventType: "char",
      key: "Unidentified",
      text: "realtime-mouse-proof",
      modifiers: 0
    });

    expect(commands).toEqual([
      {
        method: "Input.insertText",
        params: { text: "realtime-mouse-proof" },
        sessionId: "cdp-session:test"
      }
    ]);
    expect(commands.some((command) => command.method === "Page.captureScreenshot")).toBe(false);
  });

  it("dispatches special keys and shortcuts as CDP rawKeyDown with virtual key codes", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const client = {
      async send(method: string, params: Record<string, unknown>, sessionId?: string) {
        commands.push({ method, params, sessionId });
        return {};
      }
    };

    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "KEY",
      leaseId: "browser_lease:test",
      eventType: "keyDown",
      key: "Backspace",
      code: "Backspace",
      modifiers: 0
    });
    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "KEY",
      leaseId: "browser_lease:test",
      eventType: "keyDown",
      key: "c",
      code: "KeyC",
      modifiers: 2
    });
    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "KEY",
      leaseId: "browser_lease:test",
      eventType: "keyUp",
      key: "Backspace",
      code: "Backspace",
      modifiers: 0
    });

    expect(commands).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "Backspace", code: "Backspace", text: "", modifiers: 0, windowsVirtualKeyCode: 8 },
        sessionId: "cdp-session:test"
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "c", code: "KeyC", text: "", modifiers: 2, windowsVirtualKeyCode: 67 },
        sessionId: "cdp-session:test"
      },
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "Backspace", code: "Backspace", modifiers: 0, windowsVirtualKeyCode: 8 },
        sessionId: "cdp-session:test"
      }
    ]);
  });

  it("keeps printable keyDown events typed with their virtual key code", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const client = {
      async send(method: string, params: Record<string, unknown>, sessionId?: string) {
        commands.push({ method, params, sessionId });
        return {};
      }
    };

    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "KEY",
      leaseId: "browser_lease:test",
      eventType: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: 0
    });

    expect(commands).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 0, windowsVirtualKeyCode: 65 },
        sessionId: "cdp-session:test"
      }
    ]);
  });

  it.each([
    [".", "Period", 190], [">", "Period", 190],
    [",", "Comma", 188], ["<", "Comma", 188],
    ["/", "Slash", 191], ["?", "Slash", 191],
    [";", "Semicolon", 186], [":", "Semicolon", 186],
    ["'", "Quote", 222], ['"', "Quote", 222],
    ["-", "Minus", 189], ["_", "Minus", 189],
    ["=", "Equal", 187], ["+", "Equal", 187],
    ["[", "BracketLeft", 219], ["{", "BracketLeft", 219],
    ["]", "BracketRight", 221], ["}", "BracketRight", 221],
    ["\\", "Backslash", 220], ["|", "Backslash", 220],
    ["`", "Backquote", 192], ["~", "Backquote", 192],
    ["@", "Digit2", 50], ["%", "Digit5", 53],
    ["&", "Digit7", 55], ["(", "Digit9", 57],
    [".", "NumpadDecimal", 110], ["1", "Numpad1", 97],
    ["+", "NumpadAdd", 107], ["/", "NumpadDivide", 111],
    ["α", "KeyA", 65], ["é", "Digit2", 50],
    ["@", "Quote", 222]
  ])("preserves printable %s from %s without sending an editing key", async (key, code, expected) => {
    const commands: Array<Record<string, unknown>> = [];
    const client = { async send(_method: string, params: Record<string, unknown>) {
      commands.push(params);
    } };
    for (const eventType of ["keyDown", "keyUp"] as const) {
      await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
        type: "KEY", leaseId: "browser_lease:test", eventType, key, code,
        ...(eventType === "keyDown" ? { text: key } : {}), modifiers: 8
      });
    }
    expect(commands).toEqual([
      { type: "keyDown", key, code, text: key, modifiers: 8, windowsVirtualKeyCode: expected },
      { type: "keyUp", key, code, modifiers: 8, windowsVirtualKeyCode: expected }
    ]);
  });

  it.each([[".", 190], ["@", 50], ["_", 189], ["%", 53], ["a", 65], ["7", 55]])(
    "handles code-less printable %s without using Unicode as a virtual key",
    async (key, expected) => {
      const commands: Array<Record<string, unknown>> = [];
      await dispatchBrowserRuntimeInput({ async send(_method, params = {}) { commands.push(params); } }, "cdp-session:test", {
        type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key, text: key
      });
      expect(commands[0]).toMatchObject({ type: "keyDown", key, text: key, windowsVirtualKeyCode: expected });
    }
  );

  it.each(["α", "é", "中"])("types code-less Unicode %s without inventing a virtual key", async key => {
    const commands: Array<Record<string, unknown>> = [];
    await dispatchBrowserRuntimeInput({ async send(_method, params = {}) { commands.push(params); } }, "cdp-session:test", {
      type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key, text: key
    });
    expect(commands[0]).toMatchObject({ type: "keyDown", key, text: key });
    expect(commands[0]).not.toHaveProperty("windowsVirtualKeyCode");
  });

  it.each([["a", "KeyQ", 65], ["z", "KeyY", 90]])("preserves layout-aware Ctrl+%s shortcuts", async (key, code, expected) => {
    const commands: Array<Record<string, unknown>> = [];
    await dispatchBrowserRuntimeInput({ async send(_method, params = {}) { commands.push(params); } }, "cdp-session:test", {
      type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key, code, modifiers: 2
    });
    expect(commands[0]).toMatchObject({ type: "rawKeyDown", key, code, text: "", windowsVirtualKeyCode: expected });
  });

  it.each([["Delete", "Period", 46], ["Backspace", "Backspace", 8], ["ArrowLeft", "ArrowLeft", 37]])(
    "keeps the real %s editing key functional",
    async (key, code, expected) => {
      const commands: Array<Record<string, unknown>> = [];
      await dispatchBrowserRuntimeInput({ async send(_method, params = {}) { commands.push(params); } }, "cdp-session:test", {
        type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key, code
      });
      expect(commands[0]).toMatchObject({ type: "rawKeyDown", key, text: "", windowsVirtualKeyCode: expected });
    }
  );

  it("reloads the active page through CDP for NAVIGATION input", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const client = {
      async send(method: string, params: Record<string, unknown>, sessionId?: string) {
        commands.push({ method, params, sessionId });
        return {};
      }
    };

    await dispatchBrowserRuntimeInput(client, "cdp-session:test", {
      type: "NAVIGATION",
      leaseId: "browser_lease:test",
      action: "RELOAD"
    });

    expect(commands).toEqual([
      { method: "Page.reload", params: {}, sessionId: "cdp-session:test" }
    ]);
  });

  it("keys the persistent Chrome profile to the pane rather than the session", () => {
    const profilePath = browserProfilePathFor("/opt/spaceapp/var/artifacts/browser-profiles", "room:youtube-proof", "pane:youtube-proof");
    expect(profilePath).toBe("/opt/spaceapp/var/artifacts/browser-profiles/room_youtube-proof/pane_youtube-proof");
    expect(profilePath).not.toMatch(/browser_session/i);
  });
});

describe("browser runtime v2 capacity", () => {
  it("enforces eight sessions and four live workloads without double-counting keys", () => {
    const gate = new BrowserCapacityGate(8, 4);
    for (let index = 0; index < 8; index += 1) {
      expect(gate.acquireSession(`session:${index}`)).toBe(true);
    }
    expect(gate.acquireSession("session:0")).toBe(true);
    expect(gate.acquireSession("session:overflow")).toBe(false);

    for (let index = 0; index < 4; index += 1) {
      expect(gate.acquireLive(`stream:${index}`)).toBe(true);
    }
    expect(gate.acquireLive("stream:0")).toBe(true);
    expect(gate.acquireLive("stream:overflow")).toBe(false);
    expect(gate.snapshot()).toEqual({
      activeSessions: 8,
      maxSessions: 8,
      activeLiveWorkloads: 4,
      maxLiveWorkloads: 4
    });

    gate.releaseSession("session:0");
    gate.releaseLive("stream:0");
    expect(gate.acquireSession("session:replacement")).toBe(true);
    expect(gate.acquireLive("stream:replacement")).toBe(true);
  });

  it("lets streams use the session limit while recordings keep the live limit", () => {
    const gate = new BrowserCapacityGate(8, 4);
    for (let index = 0; index < 8; index += 1) {
      expect(gate.acquireLive(`stream:${index}`, gate.maxSessions)).toBe(true);
    }
    expect(gate.acquireLive("stream:overflow", gate.maxSessions)).toBe(false);
    expect(gate.acquireLive("capture:job")).toBe(false);
    for (let index = 0; index < 5; index += 1) gate.releaseLive(`stream:${index}`);
    expect(gate.acquireLive("capture:job")).toBe(true);
  });
});

describe("browser runtime v2 agent numbering", () => {
  it("ignores closed historical panes so browser agent numbers stay within contract bounds", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Historical room", initialPaneCount: 0 });
    for (let index = 0; index < 105; index += 1) {
      const pane = store.createPane({ roomId: room.id, title: `Closed ${index}`, mode: "CHAT" });
      store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
    }
    const first = store.createPane({ roomId: room.id, title: "Browser 1", mode: "BROWSER" });
    const second = store.createPane({ roomId: room.id, title: "Browser 2", mode: "BROWSER" });

    await expect(browserAgentNumberForPane(store, first)).resolves.toBe(1);
    await expect(browserAgentNumberForPane(store, second)).resolves.toBe(2);
  });
});

describe("browser runtime v2 control leases", () => {
  it("persists an exclusive lease, heartbeats it and releases operator control", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Lease room", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:lease-test",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:lease-test",
      profilePath: "/tmp/space-browser-lease-test",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }) });

    const acquired = await manager.acquireControl!(pane, {
      holderType: "OPERATOR",
      holderId: "user:test",
      reason: "captcha handoff",
      ttlSeconds: 30
    }, "trace:acquire");
    expect(acquired).toMatchObject({ sessionId: session.sessionId, holderType: "OPERATOR", status: "ACTIVE" });
    expect(store.getPaneBrowserSession(session.sessionId)?.controlState).toBe("OPERATOR");

    await expect(
      manager.action(pane, { type: "screenshot" }, "trace:agent-action", { holderType: "AGENT", holderId: "agent:test" })
    ).rejects.toMatchObject<BrowserControlHeldError>({
      errorCode: "BROWSER_CONTROL_HELD",
      details: {
        sessionId: session.sessionId,
        paneId: pane.id,
        roomId: room.id,
        leaseId: acquired.leaseId,
        holderType: "OPERATOR",
        holderId: "user:test",
        expiresAt: acquired.expiresAt,
        reason: "captcha handoff"
      }
    });

    const agent = { holderType: "AGENT" as const, holderId: "agent:test" };
    const mutators = [
      () => manager.startOrRestore({ pane, traceId: "trace:restore" }, agent),
      () => manager.navigate(pane, "https://example.com/", "trace:navigate", agent),
      () => manager.setViewport(pane, "mobile", "trace:viewport", agent),
      () => manager.setStreamMode!(pane, "SILENT", "trace:stream", agent),
      () => manager.createPage!(pane, undefined, false, "trace:create-page", agent),
      () => manager.activatePage!(pane, "page:test", "trace:activate-page", agent),
      () => manager.closePage!(pane, "page:test", "trace:close-page", agent),
      () => manager.createCapture!(pane, {
        kind: "SCREENSHOT",
        format: "PNG",
        target: "VIEWPORT",
        selector: null,
        quality: null
      }, { requestedByType: "AGENT", requestedById: "agent:test", traceId: "trace:capture" }),
      () => manager.stopPane(pane.id, "trace:stop", agent)
    ];
    for (const mutation of mutators) {
      await expect(mutation()).rejects.toMatchObject({ errorCode: "BROWSER_CONTROL_HELD", details: { leaseId: acquired.leaseId } });
    }

    await expect(
      manager.acquireControl!(pane, { holderType: "AGENT", holderId: "agent:test", reason: null, ttlSeconds: 30 }, "trace:blocked")
    ).rejects.toThrow(/held by operator/i);

    const heartbeat = await manager.heartbeatControl!(pane, { leaseId: acquired.leaseId, ttlSeconds: 60 }, "trace:heartbeat");
    expect(heartbeat.status).toBe("ACTIVE");
    expect(Date.parse(heartbeat.expiresAt)).toBeGreaterThan(Date.parse(acquired.expiresAt));

    const released = await manager.releaseControl!(pane, { leaseId: acquired.leaseId }, "trace:release");
    expect(released.status).toBe("RELEASED");
    expect(store.getPaneBrowserSession(session.sessionId)?.controlState).toBe("UNCONTROLLED");
  });
});

describe("browser capture lifecycle controls", () => {
  it("reports persisted job and segment metrics for active sessions", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Capture metrics", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:capture-metrics",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:capture-metrics",
      profilePath: "/tmp/space-browser-capture-metrics",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const jobStatuses = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;
    const jobs = jobStatuses.map((status, index) => {
      const job = store.createBrowserCaptureJob({
        jobId: `browser_capture:metrics-${index}`,
        sessionId: session.sessionId,
        paneId: pane.id,
        roomId: room.id,
        requestedByType: "AGENT",
        requestedById: "agent:metrics",
        options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 60_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
      });
      return status === "QUEUED" ? job : store.updateBrowserCaptureJob(job.jobId, { status });
    });
    const segmentStatuses = ["OPEN", "FINALIZED", "FAILED", "DISCARDED"] as const;
    segmentStatuses.forEach((status, index) => {
      const segment = store.createBrowserCaptureSegment({ jobId: jobs[0]!.jobId, sessionId: session.sessionId, sequence: index });
      if (status !== "OPEN") store.updateBrowserCaptureSegment(segment.segmentId, { status });
    });
    const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }) });

    await expect(manager.captureMetrics!()).resolves.toEqual({
      jobs: { QUEUED: 1, RUNNING: 1, COMPLETED: 1, FAILED: 1, CANCELLED: 1 },
      segments: { OPEN: 1, FINALIZED: 1, FAILED: 1, DISCARDED: 1 }
    });
  });

  it("stops and cancels queued recording jobs deterministically", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Capture controls", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:capture-controls",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:capture-controls",
      profilePath: "/tmp/space-browser-capture-controls",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const captureOptions = {
      kind: "RECORDING" as const,
      format: "WEBM" as const,
      maxDurationMs: 60_000,
      maxBytes: 1_073_741_824,
      frameIntervalMs: 100
    };
    const stoppedJob = store.createBrowserCaptureJob({
      jobId: "browser_capture_job:stop",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:test",
      options: captureOptions
    });
    const cancelledJob = store.createBrowserCaptureJob({
      jobId: "browser_capture_job:cancel",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:test",
      options: captureOptions
    });
    const manager = createBrowserSessionManager({ store, config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true" }) });

    await expect(manager.stopCapture!(pane, stoppedJob.jobId, "trace:stop")).resolves.toMatchObject({
      status: "COMPLETED",
      progressPercent: 100
    });
    await expect(manager.cancelCapture!(pane, cancelledJob.jobId, "trace:cancel")).resolves.toMatchObject({
      status: "CANCELLED"
    });
  });

  it("persists five-second WebM segments and finalizes the current segment on stop", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Segmented recording", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:segments",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:segments",
      profilePath: "/tmp/space-browser-segments",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const job = store.createBrowserCaptureJob({
      jobId: "browser_capture:segments",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:test",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 15_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-browser-segments-"));
    let now = 0;
    let encodeAttempts = 0;

    const result = await recordBrowserFramesInSegments({
      store,
      job,
      session,
      artifactRoot,
      capturePng: async () => Buffer.from(`frame:${now}`),
      encodeSegment: async ({ outputPath }) => {
        encodeAttempts += 1;
        if (encodeAttempts === 1) {
          return { ok: true, stderr: "", exitCode: 0, signal: null };
        }
        await writeFile(outputPath, `segment:${outputPath}`);
        return { ok: true, stderr: "" };
      },
      concatenateSegments: async ({ outputPath, segmentPaths }) => {
        await writeFile(outputPath, segmentPaths.join("\n"));
        return { ok: true, stderr: "" };
      },
      registerSegmentArtifact: async ({ filename, filePath }) => {
        const artifact = store.createArtifact({
          roomId: room.id,
          paneId: pane.id,
          kind: "VIDEO",
          mimeType: "video/webm",
          storageUri: `space-artifact://browser-evidence/browser_capture_segments/${filename}`,
          sha256: "a".repeat(64),
          byteSize: (await readFile(filePath)).byteLength,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          metadata: { browserCaptureJobId: job.jobId }
        });
        return artifact.artifact.id;
      },
      readTimelineEvents: async () => [{
        eventId: "browser_event:segment-test",
        sessionId: session.sessionId,
        pageId: null,
        sequence: 0,
        type: "CONSOLE",
        level: "INFO",
        message: "segment console event",
        frameIndex: null,
        metadata: {},
        occurredAt: new Date(now).toISOString()
      }],
      readCommand: () => now >= 6_000 ? "STOP" : undefined,
      nowMs: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    });

    expect(store.listBrowserCaptureSegments(job.jobId)).toMatchObject([
      { sequence: 0, status: "FINALIZED", frameCount: 5, lastFrameSequence: 4 },
      { sequence: 1, status: "FINALIZED", frameCount: 1, lastFrameSequence: 5 }
    ]);
    expect(encodeAttempts).toBe(3);
    expect(result.frameCount).toBe(6);
    expect(result.frames.map((frame) => frame.elapsedMs)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      type: "browser_recording",
      frameCount: 6,
      segmentCount: 2,
      stopped: true,
      events: [{ eventId: "browser_event:segment-test" }]
    });
    await expect(access(result.webmPath)).resolves.toBeUndefined();
  });

  it("completes with a recorded gap when one retry cannot encode a later segment", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Recording gap", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:gap",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:gap",
      profilePath: "/tmp/space-browser-gap",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const job = store.createBrowserCaptureJob({
      jobId: "browser_capture:gap",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:test",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 6_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-browser-gap-"));
    let now = 0;
    let encodeAttempts = 0;

    const result = await recordBrowserFramesInSegments({
      store,
      job,
      session,
      artifactRoot,
      capturePng: async () => Buffer.from(`frame:${now}`),
      encodeSegment: async ({ outputPath }) => {
        encodeAttempts += 1;
        if (encodeAttempts === 1) {
          await writeFile(outputPath, "finalized segment");
          return { ok: true, stderr: "" };
        }
        await writeFile(outputPath, "partial segment output");
        return { ok: false, stderr: "encoder exploded", exitCode: 23, signal: "SIGTERM" };
      },
      concatenateSegments: async ({ outputPath, segmentPaths }) => {
        await writeFile(outputPath, segmentPaths.join("\n"));
        return { ok: true, stderr: "" };
      },
      registerSegmentArtifact: async ({ filename, filePath }) => {
        const artifact = store.createArtifact({
          roomId: room.id,
          paneId: pane.id,
          kind: "VIDEO",
          mimeType: "video/webm",
          storageUri: `space-artifact://browser-evidence/browser_capture_gap/${filename}`,
          sha256: "c".repeat(64),
          byteSize: (await readFile(filePath)).byteLength,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          metadata: { browserCaptureJobId: job.jobId }
        });
        return artifact.artifact.id;
      },
      nowMs: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    });

    expect(encodeAttempts).toBe(3);
    expect(store.listBrowserCaptureSegments(job.jobId)).toMatchObject([
      { sequence: 0, status: "FINALIZED" },
      {
        sequence: 1,
        status: "FAILED",
        statusReason: "WebM segment encoding failed after 2 attempts (exitCode=23, signal=SIGTERM): encoder exploded"
      }
    ]);
    expect(result).toMatchObject({ segmentCount: 1, skippedSegmentCount: 1, stopped: false });
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      skippedSegmentCount: 1,
      gaps: [{ sequence: 1, reason: expect.stringContaining("encoder exploded") }]
    });
    await expect(access(result.webmPath)).resolves.toBeUndefined();
    await expect(access(join(result.recordingDir, "segment-0001.webm"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards unpinned segment artifacts and files when a running recording is cancelled", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Cancelled recording", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:cancel-segments",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:cancel-segments",
      profilePath: "/tmp/space-browser-cancel-segments",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const job = store.createBrowserCaptureJob({
      jobId: "browser_capture:cancel-segments",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "OPERATOR",
      requestedById: "user:test",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 15_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-browser-cancel-segments-"));
    const artifactIds: string[] = [];
    let now = 0;

    await expect(recordBrowserFramesInSegments({
      store,
      job,
      session,
      artifactRoot,
      capturePng: async () => Buffer.from(`frame:${now}`),
      encodeSegment: async ({ outputPath }) => {
        await writeFile(outputPath, "segment");
        return { ok: true, stderr: "" };
      },
      concatenateSegments: async () => ({ ok: true, stderr: "" }),
      registerSegmentArtifact: async ({ filename, filePath }) => {
        const record = store.createArtifact({
          roomId: room.id,
          paneId: pane.id,
          kind: "VIDEO",
          mimeType: "video/webm",
          storageUri: `space-artifact://browser-evidence/browser_capture_cancel/${filename}`,
          sha256: "b".repeat(64),
          byteSize: (await readFile(filePath)).byteLength,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          metadata: { browserCaptureJobId: job.jobId }
        });
        artifactIds.push(record.artifact.id);
        return record.artifact.id;
      },
      readCommand: () => now >= 6_000 ? "CANCEL" : undefined,
      nowMs: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    })).rejects.toMatchObject({ name: "BrowserCaptureCancelledError" });

    expect(store.listBrowserCaptureSegments(job.jobId).map((segment) => segment.status)).toEqual(["DISCARDED", "DISCARDED"]);
    expect(artifactIds).toHaveLength(1);
    expect(() => store.getArtifact(artifactIds[0]!)).toThrow(/was not found/i);
  });

  it("fails an interrupted open segment and resumes after restart at the next sequence", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Recording recovery", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:recovery",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:recovery",
      profilePath: "/tmp/space-browser-recovery",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const job = store.createBrowserCaptureJob({
      jobId: "browser_capture:recovery",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "AGENT",
      requestedById: "agent:test",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 60_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    store.updateBrowserCaptureJob(job.jobId, { status: "RUNNING", progressPercent: 40 });
    const artifactRoot = await mkdtemp(join(tmpdir(), "space-browser-recovery-"));
    const recordingDir = join(artifactRoot, "browser-evidence", "browser_capture_recovery");
    await mkdir(recordingDir, { recursive: true });
    const finalizedPath = join(recordingDir, "segment-0000.webm");
    await writeFile(finalizedPath, "finalized before restart");
    const finalizedArtifact = store.createArtifact({
      roomId: room.id,
      paneId: pane.id,
      kind: "VIDEO",
      mimeType: "video/webm",
      storageUri: "space-artifact://browser-evidence/browser_capture_recovery/segment-0000.webm",
      sha256: "d".repeat(64),
      byteSize: (await readFile(finalizedPath)).byteLength,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      metadata: { browserCaptureJobId: job.jobId }
    });
    const finalized = store.createBrowserCaptureSegment({ jobId: job.jobId, sessionId: session.sessionId, sequence: 0 });
    store.updateBrowserCaptureSegment(finalized.segmentId, {
      status: "FINALIZED",
      artifactId: finalizedArtifact.artifact.id,
      storageUri: "space-artifact://browser-evidence/browser_capture_recovery/segment-0000.webm",
      sha256: "d".repeat(64),
      byteSize: (await readFile(finalizedPath)).byteLength,
      durationMs: 5_000,
      frameCount: 5,
      lastFrameSequence: 4,
      statusReason: "Segment finalized."
    });
    store.createBrowserCaptureSegment({ jobId: job.jobId, sessionId: session.sessionId, sequence: 1 });

    await expect(recoverInterruptedBrowserCaptureJobs(store, artifactRoot)).resolves.toEqual({
      failedSegments: 1,
      requeuedJobs: [job.jobId]
    });
    expect(store.listBrowserCaptureSegments(job.jobId)[1]).toMatchObject({
      status: "FAILED",
      statusReason: "Browser Host restarted before the segment was finalized."
    });
    expect(store.getBrowserCaptureJob(job.jobId)).toMatchObject({
      status: "QUEUED",
      statusReason: "Browser Host restarted; recording will resume with the next segment."
    });

    let now = 0;
    const recoveredJob = store.getBrowserCaptureJob(job.jobId)!;
    const result = await recordBrowserFramesInSegments({
      store,
      job: recoveredJob,
      session,
      artifactRoot,
      capturePng: async () => Buffer.from(`recovered:${now}`),
      encodeSegment: async ({ outputPath }) => {
        await writeFile(outputPath, "segment after restart");
        return { ok: true, stderr: "" };
      },
      concatenateSegments: async ({ outputPath, segmentPaths }) => {
        await writeFile(outputPath, segmentPaths.join("\n"));
        return { ok: true, stderr: "" };
      },
      registerSegmentArtifact: async ({ filename, filePath }) => {
        const artifact = store.createArtifact({
          roomId: room.id,
          paneId: pane.id,
          kind: "VIDEO",
          mimeType: "video/webm",
          storageUri: `space-artifact://browser-evidence/browser_capture_recovery/${filename}`,
          sha256: "e".repeat(64),
          byteSize: (await readFile(filePath)).byteLength,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          metadata: { browserCaptureJobId: job.jobId }
        });
        return artifact.artifact.id;
      },
      readCommand: () => now >= 1_000 ? "STOP" : undefined,
      nowMs: () => now,
      sleep: async (milliseconds) => { now += milliseconds; }
    });

    expect(store.listBrowserCaptureSegments(job.jobId).map(({ sequence, status }) => ({ sequence, status }))).toEqual([
      { sequence: 0, status: "FINALIZED" },
      { sequence: 1, status: "FAILED" },
      { sequence: 2, status: "FINALIZED" }
    ]);
    expect(result).toMatchObject({ segmentCount: 2, skippedSegmentCount: 1, frameCount: 6 });
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      skippedSegmentCount: 1,
      gaps: [{ sequence: 1, reason: "Browser Host restarted before the segment was finalized." }]
    });
  });

  it("requeues a failed recording when shutdown left an open segment", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Shutdown recovery race", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
    const session = store.createPaneBrowserSession({
      sessionId: "browser_session:shutdown-race",
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "profile:shutdown-race",
      profilePath: "/tmp/space-browser-shutdown-race",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      currentUrl: "https://example.com/",
      status: "READY",
      isActive: true
    });
    const job = store.createBrowserCaptureJob({
      jobId: "browser_capture:shutdown-race",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "AGENT",
      requestedById: "agent:test",
      options: { kind: "RECORDING", format: "WEBM", maxDurationMs: 60_000, maxBytes: 10_000, frameIntervalMs: 1_000 }
    });
    store.updateBrowserCaptureJob(job.jobId, {
      status: "FAILED",
      statusReason: "Chrome DevTools Protocol socket closed.",
      completedAt: new Date().toISOString()
    });
    store.createBrowserCaptureSegment({ jobId: job.jobId, sessionId: session.sessionId, sequence: 0 });

    await expect(recoverInterruptedBrowserCaptureJobs(store)).resolves.toEqual({
      failedSegments: 1,
      requeuedJobs: [job.jobId]
    });
    expect(store.listBrowserCaptureSegments(job.jobId)).toMatchObject([{
      sequence: 0,
      status: "FAILED",
      statusReason: "Browser Host restarted before the segment was finalized."
    }]);
    expect(store.getBrowserCaptureJob(job.jobId)).toMatchObject({
      status: "QUEUED",
      statusReason: "Browser Host restarted; recording will resume with the next segment.",
      completedAt: null
    });
  });
});

describe("browser session restore metadata", () => {
  it("rewrites YouTube watch URLs with the current time and floors scroll positions", async () => {
    let sentExpression = "";
    const client = {
      async send(method: string, params: Record<string, unknown>) {
        expect(method).toBe("Runtime.evaluate");
        sentExpression = String(params.expression);
        return {
          result: {
            value: {
              href: "https://www.youtube.com/watch?v=7k6t_9TAmh8",
              title: "A Video",
              videoTime: 10115,
              scrollX: 1200.4,
              scrollY: 8412.9,
              videoPaused: true
            }
          }
        };
      }
    };

    await expect(readPageMetadata(client, "cdp-session:meta")).resolves.toEqual({
      currentUrl: "https://www.youtube.com/watch?v=7k6t_9TAmh8&t=10115s",
      title: "A Video",
      scrollX: 1200,
      scrollY: 8412,
      videoPaused: true
    });
    expect(sentExpression).toContain("document.querySelector('video')");
  });

  it("drops about:blank hrefs and omits absent scroll and playback state", async () => {
    let sentExpression = "";
    const client = {
      async send(_method: string, params: Record<string, unknown>) {
        sentExpression = String(params.expression);
        return {
          result: {
            value: {
              href: "about:blank",
              title: null,
              videoTime: null,
              scrollX: 0,
              scrollY: 0
            }
          }
        };
      }
    };

    await expect(readPageMetadata(client, "cdp-session:meta-blank")).resolves.toEqual({
      currentUrl: "about:blank",
      title: null,
      scrollX: 0,
      scrollY: 0
    });
    expect(sentExpression).toContain("location.href !== 'about:blank'");
  });

  it("does not evaluate any CDP state when there is nothing to restore", async () => {
    const client = {
      async send() {
        throw new Error("should not be called");
      }
    };

    await expect(applyRestoreState(client, "cdp-session:none", { scrollY: null })).resolves.toBeUndefined();
  });

  it("applies scroll and video pause in one expression and stops once ready", async () => {
    const expressions: string[] = [];
    const client = {
      async send(_method: string, params: Record<string, unknown>) {
        expressions.push(String(params.expression));
        return { result: { value: { scrolled: true, media: true } } };
      }
    };

    await expect(applyRestoreState(client, "cdp-session:apply", { scrollX: 0, scrollY: 8412, videoPaused: true })).resolves.toBeUndefined();
    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("const sy = 8412;");
    expect(expressions[0]).toContain("window.scrollTo(sx === null ? 0 : sx, sy)");
    expect(expressions[0]).toContain("v.pause()");
  });

  it("retries until the page reports both scrolled and media ready", async () => {
    let calls = 0;
    const client = {
      async send() {
        calls += 1;
        return calls === 1
          ? { result: { value: { scrolled: false, media: true } } }
          : { result: { value: { scrolled: true, media: true } } };
      }
    };

    await expect(applyRestoreState(client, "cdp-session:retry", { scrollY: 500, videoPaused: false })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("browser session display pool", () => {
  it("allocates up to ten displays and reuses released ones", () => {
    const allocated = new Set<number>();
    for (let index = 0; index < 10; index += 1) {
      const display = allocateDisplay();
      expect(display).not.toBeNull();
      allocated.add(display!);
    }
    expect(allocated.size).toBe(10);
    expect(allocateDisplay()).toBeNull();

    const first = [...allocated][0]!;
    releaseDisplay(first);
    expect(allocateDisplay()).toBe(first);

    for (const display of allocated) releaseDisplay(display);
    expect(allocateDisplay()).not.toBeNull();
  });
});

describe("responsive viewport bounds", () => {
  it("accepts pane dimensions and rejects unbounded or incomplete viewports", () => {
    expect(browserSetViewportInputSchema.parse({ viewport: "desktop", dimensions: { width: 800, height: 600 } }).dimensions).toEqual({ width: 800, height: 600 });
    for (const dimensions of [{ width: 0, height: 600 }, { width: 99999, height: 600 }, { width: 800 }, { width: 800.5, height: 600 }]) {
      expect(browserSetViewportInputSchema.safeParse({ viewport: "desktop", dimensions }).success).toBe(false);
    }
  });
});

describe("live frame pacing", () => {
  it("keeps 35 fps from a 60 Hz source without a stale-frame burst after idle", () => {
    let deadline = 0, count = 0;
    for (let i = 0; i < 600; i++) {
      const next = nextBrowserFrameDeadline(i * 1000 / 60, deadline, 35);
      if (next !== null) { deadline = next; count++; }
    }
    expect(count).toBeGreaterThanOrEqual(349);
    expect(count).toBeLessThanOrEqual(351);
    const resumed = nextBrowserFrameDeadline(30000, deadline, 35)!;
    expect(resumed).toBeCloseTo(30000 + 1000 / 35);
    expect(nextBrowserFrameDeadline(30001, resumed, 35)).toBeNull();
  });
});

describe("pane Chrome storage flags (plan clipboard:LPzoMHnHzK9A F7)", () => {
  it("caps the HTTP cache, stops on-device model downloads and keeps one --disable-features with Vulkan", () => {
    expect(PANE_CHROME_STORAGE_ARGS).toContain("--disk-cache-size=268435456");
    const disabled = PANE_CHROME_STORAGE_ARGS.filter((arg) => arg.startsWith("--disable-features="));
    expect(disabled).toHaveLength(1);
    expect(disabled[0].slice("--disable-features=".length).split(",")).toEqual(expect.arrayContaining(["Vulkan", "OptimizationGuideModelDownloading"]));
  });
});
