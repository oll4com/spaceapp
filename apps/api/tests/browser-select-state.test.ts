import { describe, expect, it } from "vitest";
import { chooseOpenBrowserSelectOption, readOpenBrowserSelect, typeIntoBrowserPage } from "../src/browser-sessions.js";

// Option D (plan clipboard:gHaiX_8yanVA): Chrome draws an open native dropdown in a popup no live-view frame shows, so the
// Browser Host reads it in an isolated world and picks an option with real keys.
function fakePage(value: unknown, ignoresSet = false) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } } as T;
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 } as T;
    if (method === "Runtime.evaluate") {
      // The set expression (R20-3) answers the dropdown with the option it took, unless this page ignores it.
      const chosen = /selectedIndex = (\d+)/.exec(String(params?.expression))?.[1];
      return { result: { value: chosen && value && !ignoresSet ? { ...(value as object), selectedIndex: Number(chosen) } : value } } as T;
    }
    return {} as T;
  };
  const keys = () => calls.filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.type === "rawKeyDown").map((call) => call.params?.key);
  return { calls, send, keys, client: { send: <T,>(method: string, params?: Record<string, unknown>) => send<T>(method, params) } };
}

const countries = { selectedIndex: 0, box: { x: 512, y: 88, width: 416, height: 38 }, labels: ["Choose a country", "Greece", "Oman", "Thailand"], disabled: [0, 2], truncated: false };

describe("the live view's own dropdown list", () => {
  it("reads the focused open dropdown in an isolated world, and nothing when none is open", async () => {
    const page = fakePage(countries);
    expect(await readOpenBrowserSelect(page.send)).toEqual(countries);
    const evaluate = page.calls.find((call) => call.method === "Runtime.evaluate");
    expect(evaluate?.params).toMatchObject({ contextId: 7, returnByValue: true });
    expect(String(evaluate?.params?.expression)).toContain(':open');
    expect(await readOpenBrowserSelect(fakePage(null).send)).toBeNull();
    expect(await readOpenBrowserSelect(fakePage({ selectedIndex: "x" }).send)).toBeNull();
  });

  it("leaves labels out to fit the action's text and says so", async () => {
    const labels = Array.from({ length: 400 }, (_, index) => `${"Country".padEnd(70, "x")} ${index}`);
    const state = await readOpenBrowserSelect(fakePage({ ...countries, labels, disabled: [399] }).send);
    expect(JSON.stringify(state).length).toBeLessThanOrEqual(19_000);
    expect(state).toMatchObject({ truncated: true, disabled: [] });
    expect(state!.labels.length).toBeLessThan(400);
  });

  it("closes the popup and sets the option by its index with the page's events, never arrows counted from the selected one (R20-3)", async () => {
    // 30/10 09:37 BKK, Braintrust: arrows from the selected option moved from where Chrome's popup was scrolled and chose
    // "French Southern Territories" for Greece.
    const page = fakePage(countries);
    expect(await chooseOpenBrowserSelectOption(page.client, "session-1", 3)).toBe('Chose "Thailand".');
    expect(page.keys()).toEqual(["Escape"]);
    const set = page.calls.filter((call) => call.method === "Runtime.evaluate").at(-1);
    expect(String(set?.params?.expression)).toContain("select.selectedIndex = 3;");
    expect(String(set?.params?.expression)).toContain('new Event("change", { bubbles: true })');
    expect(String(set?.params?.expression)).not.toContain(":open");
    await expect(chooseOpenBrowserSelectOption(fakePage(countries, true).client, "session-1", 1)).rejects.toThrow("The dropdown did not take that option");
  });

  it("refuses a disabled option, an option past the list and a dropdown that closed", async () => {
    await expect(chooseOpenBrowserSelectOption(fakePage(countries).client, "session-1", 2)).rejects.toThrow("That option cannot be chosen.");
    await expect(chooseOpenBrowserSelectOption(fakePage(countries).client, "session-1", 9)).rejects.toThrow("That option cannot be chosen.");
    const closed = fakePage(null);
    await expect(chooseOpenBrowserSelectOption(closed.client, "session-1", 1)).rejects.toThrow("The dropdown is no longer open.");
    expect(closed.keys()).toEqual([]);
  });

  it("types into an open dropdown by picking the option the text names, never into the field focused before it (AvantLink, 13/11)", async () => {
    const page = fakePage(countries);
    expect(await typeIntoBrowserPage(page.client, "session-1", "thai")).toBe('Chose "Thailand".');
    expect(page.calls.some((call) => call.method === "Input.insertText")).toBe(false);
    expect(await typeIntoBrowserPage(fakePage(countries).client, "session-1", " Greece ")).toBe('Chose "Greece".');
    // Oman is disabled and nothing starts with "Fr": refused, nothing typed.
    for (const text of ["Oman", "Fr"]) {
      const refused = fakePage(countries);
      await expect(typeIntoBrowserPage(refused.client, "session-1", text)).rejects.toThrow("nothing was typed");
      expect(refused.calls.some((call) => call.method === "Input.insertText")).toBe(false);
    }
    const field = fakePage(null);
    expect(await typeIntoBrowserPage(field.client, "session-1", "+30 210")).toBeNull();
    expect(field.calls.filter((call) => call.method === "Input.insertText").map((call) => call.params?.text)).toEqual(["+30 210"]);
  });
});


