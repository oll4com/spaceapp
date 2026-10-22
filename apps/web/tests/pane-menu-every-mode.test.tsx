import { writeFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoSpaceApp } from "../src/demo/DemoSpaceApp.js";
import { demoRuntimeBundle } from "../src/demo/demo-runtime.js";

vi.mock("../src/features/terminal-pane/index.js", () => ({
  createTerminalBootstrapBarrier: () => ({
    join: () => ({ arrive: async () => undefined }),
    waitForTerminalSetupTask: async () => undefined
  }),
  TerminalPane: ({ pane }: { pane: { title: string } }) => (
    <section aria-label={`CLI pane ${pane.title}`}>Local demo terminal fixture</section>
  )
}));

vi.setConfig({ testTimeout: 120_000 });

// jsdom has no ResizeObserver; the Databases and T3 Code panes measure themselves with it.
if (!("ResizeObserver" in globalThis)) {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
}
if (typeof window.matchMedia !== "function") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
  }));
}

type MenuItem = { label: string; disabled: boolean; reason: string };

afterEach(() => {
  demoRuntimeBundle.runtime.reset();
});

describe("pane actions menu in every pane mode", () => {
  it("explains every item it disables and offers only actions the pane can run", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 1000 });
    const rooms = await demoRuntimeBundle.runtime.api.rooms();
    const room = rooms.data.find((candidate) => candidate.name === "Operations")!;
    await demoRuntimeBundle.runtime.api.createRoomPanes(room.id, {
      // DATABASES and T3CODE share the DEMOS/FILES action list in PaneCard; the demo store cannot create them.
      panes: ["HARNESS", "LIVE", "VNC", "YOUTUBE", "FILES", "DEMOS", "BROWSER", "CHAT"].map((mode) => ({ mode })) as never
    });
    await demoRuntimeBundle.runtime.api.createRoomPanes(room.id, {
      panes: [{ mode: "TERMINAL", terminalRuntimeId: "cli:deepseek" }] as never
    });

    render(<DemoSpaceApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Operations" }));
    await waitFor(() => expect(document.querySelectorAll('[data-space-pane-id] button[aria-label^="More pane actions "]').length).toBeGreaterThanOrEqual(10));

    const inventory: Record<string, { mode: string | null; items: MenuItem[] }> = {};
    const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-space-pane-id] button[aria-label^="More pane actions "]'));
    for (const trigger of triggers) {
      const title = trigger.getAttribute("aria-label")!.replace("More pane actions ", "");
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu", { name: `Pane actions ${title}` });
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')).map((item) => ({
        label: item.getAttribute("aria-label") ?? item.textContent?.trim() ?? "",
        disabled: item.disabled,
        reason: item.title
      }));
      inventory[title] = { mode: trigger.closest("[data-pane-mode]")?.getAttribute("data-pane-mode") ?? null, items };
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { name: `Pane actions ${title}` })).toBeNull());
    }

    const modes = new Set(Object.values(inventory).map((entry) => entry.mode));
    for (const mode of ["HARNESS", "LIVE", "VNC", "YOUTUBE", "FILES", "DEMOS", "BROWSER", "CHAT", "TERMINAL", "REVIEW", "SWARM", "CODE"]) {
      expect(modes, `menu inventory for ${mode}`).toContain(mode);
    }
    for (const [title, { items }] of Object.entries(inventory)) {
      expect(items.length, `${title} offers actions`).toBeGreaterThan(0);
      // A disabled item must say why, so it is never a silent dead end.
      for (const item of items.filter((entry) => entry.disabled)) {
        expect(item.reason, `${title}: ${item.label}`).not.toBe("");
      }
      expect(items.map((item) => item.label), `${title} keeps the honest upload label`).not.toContain("Import files to pane");
    }
    const byMode = (mode: string) => Object.entries(inventory).filter(([, entry]) => entry.mode === mode).map(([title, entry]) => ({ title, ...entry }));
    for (const youtube of byMode("YOUTUBE")) {
      const labels = youtube.items.map((item) => item.label);
      expect(new Set(labels).size, `${youtube.title} lists each action once`).toBe(labels.length);
      expect(labels.filter((label) => /YouTube toolbar$/.test(label))).toHaveLength(1);
    }
    for (const live of byMode("LIVE")) {
      expect(live.items.some((item) => item.label === `Import files ${live.title}`)).toBe(true);
      // Live actions stay disabled until the lazy Live pane listens for them, then turn on.
      await waitFor(async () => {
        fireEvent.click(screen.getByRole("button", { name: `More pane actions ${live.title}` }));
        const menu = await screen.findByRole("menu", { name: `Pane actions ${live.title}` });
        const camera = menu.querySelector<HTMLButtonElement>(`[aria-label="Camera ${live.title}"]`);
        const enabled = camera?.disabled === false;
        fireEvent.keyDown(menu, { key: "Escape" });
        expect(enabled).toBe(true);
      }, { timeout: 15_000 });
    }
    // Every CLI pane offers Stop, disabled with a reason until a turn runs.
    for (const cli of byMode("TERMINAL")) {
      const stop = cli.items.find((item) => item.label === `Stop ${cli.title}`);
      expect(stop?.disabled, `${cli.title} Stop`).toBe(true);
    }
    // Optional evidence dump for manual review: PANE_MENU_INVENTORY_PATH=/path/inventory.json
    if (process.env.PANE_MENU_INVENTORY_PATH) writeFileSync(process.env.PANE_MENU_INVENTORY_PATH, JSON.stringify(inventory, null, 1));
  });
});

describe("Chat task history", () => {
  it("lists only conversations of the Chat's own Dot and room, which can all be reopened", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1600 });
    render(<DemoSpaceApp />);
    const trigger = await screen.findByRole("button", { name: "More pane actions Product Copilot" });
    const paneId = trigger.closest("[data-space-pane-id]")!.getAttribute("data-space-pane-id")!;
    const session = await demoRuntimeBundle.runtime.api.agentSession(paneId);
    const dotId = session.dotId!;
    const rooms = await demoRuntimeBundle.runtime.api.rooms();
    const roomId = rooms.data.find((room) => room.name === "Launch Control")!.id;
    const expected = (await demoRuntimeBundle.runtime.api.dotCollection(dotId, "sessions")).items
      .filter((item) => item.roomId === roomId && item.threadId)
      .map((item) => item.title);
    expect(expected.length).toBeGreaterThan(0);

    await waitFor(async () => {
      fireEvent.click(trigger);
      const menu = await screen.findByRole("menu", { name: "Pane actions Product Copilot" });
      const history = menu.querySelector<HTMLButtonElement>('[aria-label="Task history"]');
      const enabled = history?.disabled === false;
      if (enabled) fireEvent.click(history!);
      else fireEvent.keyDown(menu, { key: "Escape" });
      expect(enabled).toBe(true);
    }, { timeout: 15_000 });
    const dialog = await screen.findByRole("dialog", { name: "Open Codex task history" });
    await waitFor(() => expect(dialog.querySelectorAll(".vscode-codex-task-row").length).toBe(expected.length));
    const titles = Array.from(dialog.querySelectorAll(".vscode-codex-task-row strong")).map((node) => node.textContent);
    expect(titles.sort()).toEqual([...expected].sort());

    fireEvent.click(dialog.querySelector<HTMLButtonElement>(".vscode-codex-task-row")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Open Codex task history" })).toBeNull());
    expect(screen.queryByText("This conversation does not belong to the selected Dot and room.")).toBeNull();
  });
});
