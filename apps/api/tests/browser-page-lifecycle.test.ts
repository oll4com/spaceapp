import { describe, expect, it, vi } from "vitest";
import type { BrowserPageSummary, Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { withBrowserPageLifecycle } from "../src/browser-page-lifecycle.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";

const pane = { id: "pane:tabs" } as Pane;
const actor = { holderType: "OPERATOR" as const, holderId: "user:tabs" };

function runtime(ids = ["one", "two"]) {
  let pages = [...ids];
  let active = ids[0];
  let serial = 0;
  let stored = { sessionId: "session:tabs", status: "READY", isActive: true } as PaneBrowserSession;
  const store = {
    getLatestPaneBrowserSession: vi.fn(async () => stored),
    updatePaneBrowserSession: vi.fn(async (_id: string, patch: Partial<PaneBrowserSession>) => (stored = { ...stored, ...patch }))
  } as unknown as Pick<SpaceStore, "getLatestPaneBrowserSession" | "updatePaneBrowserSession">;
  const snapshot = () => ({ sessionId: "session:tabs", activePageId: active,
    pages: pages.map((pageId) => ({ pageId, url: pageId.startsWith("blank:") ? "about:blank" : "https://example.com/", isActive: pageId === active } as BrowserPageSummary)) });
  const host = {
    startOrRestore: vi.fn(async () => ({ session: stored, frame: null, websocket: null })),
    stopPane: vi.fn(async () => { pages = []; active = undefined; stored = { ...stored, status: "CLOSED", isActive: false }; }),
    listPages: vi.fn(async () => snapshot()),
    createPage: vi.fn(async () => { active = `blank:${++serial}`; pages.push(active); return snapshot(); }),
    activatePage: vi.fn(async (_pane: Pane, id: string) => { active = id; return snapshot(); }),
    closePage: vi.fn(async (_pane: Pane, id: string) => {
      if (!pages.includes(id)) throw new SpaceNotFoundError("missing page");
      if (pages.length === 1) throw new SpaceConflictError("last page");
      if (active === id) throw new Error("Cannot destroy the attached stream target");
      pages = pages.filter((pageId) => pageId !== id);
      return snapshot();
    })
  };
  const manager = withBrowserPageLifecycle(host as unknown as BrowserSessionManager, store);
  return { manager, host, snapshot, store };
}

describe("shared browser tab lifecycle", () => {
  it("closes the active page without destroying the stream attachment and makes retries idempotent", async () => {
    const { manager, host } = runtime();
    const result = await manager.closePage!(pane, "one", "trace", actor);
    expect(result.pages.map((page) => page.pageId)).toEqual(["two"]);
    expect(result.activePageId).toBe("two");
    expect(host.activatePage).toHaveBeenCalledWith(pane, "two", "trace", actor);
    expect(host.closePage).toHaveBeenCalledWith(pane, "one", "trace", actor);
    await expect(manager.closePage!(pane, "one", "trace", actor)).resolves.toEqual(result);
    expect(host.closePage).toHaveBeenCalledOnce();
    expect(host.createPage).not.toHaveBeenCalled();
  });

  it("serializes concurrent closes, releases the final runtime and persists zero tabs", async () => {
    const { manager, host, store } = runtime();
    await Promise.all(["one", "two", "two"].map((id) => manager.closePage!(pane, id, "trace", actor)));
    const result = await manager.listPages!(pane);
    expect(result).toEqual({ sessionId: "session:tabs", pages: [], activePageId: null });
    expect(host.createPage).not.toHaveBeenCalled();
    expect(host.stopPane).toHaveBeenCalledExactlyOnceWith(pane.id, "trace", actor);
    expect(host.closePage).toHaveBeenCalledTimes(1);
    const reloaded = withBrowserPageLifecycle(host as unknown as BrowserSessionManager, store);
    await expect(reloaded.listPages!(pane)).resolves.toEqual(result);
    await expect(reloaded.closePage!(pane, "two", "trace", actor)).resolves.toEqual(result);
    expect(host.stopPane).toHaveBeenCalledTimes(1);
  });

  it("removes Chrome's extra startup blank only for a newly started blank session", async () => {
    const { manager, host } = runtime(["active", "startup"]);
    const current = { sessionId: "new-session", activePageId: "active", pages: [
      { pageId: "active", url: "about:blank", isActive: true }, { pageId: "startup", url: "about:blank", isActive: false }
    ] as BrowserPageSummary[] };
    host.startOrRestore.mockResolvedValueOnce({ session: { sessionId: "new-session" } as PaneBrowserSession, frame: null, websocket: null });
    host.listPages.mockResolvedValueOnce(current);
    host.closePage.mockResolvedValueOnce({ ...current, pages: current.pages.slice(0, 1) });
    const response = await manager.startOrRestore({ pane, targetUrl: "about:blank", traceId: "trace" }, actor);
    expect(response.session.pages).toEqual(current.pages.slice(0, 1));
    expect(host.closePage).toHaveBeenCalledExactlyOnceWith(pane, "startup", "trace", actor);
    host.closePage.mockClear();
    await manager.startOrRestore({ pane, targetUrl: "about:blank", traceId: "trace" }, actor);
    expect(host.closePage).not.toHaveBeenCalled();
  });

  it("removes stale IDs from the result without closing any replacement page", async () => {
    const { manager, host, snapshot } = runtime();
    await expect(manager.closePage!(pane, "old-chrome-target", "trace", actor)).resolves.toEqual(snapshot());
    expect(host.closePage).not.toHaveBeenCalled();
    expect(host.activatePage).not.toHaveBeenCalled();
    expect(host.createPage).not.toHaveBeenCalled();
  });

  it("preserves lease denials when closing the final tab", async () => {
    const { manager, host } = runtime(["one"]);
    const denied = new SpaceConflictError("Browser control is held by another actor");
    host.stopPane.mockRejectedValueOnce(denied);
    await expect(manager.closePage!(pane, "one", "trace", actor)).rejects.toBe(denied);
    expect(host.closePage).not.toHaveBeenCalled();
    await expect(manager.closePage!(pane, "one", "trace", actor)).resolves.toMatchObject({ activePageId: null, pages: [] });
  });

  it("reconciles a target that disappears during close, but preserves unrelated failures", async () => {
    const { manager, host } = runtime();
    const close = host.closePage.getMockImplementation()!;
    host.closePage.mockImplementationOnce(async (...args) => {
      await close(...args);
      throw new SpaceNotFoundError("target already gone");
    });
    await expect(manager.closePage!(pane, "one", "trace", actor)).resolves.toMatchObject({ activePageId: "two" });
    host.stopPane.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(manager.closePage!(pane, "two", "trace", actor)).rejects.toThrow("transport unavailable");
  });
});