// The frame id comes from Chrome's DOM node, never a URL supplied by page script.
function framedPage(oopif = false, nested = false) {
  const calls: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  const send = async <T,>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
    calls.push({ method, params, sessionId });
    if (method === "Page.getFrameTree") return { frameTree: sessionId === "child-session"
      ? { frame: { id: "child" }, ...(nested ? { childFrames: [{ frame: { id: "nested" } }] } : {}) }
      : { frame: { id: "top" }, ...(!oopif ? { childFrames: [{ frame: { id: "child" } }] } : {}) } } as T;
    if (method === "Page.createIsolatedWorld") {
      if (oopif && params?.frameId === "child" && sessionId !== "child-session") throw new Error("different process");
      return { executionContextId: params?.frameId === "top" ? 1 : params?.frameId === "child" ? 2 : 3 } as T;
    }
    if (method === "Runtime.evaluate") {
      const frame = params?.contextId === 1 || (nested && params?.contextId === 2);
      if (params?.returnByValue === false) return { result: { objectId: params?.contextId === 1 ? "frame-node" : "nested-node" } } as T;
      const chosen = /selectedIndex = (\d+)/.exec(String(params?.expression))?.[1];
      return { result: { value: frame ? { focusFrame: true, x: params?.contextId === 1 ? 112 : 15, y: params?.contextId === 1 ? 124 : 20 }
        : chosen ? { ...countries, selectedIndex: Number(chosen) } : countries } } as T;
    }
    if (method === "DOM.describeNode") return { node: { nodeName: "IFRAME", frameId: params?.objectId === "frame-node" ? "child" : "nested" } } as T;
    if (method === "Target.getTargets") return { targetInfos: [{ type: "iframe", targetId: "unrelated" }, { type: "iframe", targetId: "child" }] } as T;
    if (method === "Target.attachToTarget") return { sessionId: "child-session" } as T;
    return {} as T;
  };
  return { send, calls };
}

