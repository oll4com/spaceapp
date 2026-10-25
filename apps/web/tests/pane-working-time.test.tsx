// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { formatWorkingTime } from "../src/features/pane-working-time/usePaneWorkingTime.js";
import { extractTerminalScreenWorkingTimeMs } from "../src/features/terminal-pane/TerminalPane.js";
import { PaneWorkingTimeBadge } from "../src/features/pane-working-time/PaneWorkingTimeBadge.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Pane Working Time - formatWorkingTime", () => {
  it("formats 0ms as 0m without seconds", () => {
    expect(formatWorkingTime(0)).toBe("0m");
    expect(formatWorkingTime(-100)).toBe("0m");
  });

  it("omits seconds and rounds under 1 minute to 0m", () => {
    expect(formatWorkingTime(14_000)).toBe("0m");
    expect(formatWorkingTime(59_000)).toBe("0m");
  });

  it("formats minutes in 1-minute intervals without seconds", () => {
    expect(formatWorkingTime(60 * 1000)).toBe("1m");
    expect(formatWorkingTime(10 * 60 * 1000)).toBe("10m");
    expect(formatWorkingTime(14 * 60 * 1000)).toBe("14m");
    expect(formatWorkingTime(20 * 60 * 1000)).toBe("20m");
    expect(formatWorkingTime(35 * 60 * 1000 + 55 * 1000)).toBe("35m");
    expect(formatWorkingTime(59 * 60 * 1000)).toBe("59m");
  });

  it("formats hours and 1-minute intervals without seconds", () => {
    expect(formatWorkingTime(60 * 60 * 1000)).toBe("1h 0m");
    expect(formatWorkingTime(3600 * 1000 + 22 * 60 * 1000 + 10 * 1000)).toBe("1h 22m");
    expect(formatWorkingTime(2 * 3600 * 1000 + 5 * 1000)).toBe("2h 0m");
    expect(formatWorkingTime(18 * 3600 * 1000 + 20 * 60 * 1000 + 19 * 1000)).toBe("18h 20m");
  });
});

describe("Pane Working Time - extractTerminalScreenWorkingTimeMs", () => {
  it("extracts working time from CLI working prompts", () => {
    expect(
      extractTerminalScreenWorkingTimeMs("Working (35m 55s • esc to interrupt)")
    ).toBe((35 * 60 + 55) * 1000);

    expect(
      extractTerminalScreenWorkingTimeMs("Waiting for background terminal (46m 57s • esc to interrupt)")
    ).toBe((46 * 60 + 57) * 1000);

    expect(
      extractTerminalScreenWorkingTimeMs("Working (1m 27s • esc to interrupt)")
    ).toBe(87_000);

    expect(
      extractTerminalScreenWorkingTimeMs("Working (14s)")
    ).toBe(14_000);

    expect(
      extractTerminalScreenWorkingTimeMs("Working (1h 22m 10s • esc to interrupt)")
    ).toBe((3600 + 22 * 60 + 10) * 1000);
  });

  it("extracts working time from Gemini CLI Thought for and Thinking prompts", () => {
    expect(
      extractTerminalScreenWorkingTimeMs("Thought for 17s, 471 tokens")
    ).toBe(17_000);

    expect(
      extractTerminalScreenWorkingTimeMs("o Thought for 10m 16s (Initial investigation reveals...)")
    ).toBe((10 * 60 + 16) * 1000);

    expect(
      extractTerminalScreenWorkingTimeMs("o Thought for 55.2s (Examining the component...)")
    ).toBe(55_200);

    expect(
      extractTerminalScreenWorkingTimeMs("Thinking (30s)")
    ).toBe(30_000);
  });

  it("extracts the Claude Code turn time from its spinner, not the thinking time", () => {
    expect(extractTerminalScreenWorkingTimeMs("✢ Razzmatazzing… (12s · still thinking with xhigh effort)", "cli:claude")).toBe(12_000);
    expect(extractTerminalScreenWorkingTimeMs("✶ Razzmatazzing… (1m 33s · ↓ 8.2k tokens · thought for 32s)", "cli:claude")).toBe(93_000);
    expect(extractTerminalScreenWorkingTimeMs("* Spelunking… (1h 2m 3s · ↓ 1.1k tokens)\n────\n❯ ", "cli:claude")).toBe(3_723_000);
    expect(extractTerminalScreenWorkingTimeMs("✻ Deliberating…", "cli:claude")).toBeNull();
    expect(extractTerminalScreenWorkingTimeMs("✻ Baked for 35s · done 10:01 AM", "cli:claude")).toBeNull();
    expect(extractTerminalScreenWorkingTimeMs("⏺ Thought for 32s about tides", "cli:claude")).toBeNull();
  });

  it("returns null for non-running screen text", () => {
    expect(extractTerminalScreenWorkingTimeMs("")).toBeNull();
    expect(extractTerminalScreenWorkingTimeMs("Ready for input. Type /help for assistance.")).toBeNull();
    expect(extractTerminalScreenWorkingTimeMs("user@space:~$ npm test")).toBeNull();
  });
});

