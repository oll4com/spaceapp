import { describe, expect, it, vi } from "vitest";
import { executeBrowserSelectAction } from "../src/browser-select-action.js";
import { readChromeAutomationEndpoint } from "../src/cli-browser-cdp.js";

vi.mock("../src/cli-browser-cdp.js", () => ({
  activeTabProfilePath: vi.fn(async () => "/owned/profile"),
  readChromeAutomationEndpoint: vi.fn(async () => "ws://127.0.0.1:9876/devtools/browser/proof")
}));

const state = { selectedIndex: 0, box: { x: 100, y: 120, width: 200, height: 36 }, labels: ["United States", "Greece"], disabled: [], truncated: false };
function fixture(value: unknown = state) {
  const session = { sessionId: "browser_session:owned", activePageId: "page:owned", profilePath: "/owned/profile", pages: [{ pageId: "page:owned" }] };
  const result = { session, text: "null", frame: null };
  const calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  const client = {
    send: async <T,>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") return { sessionId: "page-session" } as T;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "page:owned" } } } as T;
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 } as T;
      if (method === "Runtime.evaluate") {
        const chosen = /selectedIndex = (\d+)/.exec(String(params?.expression))?.[1];
        return { result: { value: chosen && value ? { ...(value as object), selectedIndex: Number(chosen) } : value } } as T;
      }
      return {} as T;
    },
    close: vi.fn()
  };
  const connect = vi.fn(async () => client);
  const action = vi.fn(async () => result);
  const captureFrame = vi.fn(async () => ({ frameId: "frame:after-pick" }));
  const options = {
    manager: { action, captureFrame }, config: { browserHostTransport: "unix", browserSessionsProfileRoot: "/profiles" },
    pane: { id: "pane:owned", roomId: "room:owned" }, input: { type: "select_state", sessionId: session.sessionId },
    traceId: "trace:pick", context: { holderType: "OPERATOR", holderId: "user:operator" }
  } as unknown as Parameters<typeof executeBrowserSelectAction>[0];
  return { options, result, action, captureFrame, client, connect, calls };
}

describe("the API dropdown fallback with an unchanged Unix Browser Host", () => {
  it("keeps the host's control/session checks before reading a tab through CDP", async () => {
    const f = fixture();
    const result = await executeBrowserSelectAction(f.options, f.connect);
    expect(f.action).toHaveBeenCalledWith(f.options.pane, f.options.input, f.options.traceId, f.options.context);
    expect(f.action.mock.invocationCallOrder[0]).toBeLessThan(f.connect.mock.invocationCallOrder[0]!);
    expect(JSON.parse(result.text!)).toEqual(state);
    expect(f.calls[0]).toEqual({ method: "Target.attachToTarget", params: { targetId: "page:owned", flatten: true }, sessionId: undefined });
    expect(f.calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "page-session" } });
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.captureFrame).not.toHaveBeenCalled();
  });

  it("does not connect when the host refuses control, including a stale session", async () => {
    const f = fixture();
    f.action.mockRejectedValue(new Error("Browser control is held / session changed"));
    await expect(executeBrowserSelectAction(f.options, f.connect)).rejects.toThrow("Browser control is held");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("picks by index after the host check, then gets the normal host frame", async () => {
    const f = fixture();
    f.options.input = { type: "select_choose", sessionId: "browser_session:owned", index: 1 };
    const result = await executeBrowserSelectAction(f.options, f.connect);
    expect(f.action).toHaveBeenCalledWith(f.options.pane, { type: "select_state", sessionId: "browser_session:owned" }, f.options.traceId, f.options.context);
    expect(result).toMatchObject({ text: 'Chose "Greece".', frame: { frameId: "frame:after-pick" } });
    expect(f.captureFrame).toHaveBeenCalledWith("browser_session:owned");
    expect(f.calls.filter(call => call.method === "Input.dispatchKeyEvent" && call.params?.type === "rawKeyDown").map(call => call.params?.key)).toEqual(["Escape"]);
    expect(f.client.close).toHaveBeenCalledOnce();
  });

  it("reads a top-document dropdown's state from the host, and picks it here, never with the host's counted arrows (R20-3)", async () => {
    const f = fixture();
    f.result.text = JSON.stringify(state);
    expect(await executeBrowserSelectAction(f.options, f.connect)).toBe(f.result);
    expect(f.connect).not.toHaveBeenCalled();
    f.options.input = { type: "select_choose", sessionId: "browser_session:owned", index: 1 };
    expect(await executeBrowserSelectAction(f.options, f.connect)).toMatchObject({ text: 'Chose "Greece".' });
    expect(f.action).toHaveBeenLastCalledWith(f.options.pane, { type: "select_state", sessionId: "browser_session:owned" }, f.options.traceId, f.options.context);
    expect(f.connect).toHaveBeenCalledOnce();
  });

  it("fails closed for a tab absent from the authorized session", async () => {
    const f = fixture();
    f.result.session.activePageId = "page:foreign";
    await expect(executeBrowserSelectAction(f.options, f.connect)).rejects.toThrow("active tab is unavailable");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("closes the API connection when a dropdown closed before the pick", async () => {
    const f = fixture(null);
    f.options.input = { type: "select_choose", index: 1 };
    await expect(executeBrowserSelectAction(f.options, f.connect)).rejects.toThrow("no longer open");
    expect(f.client.close).toHaveBeenCalledOnce();
    expect(f.calls.some(call => call.method === "Input.dispatchKeyEvent")).toBe(false);
    expect(f.calls.at(-1)?.method).toBe("Target.detachFromTarget");
  });

  it("does not connect when Chrome's endpoint is unavailable", async () => {
    const f = fixture();
    vi.mocked(readChromeAutomationEndpoint).mockResolvedValueOnce(null);
    await expect(executeBrowserSelectAction(f.options, f.connect)).rejects.toThrow("live connection is unavailable");
    expect(f.connect).not.toHaveBeenCalled();
  });
});
