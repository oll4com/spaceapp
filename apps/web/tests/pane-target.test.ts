import { describe, expect, it, vi } from "vitest";
import { BROWSER_PANE_ACTION_EVENT, registerBrowserPaneEventTarget } from "../src/features/browser-pane/events.js";
import { NOTIFICATION_OPEN_EVENT, onPaneTarget } from "../src/features/notifications/pane-target.js";

// Go to pane opens the item itself (operator 1/11 11:58 BKK: the Mercor mail's card opened the Mail Copilot's default view).
const open = (paneId: string, target: string) => window.dispatchEvent(new CustomEvent(NOTIFICATION_OPEN_EVENT, { detail: { paneId, target } }));

describe("Go to pane targets", () => {
  it("hands a target to a pane that mounts after the click, once, and live to a mounted one", () => {
    open("pane:mail0001", "thread:ntheogr@gmail.com:1a1925b124bb7cb8");
    const late = vi.fn();
    const stop = onPaneTarget("pane:mail0001", late);
    expect(late).toHaveBeenCalledWith("thread:ntheogr@gmail.com:1a1925b124bb7cb8");
    open("pane:mail0001", "campaign:mcamp:abc123");
    expect(late).toHaveBeenLastCalledWith("campaign:mcamp:abc123");
    stop();
    // Remounting replays nothing it already took; another pane's target is not this pane's.
    open("pane:other001", "thread:a@b.c:1");
    const again = vi.fn();
    onPaneTarget("pane:mail0001", again)();
    expect(again).not.toHaveBeenCalled();
  });

  it("drops a target the pane did not take within 15 s", () => {
    vi.useFakeTimers();
    try {
      open("pane:mail0002", "thread:a@b.c:2");
      vi.advanceTimersByTime(16_000);
      const late = vi.fn();
      onPaneTarget("pane:mail0002", late)();
      expect(late).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("shows a page target in the pane's browser once, also when its browser mounts later", () => {
    const shown = vi.fn();
    const listen = (event: Event) => shown((event as CustomEvent).detail);
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, listen);
    try {
      open("pane:browser01", "url:https://app.zinc.work/checks");
      open("pane:browser01", "url:https://app.zinc.work/checks");
      expect(shown).not.toHaveBeenCalled();
      const unregister = registerBrowserPaneEventTarget("pane:browser01");
      expect(shown).toHaveBeenCalledTimes(1);
      expect(shown).toHaveBeenCalledWith({ paneId: "pane:browser01", action: "show_page", url: "https://app.zinc.work/checks" });
      open("pane:browser01", "tab:page-7");
      expect(shown).toHaveBeenLastCalledWith({ paneId: "pane:browser01", action: "show_page", pageId: "page-7" });
      unregister();
    } finally { window.removeEventListener(BROWSER_PANE_ACTION_EVENT, listen); }
  });
});
