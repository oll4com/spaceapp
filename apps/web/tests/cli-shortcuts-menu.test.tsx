import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliShortcutsMenu, clearLegacyCliShortcutUsage, cliTranscriptCommand } from "../src/features/terminal-pane/CliShortcutsMenu.js";
import { CliShortcutVisibilitySettings } from "../src/features/terminal-pane/CliShortcutVisibilitySettings.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import {
  HIDEABLE_CLI_SHORTCUT_IDS,
  OSK_CLI_COMMANDS,
  normalizeHiddenCliShortcuts,
  orderVisibleCliShortcuts
} from "../src/features/osk-keyboard/cli-shortcuts.js";
import { VOICE_SETTINGS_STORAGE_KEY, defaultVoiceComposerSettings } from "../src/voice-settings.js";

import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

// Two-column menu, filled row by row: Continue top-left, Clear last, transcript after it.
const FIXED_ORDER = [
  "continue", "plan_progress",
  "plan", "build",
  "permissions", "model",
  "memory", "test",
  "deploy", "promote",
  "clean_worktree", "status",
  "usage", "resume",
  "help", "scroll_top",
  "scroll_bottom", "clear",
  "transcript"
];

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("CLI shortcut targeting", () => {
  it("selects exactly one command on its owning pane and preserves Enter semantics", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<><CliShortcutsMenu active disabled={false} onCommand={first} /><CliShortcutsMenu active disabled={false} onCommand={second} /></>);
    for (const [label, text, enter] of [["Plan mode", "", undefined], ["Permissions", "", undefined], ["continue", "continue", true], ["Save to memory", "save to memory", true], ["/help", "/help", true]] as const) {
      fireEvent.click(screen.getAllByRole("button", { name: "CLI shortcuts" })[1]!);
      const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
      fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(label) }));
      expect(second).toHaveBeenLastCalledWith(expect.objectContaining({ text, ...(enter ? { enter } : {}) }));
      expect(second.mock.lastCall?.[0].enter).toBe(enter);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(second).toHaveBeenCalledTimes(5);
    expect(first).not.toHaveBeenCalled();
  });

  it("sends the transcript control byte only from the enabled Codex menu without Enter", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    expect(screen.queryByRole("button", { name: "Ctrl+T · Full transcript" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    rerender(<CliShortcutsMenu active disabled={false} onCommand={onCommand} showTranscript />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+T · Full transcript" }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ id: "transcript", label: "Ctrl+T · Full transcript", text: "\u0014" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Claude Code its own Ctrl+O transcript key and never the Codex Ctrl+T byte", () => {
    expect(cliTranscriptCommand("cli:codex")).toEqual({ id: "transcript", label: "Ctrl+T · Full transcript", text: "\u0014" });
    expect(cliTranscriptCommand("cli:claude")).toEqual({ id: "transcript", label: "Ctrl+O · Verbose transcript", text: "\u000f" });
    expect(cliTranscriptCommand("cli:gemini")).toBeNull();
    expect(cliTranscriptCommand(null)).toBeNull();
    const onCommand = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} transcriptCommand={cliTranscriptCommand("cli:claude")} />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    expect(screen.queryByRole("button", { name: "Ctrl+T · Full transcript" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+O · Verbose transcript" }));
    expect(onCommand).toHaveBeenCalledExactlyOnceWith({ id: "transcript", label: "Ctrl+O · Verbose transcript", text: "\u000f" });
  });

  it("keeps one fixed order with Continue top-left no matter how often shortcuts are used", () => {
    const command = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={command} showTranscript />);
    const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    const order = () => Array.from(screen.getByRole("dialog").querySelectorAll("button[data-shortcut]:not(.terminal-shortcut-key)"))
      .map(button => button.getAttribute("data-shortcut"));
    openMenu();
    expect(order()).toEqual(FIXED_ORDER);
    for (const name of ["/help", "/help", "Ctrl+T · Full transcript", "/status", "/help"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      openMenu();
      expect(order()).toEqual(FIXED_ORDER);
    }
    expect(command).toHaveBeenCalledTimes(5);
  });

  it("hides the shortcuts chosen in Settings without moving the rest or Continue", () => {
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      ...defaultVoiceComposerSettings,
      terminalControlsVersion: 2,
      terminalHiddenShortcuts: ["continue", "plan_progress", "clear", "test", "unknown_id"]
    }));
    render(<VoiceInputProvider><CliShortcutsMenu active disabled={false} onCommand={vi.fn()} showTranscript /></VoiceInputProvider>);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    const order = Array.from(screen.getByRole("dialog").querySelectorAll("button[data-shortcut]:not(.terminal-shortcut-key)"))
      .map(button => button.getAttribute("data-shortcut"));
    expect(order).toEqual(FIXED_ORDER.filter(id => !["plan_progress", "clear", "test"].includes(id)));
    expect(order[0]).toBe("continue");
  });

  it("puts Continue first, keeps relative order for chat-mode subsets and normalizes stored ids", () => {
    const shuffled = [...OSK_CLI_COMMANDS].reverse();
    expect(orderVisibleCliShortcuts(shuffled, ["continue"])[0]?.id).toBe("continue");
    const chatMode = OSK_CLI_COMMANDS.filter(command => Boolean(command.action) || ["plan_progress", "deploy", "promote", "clean_worktree"].includes(command.id));
    expect(orderVisibleCliShortcuts(chatMode).map(command => command.id))
      .toEqual(FIXED_ORDER.filter(id => chatMode.some(command => command.id === id)));
    expect(normalizeHiddenCliShortcuts(["clear", "continue", "clear", "transcript", 7, "nope", "plan"]))
      .toEqual(["plan", "clear", "transcript"]);
    expect(normalizeHiddenCliShortcuts("clear")).toEqual([]);
    expect(HIDEABLE_CLI_SHORTCUT_IDS).toEqual(FIXED_ORDER.slice(1));
  });

  it("removes the old usage counters that used to reorder the menu", () => {
    window.localStorage.setItem("space.cliShortcutUsage.v1.user%3Atest", JSON.stringify({ help: 9 }));
    window.localStorage.setItem("space.unrelated", "keep");
    clearLegacyCliShortcutUsage();
    expect(window.localStorage.getItem("space.cliShortcutUsage.v1.user%3Atest")).toBeNull();
    expect(window.localStorage.getItem("space.unrelated")).toBe("keep");
    const blocked = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Unavailable"); });
    window.localStorage.setItem("space.cliShortcutUsage.v1.other", "{}");
    expect(() => clearLegacyCliShortcutUsage()).not.toThrow();
    blocked.mockRestore();
  });

  it("lets Settings hide shortcuts in menu order while Continue stays locked on", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CliShortcutVisibilitySettings hiddenIds={[]} onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Visible shortcuts" });
    expect(Array.from(group.querySelectorAll("[data-shortcut]")).map(item => item.getAttribute("data-shortcut"))).toEqual(FIXED_ORDER);
    const continueBox = within(group).getByRole("switch", { name: "Continue" }) as HTMLInputElement;
    expect(continueBox.checked).toBe(true);
    expect(continueBox.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Show all" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(group).getByRole("switch", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith(["clear"]);
    rerender(<CliShortcutVisibilitySettings hiddenIds={["clear"]} onChange={onChange} />);
    fireEvent.click(within(group).getByRole("switch", { name: "Test" }));
    expect(onChange).toHaveBeenLastCalledWith(["test", "clear"]);
    fireEvent.click(within(group).getByRole("switch", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("asks for a second click before sending /clear", () => {
    vi.useFakeTimers();
    try {
      const onCommand = vi.fn();
      render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
      fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
      fireEvent.click(screen.getByRole("button", { name: "/clear" }));
      expect(onCommand).not.toHaveBeenCalled();
      const confirm = screen.getByRole("button", { name: "Confirm /clear" });
      expect(confirm.textContent).toContain("Confirm clear");
      // The confirmation expires, so a stray click later is a first click again.
      act(() => { vi.advanceTimersByTime(4_000); });
      fireEvent.click(screen.getByRole("button", { name: "/clear" }));
      expect(onCommand).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm /clear" }));
      expect(onCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "clear", text: "/clear", enter: true }));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says in the tooltip exactly what a shortcut sends", () => {
    render(<CliShortcutsMenu active disabled={false} onCommand={vi.fn()} showTranscript />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    expect(screen.getByRole("button", { name: "/help" }).getAttribute("title")).toBe('Help — sends "/help" and Enter');
    expect(screen.getByRole("button", { name: "Deploy" }).getAttribute("title")).toBe('Deploy — sends "Deploy the project to Gitea and GitHub." and Enter');
    expect(screen.getByRole("button", { name: "Clean worktree" }).getAttribute("title")).toMatch(/^Clean worktree — sends ".{87}…" and Enter$/);
    expect(screen.getByRole("button", { name: "Ctrl+T · Full transcript" }).getAttribute("title")).toBe("Ctrl+T · Full transcript — sends Ctrl+T");
    expect(screen.getByRole("button", { name: "Plan mode" }).getAttribute("title")).toBe("Plan mode");
  });

  it("moves focus through the two-column grid with the arrow keys", () => {
    render(<CliShortcutsMenu active disabled={false} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute("data-shortcut");
    expect(focused()).toBe("continue");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(focused()).toBe("plan_progress");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(focused()).toBe("build");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(focused()).toBe("plan");
    fireEvent.keyDown(dialog, { key: "End" });
    expect(focused()).toBe("enter");
    fireEvent.keyDown(dialog, { key: "Home" });
    expect(focused()).toBe("continue");
  });

  it("dismisses without submitting on Escape, outside click or room hiding", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
    const trigger = screen.getByRole("button", { name: "CLI shortcuts" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    rerender(<CliShortcutsMenu active={false} disabled={false} onCommand={onCommand} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("stays open when a click on the gaps between shortcuts drops focus, and closes when Tab leaves it", () => {
    render(<><CliShortcutsMenu active disabled={false} onCommand={vi.fn()} /><button type="button">Elsewhere</button></>);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.blur(within(dialog).getByRole("button", { name: "continue" }), { relatedTarget: null });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.blur(within(dialog).getByRole("button", { name: "continue" }), { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders Esc and Enter buttons in the bottom right group and triggers their shortcut actions", () => {
    const onCommand = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
    const trigger = screen.getByRole("button", { name: "CLI shortcuts" });

    // Test Esc button
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    const escButton = within(dialog).getByRole("button", { name: "Esc" });
    expect(escButton).toBeTruthy();
    expect(escButton.getAttribute("data-shortcut")).toBe("esc");
    fireEvent.click(escButton);
    expect(onCommand).toHaveBeenLastCalledWith({ id: "esc", label: "Esc", text: "\u001b" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // Test Enter button
    fireEvent.click(trigger);
    const dialog2 = screen.getByRole("dialog", { name: "CLI shortcuts" });
    const enterButton = within(dialog2).getByRole("button", { name: "Enter" });
    expect(enterButton).toBeTruthy();
    expect(enterButton.getAttribute("data-shortcut")).toBe("enter");
    fireEvent.click(enterButton);
    expect(onCommand).toHaveBeenLastCalledWith({ id: "enter", label: "Enter", text: "\r" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides Esc and Enter buttons when showKeys is false", () => {
    const onCommand = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} showKeys={false} />);
    fireEvent.click(screen.getByRole("button", { name: "CLI shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    expect(within(dialog).queryByRole("button", { name: "Esc" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Enter" })).toBeNull();
  });

  it("clamps position to prevent overflowing off the left edge of the viewport when pane is on far left", () => {
    const onCommand = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
    const trigger = screen.getByRole("button", { name: "CLI shortcuts" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 500, bottom: 536, left: 10, right: 150, width: 140, height: 36, x: 10, y: 500, toJSON: () => {}
    });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    expect(dialog).toBeTruthy();
    const rightStyle = parseFloat(dialog.style.right);
    // Right offset is clamped so that left = window.innerWidth - rightStyle - popoverWidth >= 8
    expect(rightStyle).toBeLessThanOrEqual(window.innerWidth - 336 - 8);
  });

  it("inherits theme attributes from the surrounding shell or body onto the popover dialog", () => {
    const onCommand = vi.fn();
    render(
      <main className="space-shell" data-room-theme="copper" data-ui-theme="modern" data-interface-theme="codex" data-color-mode="dark">
        <CliShortcutsMenu active disabled={false} onCommand={onCommand} />
      </main>
    );
    const trigger = screen.getByRole("button", { name: "CLI shortcuts" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    expect(dialog.getAttribute("data-room-theme")).toBe("copper");
    expect(dialog.getAttribute("data-ui-theme")).toBe("modern");
    expect(dialog.getAttribute("data-interface-theme")).toBe("codex");
    expect(dialog.getAttribute("data-color-mode")).toBe("dark");
  });

  it("renders Scroll to top and Scroll to bottom buttons and triggers their shortcut actions", () => {
    const onCommand = vi.fn();
    render(<CliShortcutsMenu active disabled={false} onCommand={onCommand} />);
    const trigger = screen.getByRole("button", { name: "CLI shortcuts" });

    // Test Scroll to top
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "CLI shortcuts" });
    const scrollTopButton = within(dialog).getByRole("button", { name: "Scroll to top" });
    expect(scrollTopButton).toBeTruthy();
    expect(scrollTopButton.getAttribute("data-shortcut")).toBe("scroll_top");
    fireEvent.click(scrollTopButton);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ id: "scroll_top", action: "scroll_top" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Test Scroll to bottom
    fireEvent.click(trigger);
    const dialog2 = screen.getByRole("dialog", { name: "CLI shortcuts" });
    const scrollBottomButton = within(dialog2).getByRole("button", { name: "Scroll to bottom" });
    expect(scrollBottomButton).toBeTruthy();
    expect(scrollBottomButton.getAttribute("data-shortcut")).toBe("scroll_bottom");
    fireEvent.click(scrollBottomButton);
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ id: "scroll_bottom", action: "scroll_bottom" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
