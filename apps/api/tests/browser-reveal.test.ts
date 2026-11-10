import { describe, expect, it, vi } from "vitest";
import { BROWSER_REVEAL_TARGETS, revealBrowserNeed } from "../src/browser-reveal.js";

vi.mock("../src/cli-browser-cdp.js", () => ({
  activeTabProfilePath: vi.fn(async (_root: string, _pane: unknown, session: { activePageId: string }) => `/profiles/${session.activePageId}`),
  readChromeAutomationEndpoint: vi.fn(async () => "ws://127.0.0.1:9876/devtools/browser/proof")
}));

// Operator 3/11 12:40 BKK: Go now opened the Emergent Ventures form at its top; the reCAPTCHA and Submit waited at its bottom.
describe("browser reveal", () => {
  const run = async (matches: Record<string, number[]>, noBox: number[] = [], pageId = "page:form") => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const client = {
      send: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push({ method, params });
        if (method === "Target.attachToTarget") return { sessionId: "page-session" } as T;
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } } as T;
        if (method === "DOM.querySelectorAll") return { nodeIds: matches[BROWSER_REVEAL_TARGETS.find(([, selector]) => selector === params?.selector)![0]] ?? [] } as T;
        if (method === "DOM.scrollIntoViewIfNeeded" && noBox.includes(params?.nodeId as number)) throw new Error("Node does not have a layout object");
        return {} as T;
      },
      close: vi.fn()
    };
    const options = { config: { browserSessionsProfileRoot: "/profiles" }, pane: { id: "pane:leo", roomId: "room:cleo" },
      session: { activePageId: "page:other", pages: [{ pageId: "page:other" }, { pageId: "page:form" }] }, pageId } as unknown as Parameters<typeof revealBrowserNeed>[0];
    const result = await revealBrowserNeed(options, async () => client).catch((error: Error) => error);
    return { result, client, calls, scrolled: calls.filter((call) => call.method === "DOM.scrollIntoViewIfNeeded").map((call) => call.params?.nodeId) };
  };

  it("scrolls the reCAPTCHA of the named tab into view before any field or button, and lets the tab go", async () => {
    const { result, calls, client, scrolled } = await run({ recaptcha: [21], required: [30], submit: [40] });
    expect(result).toEqual({ revealed: "recaptcha" });
    expect(scrolled).toEqual([21]);
    expect(calls[0]).toMatchObject({ method: "Target.attachToTarget", params: { targetId: "page:form" } });
    expect(calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "page-session" } });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("skips a node with no box, takes the last submit, answers null with nothing waiting, and refuses a tab this browser does not hold", async () => {
    expect(await run({ hcaptcha: [5], turnstile: [6] }, [5])).toMatchObject({ result: { revealed: "turnstile" }, scrolled: [5, 6] });
    expect(await run({ submit: [7, 8, 9] })).toMatchObject({ result: { revealed: "submit" }, scrolled: [9] });
    expect((await run({})).result).toEqual({ revealed: null });
    const foreign = await run({ recaptcha: [21] }, [], "page:elsewhere");
    expect(String(foreign.result)).toMatch(/not open in this browser/);
    expect(foreign.calls).toEqual([]);
  });
});
