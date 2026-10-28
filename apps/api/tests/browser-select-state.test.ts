import { describe, expect, it } from "vitest";
import { chooseOpenBrowserSelectOption, readOpenBrowserSelect } from "../src/browser-sessions.js";

// Option D (plan clipboard:gHaiX_8yanVA): Chrome draws an open native dropdown in a popup no live-view frame shows, so the
// Browser Host reads it in an isolated world and picks an option with real keys.
function fakePage(value: unknown) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const send = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } } as T;
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 } as T;
    if (method === "Runtime.evaluate") return { result: { value } } as T;
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

  it("picks an option with arrows over the enabled options only, then one Enter", async () => {
    const down = fakePage(countries);
    expect(await chooseOpenBrowserSelectOption(down.client, "session-1", 3)).toBe('Chose "Thailand".');
    expect(down.keys()).toEqual(["ArrowDown", "ArrowDown", "Enter"]);
    const up = fakePage({ ...countries, selectedIndex: 3 });
    await chooseOpenBrowserSelectOption(up.client, "session-1", 1);
    expect(up.keys()).toEqual(["ArrowUp", "Enter"]);
  });

  it("refuses a disabled option, an option past the list and a dropdown that closed", async () => {
    await expect(chooseOpenBrowserSelectOption(fakePage(countries).client, "session-1", 2)).rejects.toThrow("That option cannot be chosen.");
    await expect(chooseOpenBrowserSelectOption(fakePage(countries).client, "session-1", 9)).rejects.toThrow("That option cannot be chosen.");
    const closed = fakePage(null);
    await expect(chooseOpenBrowserSelectOption(closed.client, "session-1", 1)).rejects.toThrow("The dropdown is no longer open.");
    expect(closed.keys()).toEqual([]);
  });
});
