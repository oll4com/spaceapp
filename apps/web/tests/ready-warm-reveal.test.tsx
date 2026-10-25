import { useEffect } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { roomRuntimeLayerHasEmptyState } from "../src/App.js";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { deferred, installFetchFixture, setViewport, terminalPanes } from "./responsive-shell-fixture.js";

// App's presentation contract is tested with a terminal that has completed
// bootstrap and PREFILL. The real terminal's rendering remains a browser gate.
vi.mock("../src/features/terminal-pane/TerminalPane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/terminal-pane/TerminalPane.js")>();
  return { ...actual, TerminalPane: ({ pane, onBootstrapped, onPrefillReadyChange }: {
    pane: Pane; onBootstrapped?: (id: string) => void; onPrefillReadyChange?: (id: string, ready: boolean) => void;
  }) => {
    useEffect(() => {
      onBootstrapped?.(pane.id);
      onPrefillReadyChange?.(pane.id, true);
    }, [pane.id]);
    return <section className="terminal-pane" data-terminal-status="attached" data-terminal-prefill-ready="true"
      data-terminal-loading="false" data-terminal-action-pending="false" data-terminal-has-error="false">
      <div className="terminal-xterm" data-terminal-pending-prefill-events="0" data-terminal-pending-prefill-bytes="0">
        <div className="xterm-screen" />
      </div>
    </section>;
  }};
});

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("space.uiTheme.v1", "modern");
  localStorage.setItem("space.warmRoom.enabled.v1", "true");
  window.history.replaceState({}, "", "/");
  setViewport(1440, 900);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function readyRooms() {
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": terminalPanes("room:alpha", 2), "room:beta": terminalPanes("room:beta", 2) }
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Open Beta" });
  const alpha = await waitFor(() => {
    const layer = container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]');
    expect(layer?.dataset.terminalPrefillReady).toBe("true"); return layer!;
  });
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
  await waitFor(() => expect(alpha.dataset.presentationState).toBe("hidden"));
  await waitFor(() => expect(alpha.dataset.warmPrepared).toBe("true"));
  const beta = container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')!;
  await waitFor(() => expect(beta.dataset.terminalPrefillReady).toBe("true"));
  return { container, alpha, beta };
}

it("makes an already attached and fully prefilled resident CLI room interactive without waiting for animation frames", async () => {
  const { alpha, beta } = await readyRooms();
  const screens = [...alpha.querySelectorAll(".xterm-screen")];
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  expect(alpha.dataset.presentationState).toBe("displayed");
  expect(alpha.getAttribute("aria-hidden")).toBe("false");
  expect(alpha.hasAttribute("inert")).toBe(false);
  expect(beta.dataset.presentationState).toBe("hidden");
  expect([...alpha.querySelectorAll(".xterm-screen")]).toEqual(screens);
});

it("keeps resident room layers in place in the DOM when switching rooms", async () => {
  const { container, alpha, beta } = await readyRooms();
  const stack = container.querySelector(".room-runtime-stack")!;
  const layers = [...stack.querySelectorAll(".room-runtime-layer")];
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(stack, { childList: true });
  try {
    for (const [name, layer] of [["Alpha", alpha], ["Beta", beta], ["Alpha", alpha]] as const) {
      fireEvent.click(screen.getByRole("button", { name: `Open ${name}` }));
      await waitFor(() => expect(layer.dataset.presentationState).toBe("displayed"));
    }
    mutations.push(...observer.takeRecords());
    const movedLayers = mutations.flatMap(record => [...record.removedNodes, ...record.addedNodes])
      .filter(node => node instanceof HTMLElement && node.matches(".room-runtime-layer"));
    expect(movedLayers).toHaveLength(0);
    expect([...stack.querySelectorAll(".room-runtime-layer")]).toEqual(layers);
  } finally {
    observer.disconnect();
  }
});

