import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpPage } from "../src/features/help/HelpPage.js";
import { helpEntries, helpSections } from "../src/features/help/help-content.js";

afterEach(() => cleanup());

describe("Space Help catalog", () => {
  it("covers every operator-facing Space surface with unique, detailed entries", () => {
    expect(helpSections.map((section) => section.id)).toEqual([
      "getting-started",
      "rooms-and-navigation",
      "room-toolbar",
      "system-metrics",
      "pane-controls",
      "chat-panes",
      "cli-panes",
      "browser-panes",
      "docks-and-settings",
      "memory-and-dashboards",
      "responsive-and-customization",
      "status-symbols"
    ]);
    expect(helpEntries.length).toBeGreaterThanOrEqual(90);
    expect(new Set(helpEntries.map((entry) => entry.id)).size).toBe(helpEntries.length);

    for (const entry of helpEntries) {
      expect(entry.label.trim().length).toBeGreaterThan(1);
      expect(entry.location.trim().length).toBeGreaterThan(2);
      expect(entry.description.trim().length).toBeGreaterThan(20);
    }

    const labels = new Set(helpEntries.map((entry) => entry.label));
    for (const requiredLabel of [
      "Help",
      "Rooms",
      "Room pane composer",
      "Room Agent",
      "Media dock",
      "Clipboard",
      "Links",
      "Quick Links",
      "Settings dock",
      "Health dock",
      "Open memory workspace",
      "Workspace text size",
      "Pane layout",
      "Add chat pane",
      "Add CLI pane",
      "Add Codex CLI",
      "Add Claude Code CLI",
      "Add Gemini CLI",
      "Add OpenCode CLI",
      "Add Autohand Code CLI",
      "Add Qwen Code CLI",
      "Add Kimi Code CLI",
      "Add Grok Build CLI",
      "Add DeepSeek CLI",
      "Add Cursor CLI",
      "Add GitHub Copilot CLI",
      "Add CLI ROOT",
      "Server restart",
      "Clip Tool",
      "More room actions",
      "Move pane",
      "Enable Plan mode",
      "Save task to memory",
      "Resume CLI task",
      "Copy CLI contents",
      "Browser bookmarks",
      "Capture browser screenshot",
      "Record browser session",
      "Open browser debugger",
      "Telegram notifications",
      "Voice input",
      "Search memory",
      "Toolbar customization"
    ]) {
      expect(labels.has(requiredLabel), `Missing Help entry: ${requiredLabel}`).toBe(true);
    }
    expect(helpEntries.filter((entry) => entry.label === "Workspace text size")).toHaveLength(1);
    const sharedCliLauncherIcon = helpEntries.find((entry) => entry.label === "Add CLI pane")?.icon;
    expect(helpEntries.find((entry) => entry.label === "Add CLI pane")?.description).toContain(
      "OpenCode (free default model), Codex, Claude Code, Gemini, Autohand Code, Qwen Code, Kimi Code, Grok Build, DeepSeek, Cursor, GitHub Copilot, Hermes Agent, Oh My Pi, Qoder, Muse Code, and Droid"
    );
    expect(helpEntries.find((entry) => entry.id === "add-deepseek")?.description).toContain("provider-advertised model");
    expect(helpEntries.find((entry) => entry.id === "add-deepseek")?.description).not.toContain("deepseek-v4-flash");
    expect(helpEntries.find((entry) => entry.id === "cli-resume")?.description).toBe(
      "Searches shared Space CLI task history and continues the selected task in the pane's existing runtime."
    );
    expect(
      helpEntries
        .filter((entry) => ["Add Codex CLI", "Add Claude Code CLI", "Add Gemini CLI", "Add OpenCode CLI", "Add Autohand Code CLI", "Add Qwen Code CLI", "Add Kimi Code CLI", "Add Grok Build CLI", "Add DeepSeek CLI", "Add Cursor CLI", "Add GitHub Copilot CLI"].includes(entry.label))
        .every((entry) => entry.icon === sharedCliLauncherIcon && entry.location === "Add CLI pane selector")
    ).toBe(true);
    expect(labels.has("Increase workspace text size")).toBe(false);
    expect(labels.has("Decrease workspace text size")).toBe(false);
  });

  it("marks privileged, conditional, and informational controls explicitly", () => {
    expect(helpEntries.find((entry) => entry.label === "Add CLI ROOT")?.badges).toContain("ADMIN");
    expect(helpEntries.find((entry) => entry.label === "Server restart")?.badges).toContain("ADMIN");
    expect(helpEntries.some((entry) => entry.badges?.includes("CONDITIONAL"))).toBe(true);
    expect(helpEntries.some((entry) => entry.badges?.includes("INFORMATIONAL"))).toBe(true);
  });
});

describe("HelpPage", () => {
  it("defines a scrollable desktop layout and a compact mobile layout", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain(".help-page {");
    expect(styles).toMatch(/\.help-page\s*\{[^}]*overflow-y:\s*auto/s);
    expect(styles).toContain(".help-navigation {");
    expect(styles).toMatch(/@media \(max-width: 767px\)[\s\S]*\.help-layout/);
  });

  it("renders an English, searchable guide with accessible navigation", () => {
    const onBack = vi.fn();
    const { container } = render(<HelpPage onBack={onBack} />);

    expect(screen.getByRole("heading", { level: 1, name: "Space Help" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Help sections" })).toBeTruthy();
    const search = screen.getByRole("searchbox", { name: "Search Space Help" });
    expect(search.getAttribute("id")).toBe("space-help-search");
    expect(search.getAttribute("name")).toBe("space-help-search");
    expect(screen.getByRole("status").textContent).toMatch(/\d+ controls documented/);
    expect(container.querySelectorAll('.help-entry-icon svg[aria-hidden="true"]')).toHaveLength(helpEntries.length);

    fireEvent.click(screen.getByRole("button", { name: "Back to Space" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("filters labels, descriptions, locations, and badges and handles no results", () => {
    render(<HelpPage onBack={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search Space Help" });

    fireEvent.change(search, { target: { value: "Telegram" } });
    expect(screen.getByText("Telegram notifications")).toBeTruthy();
    expect(screen.queryByText("Clip Tool")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/matching “Telegram”/);

    fireEvent.change(search, { target: { value: "ADMIN" } });
    expect(screen.getByText("Add CLI ROOT")).toBeTruthy();
    expect(screen.getByText("Server restart")).toBeTruthy();

    fireEvent.change(search, { target: { value: "no-such-space-control" } });
    expect(screen.getByRole("status").textContent).toContain("No Help entries match");
  });
});
