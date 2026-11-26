import { describe, expect, it } from "vitest";
import { safeBrowserActionRequestForResponse, safeBrowserObservationUrl, safeBrowserPagesForResponse } from "../src/browser-observation.js";

describe("browser URLs echoed to agents", () => {
  it("a navigate result drops the fragment and token-like query values (15/11 transcript leak)", () => {
    const request = { targetPaneId: "pane:browser", action: { type: "navigate", url: "https://x/cb?code=one&page=2#access_token=abc" } } as never;
    const echoed = JSON.stringify([safeBrowserActionRequestForResponse(request), safeBrowserObservationUrl("https://x/cb#access_token=abc"),
      safeBrowserPagesForResponse({ pages: [{ pageId: "p1", url: "https://x/cb#access_token=abc" }] })]);
    expect(echoed).not.toMatch(/abc|one|#/);
    expect(echoed).toContain("https://x/cb?code=%5BREDACTED%5D&page=2");
  });
});
