import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { installFetchFixture, setViewport, terminalPanes } from "./responsive-shell-fixture.js";

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), disposed: vi.fn() }));
vi.mock("../src/features/terminal-pane/TerminalPane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/features/terminal-pane/TerminalPane.js")>();
  return { ...actual, TerminalPane: ({ pane, onBootstrapped, onPrefillReadyChange }: {
    pane: Pane; onBootstrapped?: (id: string) => void; onPrefillReadyChange?: (id: string, ready: boolean) => void;
  }) => {
    useEffect(() => {
      lifecycle.mounted(pane.id);
      onBootstrapped?.(pane.id);
      onPrefillReadyChange?.(pane.id, true);
      return () => { lifecycle.disposed(pane.id); };
    }, [pane.id]);
    return <section className="terminal-pane" data-terminal-status="attached" data-terminal-prefill-ready="true"
      data-terminal-loading="false" data-terminal-action-pending="false" data-terminal-has-error="false">
      <div className="terminal-xterm" data-terminal-pending-prefill-events="0" data-terminal-pending-prefill-bytes="0">
        <div className="xterm-screen" />
      </div>
    </section>;
  }};
});
vi.mock("../src/features/memory-workspace/MemoryWorkspace.js", () => ({
  MemoryWorkspace: ({ onClose }: { onClose: () => void }) => <section aria-label="Memory workspace">
    <button onClick={onClose}>Close memory workspace</button>
  </section>
}));

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("space.uiTheme.v1", "modern");
  localStorage.setItem("space.warmRoom.enabled.v1", "true");
  localStorage.setItem("space.roomToolbar.hidden.v1", "true");
  window.history.replaceState({}, "", "/");
  setViewport(1440, 900);
  lifecycle.mounted.mockClear(); lifecycle.disposed.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("keeps room terminals mounted and restores the same screens when Memory closes", async () => {
  installFetchFixture({ rooms: [{ id: "room:alpha", name: "Alpha" }],
    panesByRoom: { "room:alpha": terminalPanes("room:alpha", 2) } });
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelectorAll(".xterm-screen")).toHaveLength(2));
  const workspace = container.querySelector<HTMLElement>(".workspace")!;
  const screens = [...workspace.querySelectorAll(".xterm-screen")];
  const mounts = lifecycle.mounted.mock.calls.length;
  for (let cycle = 0; cycle < 2; cycle++) {
    // The direct toolbar and tools rail both run this same action.
    const trigger = screen.queryByRole("button", { name: "Open memory workspace" });
    if (!trigger) fireEvent.click(screen.getByRole("button", { name: "Workspace tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Open memory workspace" }));
    await screen.findByRole("button", { name: "Close memory workspace" });
    expect(workspace.isConnected).toBe(true);
    expect(workspace.hasAttribute("inert")).toBe(true);
    expect(workspace.getAttribute("aria-hidden")).toBe("true");
    expect([...workspace.querySelectorAll(".xterm-screen")]).toEqual(screens);
    expect(lifecycle.disposed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close memory workspace" }));
    expect(workspace.hasAttribute("inert")).toBe(false);
    expect(workspace.getAttribute("aria-hidden")).not.toBe("true");
    expect([...workspace.querySelectorAll(".xterm-screen")]).toEqual(screens);
    expect(lifecycle.mounted).toHaveBeenCalledTimes(mounts);
  }
});
