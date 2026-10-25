import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { DockKeepAliveHost } from "../src/features/docks/DockKeepAliveHost.js";
import { DockActiveContext, useIsDockActive } from "../src/features/docks/dock-active-context.js";
import type { SideSurface } from "../src/features/docks/dock-types.js";
import { preloadDockModules } from "../src/features/docks/dock-preloader.js";

function TestDockComponent({ name }: { name: string }) {
  const isActive = useIsDockActive();
  const [count, setCount] = useState(0);

  return (
    <div data-testid={`dock-${name}`}>
      <h3>{name} Dock</h3>
      <span data-testid={`active-state-${name}`}>{isActive ? "active" : "inactive"}</span>
      <span data-testid={`counter-${name}`}>{count}</span>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        Increment {name}
      </button>
    </div>
  );
}

describe("Dock Keep-Alive & Caching Architecture", () => {
  it("keeps previously visited docks mounted and preserves local component state", () => {
    function HostHarness() {
      const [active, setActive] = useState<SideSurface>("clipboard");
      const [open, setOpen] = useState(true);

      return (
        <div>
          <button type="button" onClick={() => setActive("clipboard")}>
            Open Clipboard
          </button>
          <button type="button" onClick={() => setActive("tasks")}>
            Open Tasks
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)}>
            Toggle Open
          </button>

          <DockKeepAliveHost
            activeSurface={active}
            isOpen={open}
            fallback={<div>Loading...</div>}
            renderSurface={(surface) => <TestDockComponent name={surface} />}
          />
        </div>
      );
    }

    render(<HostHarness />);

    // 1. Initial render has clipboard active
    expect(screen.getByTestId("dock-clipboard")).toBeTruthy();
    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("active");
    expect(screen.queryByTestId("dock-tasks")).toBeNull();

    // 2. Increment state in clipboard
    fireEvent.click(screen.getByRole("button", { name: "Increment clipboard" }));
    expect(screen.getByTestId("counter-clipboard").textContent).toBe("1");

    // 3. Switch to tasks dock
    fireEvent.click(screen.getByRole("button", { name: "Open Tasks" }));

    // Both docks are now in DOM: tasks is active, clipboard is hidden in background
    expect(screen.getByTestId("dock-tasks")).toBeTruthy();
    expect(screen.getByTestId("active-state-tasks").textContent).toBe("active");
    expect(screen.getByTestId("dock-clipboard")).toBeTruthy();
    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("inactive");

    const clipboardSlot = screen.getByTestId("dock-clipboard").closest(".dock-cache-slot");
    expect(clipboardSlot?.getAttribute("aria-hidden")).toBe("true");
    expect((clipboardSlot as HTMLElement).style.display).toBe("none");

    const tasksSlot = screen.getByTestId("dock-tasks").closest(".dock-cache-slot");
    expect(tasksSlot?.getAttribute("aria-hidden")).toBe("false");
    expect((tasksSlot as HTMLElement).style.display).toBe("flex");

    // 4. Switch back to clipboard: state is preserved!
    fireEvent.click(screen.getByRole("button", { name: "Open Clipboard" }));

    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("active");
    expect(screen.getByTestId("counter-clipboard").textContent).toBe("1");
    expect((clipboardSlot as HTMLElement).style.display).toBe("flex");
    expect((tasksSlot as HTMLElement).style.display).toBe("none");
  });

  it("sets all dock slots to inactive when dock container is closed", () => {
    function HostHarness() {
      const [open, setOpen] = useState(true);

      return (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            Close Dock
          </button>
          <DockKeepAliveHost
            activeSurface="clipboard"
            isOpen={open}
            fallback={<div>Loading...</div>}
            renderSurface={(surface) => <TestDockComponent name={surface} />}
          />
        </div>
      );
    }

    render(<HostHarness />);

    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("active");

    fireEvent.click(screen.getByRole("button", { name: "Close Dock" }));

    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("inactive");
    const slot = screen.getByTestId("dock-clipboard").closest(".dock-cache-slot");
    expect((slot as HTMLElement).style.display).toBe("none");
  });

  it("handles prewarmSurfaces prop gracefully", () => {
    render(
      <DockKeepAliveHost
        activeSurface="rooms"
        isOpen={true}
        prewarmSurfaces={["clipboard", "tasks"]}
        fallback={<div>Loading...</div>}
        renderSurface={(surface) => <TestDockComponent name={surface} />}
      />
    );

    // rooms is active
    expect(screen.getByTestId("dock-rooms")).toBeTruthy();
    expect(screen.getByTestId("active-state-rooms").textContent).toBe("active");

    // prewarmed docks are also mounted in background
    expect(screen.getByTestId("dock-clipboard")).toBeTruthy();
    expect(screen.getByTestId("active-state-clipboard").textContent).toBe("inactive");
    expect(screen.getByTestId("dock-tasks")).toBeTruthy();
    expect(screen.getByTestId("active-state-tasks").textContent).toBe("inactive");
  });

  it("does not re-render hidden cached docks on host re-renders, and refreshes them when shown", () => {
    const renders = new Map<string, number>();
    function CountingDock({ name, version }: { name: string; version: number }) {
      renders.set(name, (renders.get(name) ?? 0) + 1);
      return <div data-testid={`dock-${name}`}>{name} v{version}</div>;
    }
    function HostHarness() {
      const [active, setActive] = useState<SideSurface>("clipboard");
      const [version, setVersion] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setActive((current) => (current === "clipboard" ? "tasks" : "clipboard"))}>
            Switch
          </button>
          <button type="button" onClick={() => setVersion((value) => value + 1)}>
            Bump
          </button>
          <DockKeepAliveHost
            activeSurface={active}
            isOpen
            fallback={<div>Loading...</div>}
            renderSurface={(surface) => <CountingDock name={surface} version={version} />}
          />
        </div>
      );
    }

    render(<HostHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    const hiddenClipboardRenders = renders.get("clipboard") ?? 0;

    fireEvent.click(screen.getByRole("button", { name: "Bump" }));
    fireEvent.click(screen.getByRole("button", { name: "Bump" }));
    expect(renders.get("clipboard")).toBe(hiddenClipboardRenders);
    expect(screen.getByTestId("dock-tasks").textContent).toBe("tasks v2");

    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    expect(screen.getByTestId("dock-clipboard").textContent).toBe("clipboard v2");
  });

  it("invokes preloadDockModules without crashing", () => {
    expect(() => preloadDockModules()).not.toThrow();
  });
});
