import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const source = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/features/nous", name), "utf8");

// Operator 16/11 (nous_msg:ee2ff4ce): the Inbox was a fixed page, its root had left the shared scrolling column every Nous view uses.
describe("Nous Inbox scrolls in every layout", () => {
  it("renders the Inbox root in the shared .nous-decisions column", () => {
    expect(source("NousInbox.tsx")).toMatch(/<div className="nous-decisions nous-inbox" ref=\{rootRef\}[ >]/);
  });

  it("keeps the shared column a shrinking scroller and never a grid", () => {
    const css = source("nous.css");
    const shared = css.match(/\.nous-messages,\s*\.nous-decisions,\s*\.nous-overview,\s*\.nous-plan-view \{([^}]*)\}/)?.[1] ?? "";
    expect(shared).toMatch(/flex: 1 1 auto;/);
    expect(shared).toMatch(/min-height: 0;/);
    expect(shared).toMatch(/overflow-y: auto;/);
    // A view nested in another (the Inbox queue) must not become a second scroller squeezed to nothing.
    expect(css).toMatch(/\.nous-plan-view\) \.nous-decisions \{ flex: none; min-height: auto; overflow: visible;/);
    expect(source("nous-done.css")).not.toMatch(/\.nous-inbox \{[^}]*display: grid/);
  });
});

// nous_msg:556e6cfd: scrollIntoView scrolled the shell around the Nous lists; scrollWithin moves only the list.
describe("scrollWithin", () => {
  const box = (top: number, height: number) => ({ getBoundingClientRect: () => ({ top, bottom: top + height }) });
  const list = (scrollTop: number) => ({ ...box(100, 200), clientTop: 0, clientHeight: 200, scrollTop, scrollTo: vi.fn() });
  it("aligns start and center and moves nearest only as far as needed", async () => {
    const { scrollWithin } = await import("../src/features/nous/nous-scroll.js");
    const cases: [number, number, "start" | "center" | "nearest", number | null][] = [
      [250, 20, "start", 160], [250, 20, "center", 70], [150, 20, "nearest", null], [50, 20, "nearest", -40], [320, 20, "nearest", 50], [320, 300, "nearest", 230]];
    for (const [top, height, block, expected] of cases) {
      const scroller = list(10);
      scrollWithin(box(top, height) as unknown as Element, block, "auto", scroller as unknown as HTMLElement);
      if (expected === null) expect(scroller.scrollTo).not.toHaveBeenCalled();
      else expect(scroller.scrollTo).toHaveBeenCalledWith({ top: expected, behavior: "auto" });
    }
  });
});