describe("native dropdowns inside focused frames", () => {
  it("follows the same-process focused child and translates its box to the page", async () => {
    const page = framedPage();
    expect(await readOpenBrowserSelect(page.send, "page-session")).toEqual({ ...countries, box: { ...countries.box, x: 624, y: 212 } });
    expect(page.calls.filter(call => call.method === "Page.createIsolatedWorld").map(call => call.params?.frameId)).toEqual(["top", "child"]);
    expect(page.calls.some(call => call.method === "Target.attachToTarget")).toBe(false);
  });

  it("attaches only the focused OOPIF target, reads in its isolated world and detaches", async () => {
    const page = framedPage(true);
    expect(await readOpenBrowserSelect(page.send, "page-session")).toEqual({ ...countries, box: { ...countries.box, x: 624, y: 212 } });
    expect(page.calls.find(call => call.method === "Target.attachToTarget")?.params).toEqual({ targetId: "child", flatten: true });
    expect(page.calls.find(call => call.method === "Runtime.evaluate" && call.params?.contextId === 2)?.sessionId).toBe("child-session");
    expect(page.calls.find(call => call.method === "Target.detachFromTarget")?.params).toEqual({ sessionId: "child-session" });
  });

  it("adds offsets through nested same-process frames within an OOPIF", async () => {
    const page = framedPage(true, true);
    expect((await readOpenBrowserSelect(page.send, "page-session"))?.box).toEqual({ ...countries.box, x: 639, y: 232 });
  });

  it.each([false, true])("sends a pick through the focused page for an iframe (OOPIF %s)", async oopif => {
    const page = framedPage(oopif);
    expect(await chooseOpenBrowserSelectOption(page, "page-session", 3)).toBe('Chose "Thailand".');
    const keys = page.calls.filter(call => call.method === "Input.dispatchKeyEvent" && call.params?.type === "rawKeyDown");
    expect(keys.map(call => call.params?.key)).toEqual(["Escape"]);
    expect(keys.every(call => call.sessionId === "page-session")).toBe(true);
    // R20-3: the option is set in the dropdown's own frame.
    const set = page.calls.filter(call => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("selectedIndex = 3"));
    expect(set.at(-1)?.params?.contextId).toBe(2);
  });

  it("fails closed and detaches the OOPIF when its document disappears", async () => {
    const page = framedPage(true);
    const send: typeof page.send = (method, params, sessionId) => {
      if (method === "Runtime.evaluate" && sessionId === "child-session") throw new Error("navigated");
      return page.send(method, params, sessionId);
    };
    expect(await readOpenBrowserSelect(send, "page-session")).toBeNull();
    expect(page.calls.some(call => call.method === "Target.detachFromTarget")).toBe(true);
  });
});

describe("focused-frame safety bounds", () => {
  it("does not inspect an unrelated iframe target", async () => {
    const page = framedPage(true);
    const send: typeof page.send = async <T,>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> => {
      if (method === "Target.getTargets") return { targetInfos: [{ type: "iframe", targetId: "unrelated" }] } as T;
      return page.send<T>(method, params, sessionId);
    };
    expect(await readOpenBrowserSelect(send, "page-session")).toBeNull();
    expect(page.calls.some(call => call.method === "Target.attachToTarget")).toBe(false);
  });

  it("stops after four focused frame edges", async () => {
    const worlds: string[] = [];
    const tree = (index: number): object => ({ frame: { id: `frame-${index}` }, ...(index < 6 ? { childFrames: [tree(index + 1)] } : {}) });
    const send = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === "Page.getFrameTree") return { frameTree: tree(0) } as T;
      if (method === "Page.createIsolatedWorld") {
        worlds.push(String(params?.frameId));
        return { executionContextId: Number(String(params?.frameId).split("-")[1]) } as T;
      }
      if (method === "Runtime.evaluate") return { result: params?.returnByValue === false
        ? { objectId: `element-${Number(params?.contextId) + 1}` }
        : { value: { focusFrame: true, x: 1, y: 2 } } } as T;
      if (method === "DOM.describeNode") return { node: { nodeName: "IFRAME", frameId: String(params?.objectId).replace("element", "frame") } } as T;
      return {} as T;
    };
    expect(await readOpenBrowserSelect(send)).toBeNull();
    expect(worlds).toEqual(["frame-0", "frame-1", "frame-2", "frame-3", "frame-4"]);
  });

  it("rejects unexpected frame geometry without following it", async () => {
    const page = fakePage({ focusFrame: true, x: Infinity, y: 3 });
    expect(await readOpenBrowserSelect(page.send)).toBeNull();
    expect(page.calls.some(call => call.method === "DOM.describeNode")).toBe(false);
  });
});
