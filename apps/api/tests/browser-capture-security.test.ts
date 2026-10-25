import { describe, expect, it, vi } from "vitest";
import { resolveElementScreenshotClip } from "../src/browser-sessions.js";

describe("resolveElementScreenshotClip", () => {
  it("passes selectors as CDP data and never constructs executable JavaScript", async () => {
    const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        expect(params).toEqual({
          nodeId: 1,
          selector: `button[data-label="'); globalThis.compromised = true; //"]`
        });
        return { nodeId: 42 };
      }
      if (method === "DOM.getBoxModel") {
        expect(params).toEqual({ nodeId: 42 });
        return {
          model: {
            border: [10, 20, 110, 20, 110, 70, 10, 70]
          }
        };
      }
      throw new Error(`Unexpected CDP method ${method}`);
    });

    await expect(
      resolveElementScreenshotClip(
        { send },
        "cdp-session",
        `button[data-label="'); globalThis.compromised = true; //"]`
      )
    ).resolves.toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      scale: 1
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "DOM.getDocument",
      "DOM.querySelector",
      "DOM.getBoxModel"
    ]);
    expect(send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
  });

  it("returns null when the selector does not match a node", async () => {
    const send = vi.fn(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 0 };
      throw new Error(`Unexpected CDP method ${method}`);
    });

    await expect(
      resolveElementScreenshotClip({ send }, "cdp-session", "#missing")
    ).resolves.toBeNull();
  });
});