it("uses the resident room layer for hidden-pane accessibility instead of toggling every card", async () => {
  const { container, alpha, beta } = await readyRooms();
  expect(alpha.getAttribute("aria-hidden")).toBe("true");
  expect(alpha.hasAttribute("inert")).toBe(true);
  expect([...alpha.querySelectorAll<HTMLElement>(".pane-card")].every((card) => !card.hasAttribute("aria-hidden"))).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  await waitFor(() => expect(alpha.dataset.presentationState).toBe("displayed"));
  expect(alpha.getAttribute("aria-hidden")).toBe("false");
  expect(beta.getAttribute("aria-hidden")).toBe("true");
  expect([...beta.querySelectorAll<HTMLElement>(".pane-card")].every((card) => !card.hasAttribute("aria-hidden"))).toBe(true);
  expect(container.querySelectorAll(".room-runtime-layer")).toHaveLength(2);
});

it("does not mark a stale uncached displayed room as an empty state", () => {
  const panes = terminalPanes("room:next", 1);
  expect(roomRuntimeLayerHasEmptyState({
    roomId: "room:deleted",
    selectedRoomId: "room:next",
    selectedPanes: panes,
    runtimePanes: undefined,
    category: null
  })).toBe(false);
});

it("flushes resident warm layout before marking the hidden layer prepared", async () => {
  const layoutReads: HTMLElement[] = [];
  const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      const roomId = this.dataset.roomRuntimeId;
      if (roomId) layoutReads.push(this);
      return 0;
    });
  try {
    const { alpha } = await readyRooms();
    expect(alpha.dataset.warmPrepared).toBe("true");
    expect(layoutReads.some((element) => element === alpha)).toBe(true);
  } finally {
    offsetHeight.mockRestore();
  }
});

it("contains style propagation for a prepared hidden room", () => {
  const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
  const preparedRule = css.match(/\.room-runtime-layer\[data-presentation-state=\"hidden\"\]\[data-warm-prepared=\"true\"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  expect(preparedRule).toContain("contain: style;");
  expect(css).toMatch(/\.room-runtime-layer\[data-warm-prepared=\"true\"\]\s*\{[^}]*contain: style;/s);
  expect(css).toContain('.room-runtime-stack[data-has-empty-state="true"]::before');
  expect(css).not.toContain('.room-runtime-stack:has(.empty-state)::before');
});

it.each([
  ["disconnected terminal", ".terminal-pane", "data-terminal-status", "disconnected"],
  ["unfinished PREFILL", ".terminal-pane", "data-terminal-prefill-ready", "false"],
  ["queued output events", ".terminal-xterm", "data-terminal-pending-prefill-events", "1"],
  ["queued output bytes", ".terminal-xterm", "data-terminal-pending-prefill-bytes", "128"],
  ["unfinished geometry", ".terminal-xterm", "data-terminal-initial-geometry", "pending"],
  ["parked socket", ".terminal-xterm", "data-terminal-socket-parked", "true"]
])("retains the existing preparation path for a %s", async (_reason, selector, attribute, value) => {
  const { alpha, beta } = await readyRooms();
  alpha.querySelector(selector)!.setAttribute(attribute, value);
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  expect(alpha.dataset.presentationState).toBe("preparing");
  expect(beta.dataset.presentationState).toBe("held");
  expect(alpha.hasAttribute("inert")).toBe(true);
});

it("retains the outgoing room while a cold CLI room is still loading", async () => {
  const gate = deferred<void>();
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": terminalPanes("room:alpha", 1), "room:beta": terminalPanes("room:beta", 1) },
    paneRequestDeferredByRoom: { "room:beta": gate.promise }
  });
  const { container } = render(<App />);
  try {
    await screen.findByRole("button", { name: "Open Beta" });
    await waitFor(() => expect(container.querySelector('[data-room-runtime-id="room:alpha"] .terminal-pane')).not.toBeNull());
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
    fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:alpha"]')?.dataset.presentationState).toBe("held");
    expect(container.querySelector<HTMLElement>('[data-room-runtime-id="room:beta"]')?.dataset.presentationState).toBe("preparing");
  } finally { gate.resolve(); }
});

it.each([[1200, 780], [1440, 1000]])("prepares a resident room again after the viewport changes to %ix%i while hidden", async (width, height) => {
  const { alpha, beta } = await readyRooms();
  act(() => setViewport(width, height));
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(123);
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  expect(alpha.dataset.presentationState).toBe("preparing");
  expect(beta.dataset.presentationState).toBe("held");
});