describe("PaneWorkingTimeBadge component", () => {
  it("renders idle state when isWorking is false", () => {
    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-1"
        isWorking={false}
      />
    );

    const badge = screen.getByRole("status");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain("pane-working-time-badge");
    expect(badge.className).toContain("is-idle");
    expect(badge.getAttribute("title")).toContain("Waiting for command");
    expect(badge.getAttribute("title")).toContain("Only counts execution time; idle wait time is excluded.");
    expect(screen.getByText("0m")).toBeTruthy();
    expect(badge.querySelector(".pane-working-time-pulse")).toBeNull();
  });

  it("renders active working state with glowing pulse dot when isWorking is true", () => {
    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-2"
        isWorking={true}
        categoryColor="purple"
      />
    );

    const badge = screen.getByRole("status");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain("is-active");
    expect(badge.getAttribute("data-category-color")).toBe("purple");
    expect(badge.getAttribute("title")).toContain("Actively working");
    expect(badge.querySelector(".pane-working-time-pulse")).toBeTruthy();
  });

  it("loads stored completed working time from localStorage in minute intervals", () => {
    localStorage.setItem(
      "space.paneWorkingTime.v2:pane-test-3",
      JSON.stringify({
        paneId: "pane-test-3",
        completedWorkingMs: 25 * 60 * 1000,
        lastSavedAt: Date.now()
      })
    );

    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-3"
        isWorking={false}
      />
    );

    expect(screen.getByText("25m")).toBeTruthy();
  });

  it("clamps impossible stored working time using paneCreatedAt age", () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    localStorage.setItem(
      "space.paneWorkingTime.v2:pane-test-4",
      JSON.stringify({
        paneId: "pane-test-4",
        completedWorkingMs: 18 * 3600 * 1000, // corrupted 18 hours
        lastSavedAt: Date.now()
      })
    );

    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-4"
        paneCreatedAt={oneHourAgo}
        isWorking={false}
      />
    );

    // Clamped to ~1h lifetime -> "1h 0m"
    expect(screen.getByText("1h 0m")).toBeTruthy();
  });

  it("synchronizes with authoritative server cumulative time and updates localStorage", async () => {
    localStorage.setItem(
      "space.paneWorkingTime.v2:pane-test-sync",
      JSON.stringify({
        paneId: "pane-test-sync",
        completedWorkingMs: 21 * 3600 * 1000, // inflated drift
        lastSavedAt: Date.now()
      })
    );

    const { installSpaceRuntime, SpaceRuntimeProvider } = await import("../src/runtime/SpaceRuntime.js");
    const { liveRuntime } = await import("../src/live/live-runtime.js");
    installSpaceRuntime(liveRuntime);
    vi.spyOn(liveRuntime.api, "paneWorkingTime").mockResolvedValue({
      paneId: "pane-test-sync",
      cumulativeWorkingMs: 9 * 3600 * 1000, // authoritative server truth
      isWorking: false,
      state: "IDLE"
    });

    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-sync"
        isWorking={false}
      />
    );

    // After hydration resolves, it should display 9h 0m rather than the inflated 21h
    expect(await screen.findByText("9h 0m")).toBeTruthy();
  });

  it("does not ask the server about an optimistic pane that has no server record yet", async () => {
    const { installSpaceRuntime } = await import("../src/runtime/SpaceRuntime.js");
    const { liveRuntime } = await import("../src/live/live-runtime.js");
    installSpaceRuntime(liveRuntime);
    const request = vi.spyOn(liveRuntime.api, "paneWorkingTime").mockResolvedValue({ paneId: "x", cumulativeWorkingMs: 0, isWorking: false, state: "IDLE" });
    render(<PaneWorkingTimeBadge paneId="pane:optimistic-123-0" isWorking={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Pane working time eligibility by pane mode", () => {
  function shouldShowWorkingTime(mode: string): boolean {
    return mode === "TERMINAL" || mode === "CHAT" || mode === "HARNESS";
  }

  it("shows working time badge only on CLI (TERMINAL), CHAT, and HARNESS panes", () => {
    expect(shouldShowWorkingTime("TERMINAL")).toBe(true);
    expect(shouldShowWorkingTime("CHAT")).toBe(true);
    expect(shouldShowWorkingTime("HARNESS")).toBe(true);
  });

  it("hides working time badge on non-agent panes such as YOUTUBE, BROWSER, FILES, DATABASES, DEMOS, VNC", () => {
    expect(shouldShowWorkingTime("YOUTUBE")).toBe(false);
    expect(shouldShowWorkingTime("BROWSER")).toBe(false);
    expect(shouldShowWorkingTime("FILES")).toBe(false);
    expect(shouldShowWorkingTime("DATABASES")).toBe(false);
    expect(shouldShowWorkingTime("DEMOS")).toBe(false);
    expect(shouldShowWorkingTime("VNC")).toBe(false);
    expect(shouldShowWorkingTime("LIVE")).toBe(false);
  });
});

describe("SpaceApp Themed Working Time Badge", () => {
  it("renders clock icon, formatted working time, and status role", () => {
    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-badge"
        isWorking={false}
      />
    );

    const badge = screen.getByRole("status");
    expect(badge).toBeTruthy();

    const icon = badge.querySelector(".pane-working-time-icon svg");
    expect(icon).toBeTruthy();

    const digits = badge.querySelector(".pane-working-time-digits");
    expect(digits?.textContent).toBe("0m");
  });

  it("displays stored hours and minutes formatted cleanly in SpaceApp style", () => {
    localStorage.setItem(
      "space.paneWorkingTime.v2:pane-test-hours",
      JSON.stringify({
        paneId: "pane-test-hours",
        completedWorkingMs: (18 * 3600 + 45 * 60) * 1000, // 18h 45m
        lastSavedAt: Date.now()
      })
    );

    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-hours"
        isWorking={false}
      />
    );

    const digits = document.querySelector(".pane-working-time-digits");
    expect(digits?.textContent).toBe("18h 45m");
  });

  it("adapts category color attribute dynamically", () => {
    const { rerender } = render(
      <PaneWorkingTimeBadge
        paneId="pane-test-color"
        isWorking={false}
        categoryColor="cyan"
      />
    );

    let badge = screen.getByRole("status");
    expect(badge.getAttribute("data-category-color")).toBe("cyan");

    rerender(
      <PaneWorkingTimeBadge
        paneId="pane-test-color"
        isWorking={true}
        categoryColor="orange"
      />
    );

    badge = screen.getByRole("status");
    expect(badge.getAttribute("data-category-color")).toBe("orange");
  });

  it("handles user click interaction cleanly", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <PaneWorkingTimeBadge
        paneId="pane-test-click"
        isWorking={false}
      />
    );

    const badge = screen.getByRole("status");
    fireEvent.click(badge);
    expect(badge).toBeTruthy();
  });
});


