import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { CommandBar } from "../src/features/job-apply-pane/CommandBar.js";
import { CopilotRail, RAIL_TAB_ICONS, type CopilotRailTabDefinition } from "../src/features/job-apply-pane/CopilotRail.js";
import { browserVisible, layoutForWidth, resolveActiveTab, STACKED_LAYOUT_MAX_WIDTH, tabsForLayout } from "../src/features/job-apply-pane/layout.js";

afterEach(() => cleanup());

const pane = { id: "pane:jobcopilot01", roomId: "room:jobs0001", title: "Iris", mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" } as unknown as Pane;
const counts = { applied: 0, verified: 0, failed: 0, needsUser: 0, queued: 2, deferred: 0, nextFreeAt: null };
const noop = () => undefined;

function bar(layout: "split" | "stacked", onToggleRail = vi.fn()) {
  return render(
    <CommandBar pane={pane} runtimeOptions={[]} counts={counts} runState="IDLE" progress={null} paused={false} railOpen layout={layout}
      switching={false} needsYou={0} runBusy={false} onRun={noop} onSwitchRuntime={noop} onSetDefault={noop} onTogglePaused={noop} onToggleRail={onToggleRail} />
  );
}

describe("job copilot layout", () => {
  it("shows postings deferred by an employer limit and keeps Start on to find new postings when nothing else is queued", () => {
    render(
      <CommandBar pane={pane} runtimeOptions={[]} counts={{ ...counts, queued: 0, deferred: 2, nextFreeAt: "2026-11-28T00:00:00.000Z" }} runState="IDLE" progress={null} paused={false} railOpen
        switching={false} needsYou={0} runBusy={false} onRun={noop} onSwitchRuntime={noop} onSetDefault={noop} onTogglePaused={noop} onToggleRail={noop} />
    );
    expect(screen.getByText("2 deferred")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect(start.title).toBe("Find new postings, queue them and apply (every queued posting waits for an employer limit; the next one is free on 2026-11-28)");
  });

  it("stacks phones and narrow panes, splits wider ones", () => {
    expect(layoutForWidth(390)).toBe("stacked");
    expect(layoutForWidth(STACKED_LAYOUT_MAX_WIDTH)).toBe("stacked");
    expect(layoutForWidth(STACKED_LAYOUT_MAX_WIDTH + 1)).toBe("split");
    expect(layoutForWidth(1440)).toBe("split");
    // No measurement yet (0) keeps the split layout rather than flashing a phone layout on desktop.
    expect(layoutForWidth(0)).toBe("split");
    // Under 900px the split puts the rail under the browser: a short pane stacks instead of showing two slivers.
    expect(layoutForWidth(700, 384)).toBe("stacked");
    expect(layoutForWidth(700, 900)).toBe("split");
    expect(layoutForWidth(1000, 384)).toBe("split");
  });

  it("offers the browser as the first tab only when stacked, and falls back to Activity for a tab the layout lacks", () => {
    expect(tabsForLayout("stacked")).toEqual(["browser", "activity", "queue", "fields", "memory", "bookmarks", "setup", "terminal"]);
    expect(tabsForLayout("split")).toEqual(["activity", "queue", "fields", "memory", "bookmarks", "setup", "terminal"]);
    expect(resolveActiveTab("browser", "split")).toBe("activity");
    expect(resolveActiveTab("browser", "stacked")).toBe("browser");
    expect(resolveActiveTab("terminal", "stacked")).toBe("terminal");
    expect(resolveActiveTab("bogus", "split")).toBe("activity");
    expect(resolveActiveTab(null, "stacked")).toBe("activity");
  });

  it("shows the live browser in split always, and in stacked only on its tab", () => {
    expect(browserVisible("split", "setup", false)).toBe(true);
    expect(browserVisible("split", "setup", true)).toBe(true);
    expect(browserVisible("stacked", "browser", false)).toBe(true);
    expect(browserVisible("stacked", "queue", false)).toBe(false);
  });
});

describe("job copilot command bar", () => {
  it("keeps the rail toggle in the split layout and drops it when stacked; both layouts keep the compact Paused toggle", () => {
    const onToggleRail = vi.fn();
    const split = bar("split", onToggleRail);
    expect(split.container.querySelector(".jc-bar")?.getAttribute("data-layout")).toBe("split");
    fireEvent.click(screen.getByRole("button", { name: /Collapse the copilot rail/ }));
    expect(onToggleRail).toHaveBeenCalledTimes(1);
    expect(split.container.querySelectorAll(".jc-bar-row")).toHaveLength(2);
    cleanup();
    const stacked = bar("stacked");
    expect(stacked.container.querySelector(".jc-bar")?.getAttribute("data-layout")).toBe("stacked");
    expect(screen.queryByRole("button", { name: /copilot rail/ })).toBeNull();
    expect(stacked.container.querySelectorAll('input[role="switch"]')).toHaveLength(1);
    // Stacked toggles are icon-only switches that keep their accessible names.
    expect(screen.getByRole("switch", { name: "Paused" })).toBeTruthy();
    expect(stacked.container.querySelector(".jc-bar-toggles")?.textContent?.trim()).toBe("");
    expect((screen.getByRole("button", { name: /Start/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(stacked.container.querySelector(".jc-bar")?.textContent).not.toMatch(/Enabled|Disabled/);
  });
});

describe("job copilot rail", () => {
  const tabs: CopilotRailTabDefinition[] = (["browser", "activity", "queue", "terminal"] as const).map((id) => ({ id, label: id, icon: RAIL_TAB_ICONS[id], available: true }));

  it("ignores the collapsed preference when stacked so the bottom strip is always the navigation", () => {
    const onSelect = vi.fn();
    const stacked = render(<CopilotRail tabs={tabs} active="activity" collapsed layout="stacked" onSelect={onSelect}><div>body</div></CopilotRail>);
    const aside = stacked.container.querySelector(".jc-rail");
    expect(aside?.getAttribute("data-layout")).toBe("stacked");
    expect(aside?.getAttribute("data-collapsed")).toBeNull();
    expect(stacked.container.querySelector(".jc-rail-tabs")?.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.click(screen.getByRole("tab", { name: /browser/ }));
    expect(onSelect).toHaveBeenCalledWith("browser");
    cleanup();
    const split = render(<CopilotRail tabs={tabs} active="activity" collapsed layout="split" onSelect={onSelect}><div>body</div></CopilotRail>);
    expect(split.container.querySelector(".jc-rail")?.getAttribute("data-collapsed")).toBe("true");
    expect(split.container.querySelector(".jc-rail-tabs")?.getAttribute("aria-orientation")).toBe("vertical");
  });
});
