import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAIRING_MASK_APPLY, VAULT_MASK_APPLY, VAULT_MASK_REMOVE, assertBrowserHostPressKey, captureMaskedScreenshot, capturePairingMasked, pressBrowserKey, scrollBrowserPage } from "../src/browser-sessions.js";

// Vault fence 2026-10-19 (Nous decision on the Alstom report): the pane that filled a Vault page may press keys and take
// masked screenshots of it; every field is drawn as dots for the shot, also a password a "show password" toggle revealed.
// A minimal document for the mask's own expressions (the API tests run in node).
type FakeElement = { id: string; textContent: string; remove(): void };
let elements = new Map<string, FakeElement>();
const fakeDocument = {
  getElementById: (id: string) => elements.get(id) ?? null,
  createElement: () => { const element: FakeElement = { id: "", textContent: "", remove: () => { elements.delete(element.id); } }; return element; },
  head: { appendChild: (element: FakeElement) => { elements.set(element.id, element); } },
  documentElement: {}
};
const globals = globalThis as unknown as { document?: unknown; getComputedStyle?: unknown };
beforeEach(() => { elements = new Map(); globals.document = fakeDocument; globals.getComputedStyle = () => ({}); });
afterEach(() => { delete globals.document; delete globals.getComputedStyle; });
const document = { getElementById: (id: string) => fakeDocument.getElementById(id) };

function fakePage(options: { failFrame?: string; failEvaluate?: boolean } = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let maskedDuringShot: boolean | null = null;
  let pairingBlurredDuringShot: boolean | null = null;
  let next = 1;
  const send = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, ...(params ? { params } : {}) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" }, childFrames: [{ frame: { id: "child" } }, { frame: { id: "oopif" } }] } } as T;
    if (method === "Page.createIsolatedWorld") {
      if (params?.frameId === options.failFrame) throw new Error("No frame for given id found");
      return { executionContextId: next++ } as T;
    }
    if (method === "Runtime.evaluate" && options.failEvaluate) throw new Error("Cannot find default execution context");
    if (method === "Runtime.evaluate") return { result: { value: new Function("document", "getComputedStyle", `return ${String(params?.expression)}`)(fakeDocument, () => ({})) } } as T;
    if (method === "Page.captureScreenshot") {
      maskedDuringShot = Boolean(document.getElementById("__space_vault_mask")?.textContent?.includes("-webkit-text-security:disc"));
      pairingBlurredDuringShot = ["__space_vault_mask", "__space_pairing_mask"]
        .some((id) => document.getElementById(id)?.textContent?.includes("[data-sensitive-masked=pairing]{filter:blur("));
      return { data: "UE5H" } as T;
    }
    return {} as T;
  };
  return { send, calls, maskedDuringShot: () => maskedDuringShot, pairingBlurredDuringShot: () => pairingBlurredDuringShot };
}

