import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdateNotice, loadedEntry, servedEntry } from "../src/features/instance-badge/AppUpdateNotice.js";

const page = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body></body></html>`;
const served = (entry: string) => vi.fn(async () => new Response(page(entry))) as unknown as typeof fetch;

describe("AppUpdateNotice", () => {
  afterEach(() => { cleanup(); document.head.querySelectorAll("script[data-test-entry]").forEach((node) => node.remove()); vi.useRealTimers(); });
  const loadEntry = (src: string) => { const script = document.createElement("script"); script.type = "module"; script.src = src; script.dataset.testEntry = "1"; document.head.append(script); };

  it("reads the loaded and the served entry script, and nothing under the dev server", async () => {
    expect(loadedEntry()).toBeNull();
    loadEntry("/assets/index-OLD111.js");
    expect(loadedEntry()).toBe("/assets/index-OLD111.js");
    await expect(servedEntry(served("/assets/index-NEW222.js"))).resolves.toBe("/assets/index-NEW222.js");
    await expect(servedEntry((async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toBeNull();
  });

  it("offers a reload once the server serves another build (29/10: a tab kept the old Nous Settings after the promote)", async () => {
    vi.useFakeTimers();
    loadEntry("/assets/index-OLD111.js");
    const same = served("/assets/index-OLD111.js");
    const { rerender } = render(<AppUpdateNotice fetcher={same} />);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(same).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
    expect(screen.queryByRole("status")).toBeNull();
    const fresh = served("/assets/index-NEW222.js");
    rerender(<AppUpdateNotice fetcher={fresh} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(screen.getByRole("status").textContent).toContain("SpaceApp was updated. Reload to use the new version.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
