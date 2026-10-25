import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loader = readFileSync(resolve(process.cwd(), "public/mock-loader.js"), "utf8");

describe("public mock boot recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><div id="space-mock-loading"><p id="space-mock-loading-message">Loading Space demo…</p><button id="space-mock-retry" hidden>Reload demo</button></div></div>';
    window.eval(loader);
  });
  afterEach(async () => {
    document.getElementById("root")!.replaceChildren();
    await Promise.resolve();
    vi.useRealTimers();
  });
  it("reveals recovery when the initial module never finishes loading", () => {
    vi.advanceTimersByTime(15000);
    expect(document.getElementById("space-mock-loading-message")!.textContent).toContain("longer than expected");
    expect((document.getElementById("space-mock-retry") as HTMLButtonElement).hidden).toBe(false);
  });
  it("offers immediate recovery for a failed initial script", () => {
    const script = document.createElement("script");
    document.head.append(script);
    script.dispatchEvent(new Event("error"));
    expect(document.getElementById("space-mock-loading-message")!.textContent).toContain("could not load");
    expect((document.getElementById("space-mock-retry") as HTMLButtonElement).hidden).toBe(false);
    script.remove();
  });
  it("stops its timeout when the application replaces the loading screen", async () => {
    document.getElementById("root")!.textContent = "Workspace ready";
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(15000);
    expect(document.body.textContent).toBe("Workspace ready");
  });
});