describe("Vault masked screenshot and key presses", () => {
  it("masks every field, text area and editable area for the shot and removes the mask after it", async () => {
    const page = fakePage({ failFrame: "oopif" });
    expect(await captureMaskedScreenshot(page.send)).toBe("UE5H");
    expect(page.maskedDuringShot()).toBe(true);
    expect(page.pairingBlurredDuringShot()).toBe(true);
    const style = /input,textarea,select,\[contenteditable\]/;
    expect(VAULT_MASK_APPLY).toMatch(style);
    expect(document.getElementById("__space_vault_mask")).toBeNull();
    const order = page.calls.map((call) => call.method);
    expect(order.indexOf("Page.captureScreenshot")).toBeGreaterThan(order.lastIndexOf("Page.createIsolatedWorld"));
    expect(page.calls.filter((call) => call.method === "Runtime.evaluate" && call.params?.expression === VAULT_MASK_REMOVE)).toHaveLength(2);
  });

  // Card fills (plan clipboard:qf0P640vyLp2): a checkout's card boxes live in a cross-site payment frame, another process.
  function fakeCheckout(options: { failPay?: boolean } = {}) {
    const page = fakePage();
    const calls: Array<{ method: string; sessionId?: string; frameId?: unknown }> = [];
    const cdp = { send: async <T,>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => {
      calls.push({ method, sessionId, frameId: params.frameId });
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "pay", type: "iframe", parentFrameId: "main" }, { targetId: "other-tab", type: "iframe", parentFrameId: "elsewhere" }] } as T;
      if (method === "Target.attachToTarget") return { sessionId: `s-${String(params.targetId)}` } as T;
      if (method === "Page.getFrameTree" && sessionId === "s-pay") return { frameTree: { frame: { id: "pay", url: "https://js.stripe.com/v3/elements" } } } as T;
      if (method === "Page.createIsolatedWorld" && sessionId === "s-pay" && options.failPay) throw new Error("No frame for given id found");
      return page.send<T>(method, params);
    } };
    return { page, calls, cdp };
  }

  it("masks a cross-site payment frame through its own session and detaches it after the shot", async () => {
    const { page, calls, cdp } = fakeCheckout();
    expect(await captureMaskedScreenshot(page.send, { cdp, sessionId: "s-top" })).toBe("UE5H");
    expect(page.maskedDuringShot()).toBe(true);
    expect(calls).toContainEqual({ method: "Page.createIsolatedWorld", sessionId: "s-pay", frameId: "pay" });
    expect(calls.filter((call) => call.method === "Runtime.evaluate" && call.sessionId === "s-pay")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "Target.attachToTarget")).toHaveLength(1);
    expect(calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget" });
  });

  it("captures nothing when a cross-site payment frame cannot be masked", async () => {
    const { page, calls, cdp } = fakeCheckout({ failPay: true });
    await expect(captureMaskedScreenshot(page.send, { cdp, sessionId: "s-top" })).rejects.toThrow(/could not mask the page/);
    expect(page.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget" });
  });

  it("captures nothing when the page's own frame cannot be masked", async () => {
    const page = fakePage({ failFrame: "main" });
    await expect(captureMaskedScreenshot(page.send)).rejects.toThrow(/could not mask the page/);
    expect(page.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
  });

  // 12/11: the operator's Hide sensitive data no longer blurs the phone pairing QR; every picture an agent gets still does.
  it("blurs the phone pairing QR in capture jobs and recordings and removes the blur after the shot", async () => {
    const page = fakePage();
    expect(await capturePairingMasked(page.send, { format: "jpeg", quality: 80 })).toBe("UE5H");
    expect(page.pairingBlurredDuringShot()).toBe(true);
    expect(page.calls.find((call) => call.method === "Runtime.evaluate")?.params?.expression).toBe(PAIRING_MASK_APPLY);
    expect(page.calls.find((call) => call.method === "Page.captureScreenshot")?.params).toEqual({ format: "jpeg", quality: 80 });
    expect(document.getElementById("__space_pairing_mask")).toBeNull();
  });

  it("captures nothing when the pairing blur cannot be applied", async () => {
    const page = fakePage({ failEvaluate: true });
    await expect(capturePairingMasked(page.send, { format: "png" })).rejects.toThrow(/could not blur the phone pairing code/);
    expect(page.calls.filter((call) => call.method === "Runtime.evaluate" && call.params?.expression === PAIRING_MASK_APPLY)).toHaveLength(3);
    expect(page.calls.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
  });

  it("presses Enter with its submit character, and Tab or Shift+Tab, as real key events", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = { send: async <T,>(_method: string, params?: Record<string, unknown>) => { sent.push(params ?? {}); return {} as T; } };
    await pressBrowserKey(client, "session-1", "Enter");
    expect(sent.map((event) => event.type)).toEqual(["rawKeyDown", "char", "keyUp"]);
    expect(sent[1]).toMatchObject({ text: "\r", windowsVirtualKeyCode: 13 });
    sent.length = 0;
    await pressBrowserKey(client, "session-1", "Shift+Tab");
    expect(sent).toEqual([expect.objectContaining({ type: "rawKeyDown", key: "Tab", modifiers: 8, windowsVirtualKeyCode: 9 }), expect.objectContaining({ type: "keyUp", key: "Tab" })]);
  });

  it("clears a field with Control+A and Backspace and picks a dropdown option with the arrows (plan clipboard:gHaiX_8yanVA)", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = { send: async <T,>(_method: string, params?: Record<string, unknown>) => { sent.push(params ?? {}); return {} as T; } };
    await pressBrowserKey(client, "session-1", "Control+A");
    await pressBrowserKey(client, "session-1", "Backspace");
    await pressBrowserKey(client, "session-1", "ArrowDown");
    expect(sent).toEqual([
      { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 }, { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 }, { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 },
      { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 0 }, { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 0 }
    ]);
    sent.length = 0;
    await pressBrowserKey(client, "session-1", "Space");
    expect(sent.map((event) => [event.type, event.text])).toEqual([["rawKeyDown", undefined], ["char", " "], ["keyUp", undefined]]);
  });

  it("sends the new keys only to a Browser Host that says it presses them (an old one presses Tab instead)", async () => {
    const oldHost = { status: () => ({ enabled: true, statusReason: "", defaultUrl: "", checkedAt: "" }), browserHostHealth: async () => ({ status: { enabled: true } }) };
    await expect(assertBrowserHostPressKey(oldHost, { type: "press", key: "Enter" })).resolves.toBeUndefined();
    await expect(assertBrowserHostPressKey(oldHost, { type: "click", x: 1, y: 1 })).resolves.toBeUndefined();
    await expect(assertBrowserHostPressKey(oldHost, { type: "press", key: "Backspace" })).rejects.toMatchObject({ errorCode: "BROWSER_ACTION_UNAVAILABLE" });
    await expect(assertBrowserHostPressKey({ ...oldHost, browserHostHealth: async () => { throw new Error("down"); } }, { type: "press", key: "ArrowDown" }))
      .rejects.toThrow(/Browser Host restart/);
    // The proxy's cached status is stale until a health check: a fresh check of a restarted host lets the key through.
    await expect(assertBrowserHostPressKey({ ...oldHost, browserHostHealth: async () => ({ status: { pressKeys: true } }) }, { type: "press", key: "Control+A" }))
      .resolves.toBeUndefined();
    await expect(assertBrowserHostPressKey({ status: () => ({ ...oldHost.status(), pressKeys: true }) }, { type: "press", key: "Escape" })).resolves.toBeUndefined();
  });

  it("scrolls what is under a point with the wheel, only on a host that says it can (an old one scrolls the page instead)", async () => {
    const sent: Array<[string, Record<string, unknown> | undefined]> = [];
    const client = { send: async <T,>(method: string, params?: Record<string, unknown>) => { sent.push([method, params]); return {} as T; } };
    await scrollBrowserPage(client, "session-1", { deltaX: 0, deltaY: 300, x: 120, y: 480 });
    await scrollBrowserPage(client, "session-1", { deltaX: 0, deltaY: -200 });
    expect(sent).toEqual([["Input.dispatchMouseEvent", { type: "mouseWheel", x: 120, y: 480, deltaX: 0, deltaY: 300 }],
      ["Runtime.evaluate", { expression: "window.scrollBy(0, -200)", returnByValue: true }]]);
    await expect(scrollBrowserPage(client, "session-1", { deltaX: 0, deltaY: 300, x: 120 })).rejects.toThrow("needs both x and y");
    const oldHost = { status: () => ({ enabled: true, statusReason: "", defaultUrl: "", checkedAt: "", pressKeys: true }) };
    await expect(assertBrowserHostPressKey(oldHost, { type: "scroll", deltaX: 0, deltaY: 300 })).resolves.toBeUndefined();
    await expect(assertBrowserHostPressKey(oldHost, { type: "scroll", deltaX: 0, deltaY: 300, x: 120, y: 480 })).rejects.toThrow("scroll at a point needs the Browser Host restart");
    await expect(assertBrowserHostPressKey({ status: () => ({ ...oldHost.status(), scrollAt: true }) }, { type: "scroll", deltaX: 0, deltaY: 300, x: 120, y: 480 })).resolves.toBeUndefined();
  });
});
