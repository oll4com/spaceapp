import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Pane, Turn } from "@space/contracts";
import {
  MinimizedPaneChip,
  MinimizedPanePreviewCard,
  formatPreviewAge
} from "../src/features/pane-float/MinimizedPanePreview.js";
import {
  appendTerminalPreviewChunk,
  seedTerminalPreviewLines
} from "../src/features/terminal-pane/terminal-preview-service.js";

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:minimized",
    roomId: "room:test",
    title: "Easy visual recognition",
    titleSource: "auto",
    paneName: "Iris",
    mode: "TERMINAL",
    status: "IDLE",
    providerId: null,
    modelId: null,
    terminalRuntimeId: "cli:claude",
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: true,
    isClosed: false,
    categoryColor: null,
    vncTarget: null,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides
  } as Pane;
}

function renderCard(target: Pane, props: Partial<Parameters<typeof MinimizedPanePreviewCard>[0]> = {}) {
  const onRestore = vi.fn();
  const view = render(
    <MinimizedPanePreviewCard
      pane={target}
      icon={<span data-testid="pane-icon" />}
      title={target.paneName ?? target.title}
      subtitle={target.title}
      fullTitle={`${target.paneName} · ${target.title}`}
      modeLabel="CLI"
      isRunning={false}
      onRestore={onRestore}
      {...props}
    />
  );
  return { ...view, onRestore };
}

describe("MinimizedPanePreviewCard", () => {
  it("shows real CLI output and the current activity instead of TUI chrome", () => {
    const target = pane({ id: "pane:preview-claude" });
    seedTerminalPreviewLines(target.id, ["● Read(src/App.tsx)"]);
    appendTerminalPreviewChunk(
      target.id,
      [
        "  ⎿  Read 120 lines\r\n",
        "✻ Thinking… (8s · esc to interrupt)\r\n",
        "──────────────────────────────\r\n",
        "❯ \r\n",
        "──────────────────────────────\r\n",
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n"
      ].join("")
    );

    const { container, onRestore } = renderCard(target);
    const card = container.querySelector(".minimized-preview-card")!;
    expect(card.getAttribute("data-status")).toBe("working");
    expect(card.querySelector(".minimized-preview-card-title")?.textContent).toBe("Iris");
    expect(card.querySelector(".minimized-preview-card-subtitle")?.textContent).toContain("Easy visual recognition");

    const lines = Array.from(card.querySelectorAll(".minimized-preview-terminal-line")).map((line) => line.textContent);
    expect(lines).toEqual(["● Read(src/App.tsx)", "  └  Read 120 lines"]);
    expect(card.textContent).not.toContain("bypass permissions");
    expect(card.querySelector(".minimized-preview-status-detail")?.textContent).toBe("Thinking… · 8s");
    expect(screen.getByText("Working")).toBeTruthy();

    fireEvent.click(card);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it("highlights a pane that is waiting for approval", () => {
    const target = pane({ id: "pane:preview-approval" });
    seedTerminalPreviewLines(target.id, ["● Bash(npm run deploy)", "Do you want to proceed?", "❯ 1. Yes", "  2. No"]);

    const { container } = renderCard(target, { isRunning: true });
    const card = container.querySelector(".minimized-preview-card")!;
    expect(card.getAttribute("data-status")).toBe("attention");
    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(card.querySelector(".minimized-preview-status-detail")?.textContent).toBe("Do you want to proceed?");
  });

  it("reports idle panes with no output", () => {
    const { container } = renderCard(pane({ id: "pane:preview-empty" }));
    expect(container.querySelector(".minimized-preview-card")?.getAttribute("data-status")).toBe("idle");
    expect(screen.getByText("No output yet")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("previews the last chat prompt with the turn status", () => {
    const target = pane({ id: "pane:preview-chat", mode: "CHAT", terminalRuntimeId: null });
    const turn = { id: "turn:1", paneId: target.id, status: "FAILED", prompt: "Summarize the deploy log" } as Turn;
    const { container } = renderCard(target, { latestTurn: turn, modeLabel: "Chat" });
    expect(container.querySelector(".minimized-preview-card")?.getAttribute("data-status")).toBe("error");
    expect(screen.getByText("Summarize the deploy log")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});

describe("MinimizedPaneChip", () => {
  it("shows the pane name and flags a pending approval", () => {
    const target = pane({ id: "pane:chip-approval" });
    seedTerminalPreviewLines(target.id, ["Do you want to make this edit to App.tsx?", "❯ 1. Yes"]);
    const onRestore = vi.fn();
    render(
      <MinimizedPaneChip
        pane={target}
        icon={<span />}
        title="Iris"
        fullTitle="Iris · Easy visual recognition"
        isRunning={false}
        onRestore={onRestore}
      />
    );

    const chip = screen.getByRole("button", { name: "Restore pane Iris · Easy visual recognition" });
    expect(chip.textContent).toContain("Iris");
    expect(chip.getAttribute("data-status")).toBe("attention");
    expect(chip.getAttribute("title")).toBe("Iris · Easy visual recognition (Needs input)");
    fireEvent.click(chip);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});

describe("formatPreviewAge", () => {
  it("formats relative output age", () => {
    const now = 1_000_000_000;
    expect(formatPreviewAge(0, now)).toBeNull();
    expect(formatPreviewAge(now - 2_000, now)).toBe("just now");
    expect(formatPreviewAge(now - 42_000, now)).toBe("42s ago");
    expect(formatPreviewAge(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatPreviewAge(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
