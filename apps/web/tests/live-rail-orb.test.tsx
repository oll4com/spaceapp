// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { LiveOrb, LiveRailButton, type LiveRail } from "../src/features/live-pane/useLiveRail.js";

afterEach(cleanup);

describe("Live rail orb", () => {
  it("stays round under the Liquid Glass theme and draws no frame on hover", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    expect(css).toMatch(/\.room-toolbar-collapsed \.room-live-rail-button \{[^}]*border-radius: 50% !important;/);
    expect(css).toMatch(/\.room-toolbar-collapsed \.room-live-rail-button:hover \{\s*filter: brightness\(1\.12\);\s*\}/);
    // The room theme paints hovered buttons' borders with its accent; the orb is excluded.
    const styles = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(styles).toContain(".space-shell[data-room-theme] button:hover:not(:disabled):where(:not(.side-surface-room-panel *, .jc-pane :not(.jc-panel-terminal *), .jc-launch *, .room-live-rail-button))");
  });

  it("runs no animation while Live is idle (renderer profile 10/11)", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    expect(css).toContain(`.live-orb[data-live-status="idle"] :is(.live-orb-wave, .live-orb-iris),
.live-orb[data-live-status="error"] .live-orb-iris,
.space-shell .room-toolbar-collapsed .room-live-rail-button[data-live-status="idle"]::before { animation: none; }`);
    const { container } = render(<LiveOrb status="idle" />);
    expect(container.querySelector(".live-orb")?.getAttribute("data-live-status")).toBe("idle");
  });

  it("animates only transforms, and nothing while the window is hidden or unfocused (desktop lag brief 11/11)", () => {
    const css = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
    expect(css).toMatch(/@keyframes live-orb-iris \{\s*to \{ transform: translateX\(-50%\); \}\s*\}/);
    const styles = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(styles).toContain(":root[data-window-idle] *::after { animation-play-state: paused !important; }");
    const main = readFileSync(resolve(__dirname, "../src/main.tsx"), "utf8");
    expect(main).toContain('toggleAttribute("data-window-idle", document.hidden || !document.hasFocus())');
  });

  it("shows only the sphere, without an icon", () => {
    const { container } = render(<LiveOrb status="idle" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("does not take focus on a mouse click, so no focus ring appears around it", () => {
    const liveRail = { liveRailStatus: "idle", setLiveRailContextMenu: () => undefined, isLiveRailGraphicDisabled: false } as unknown as LiveRail;
    const { container } = render(<LiveRailButton liveRail={liveRail} onActivate={() => undefined} disabled={false} />);
    const button = container.querySelector("button")!;
    expect(fireEvent.mouseDown(button)).toBe(false);
  });
});
