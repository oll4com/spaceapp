import { DesktopWidgetsLayer, preloadDesktopWidgets } from "../src/features/desktop-widgets/DesktopWidgetsLayer.js";
import { useDesktopWidgets, loadWidgetStates, resolveRailDockCollisions, resolveHeaderDockCollisions, getRailTopBoundary } from "../src/features/desktop-widgets/widget-storage.js";
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DesktopWidgetContainer } from "../src/features/desktop-widgets/DesktopWidgetContainer.js";

beforeAll(() => preloadDesktopWidgets());
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

function pointer(target: Element | Window, type: string, x: number, y: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
}

it("moves locally and commits one final position for a burst of pointer events", async () => {
  vi.useFakeTimers();
  const commit = vi.fn();
  const view = render(<DesktopWidgetContainer id="clock" title="Clock" icon={null} x={100} y={100}
    onPositionChange={commit} onToggleMinimize={() => {}} onClose={() => {}}>Clock</DesktopWidgetContainer>);
  pointer(view.container.querySelector(".desktop-widget-header")!, "pointerdown", 110, 110);
  for (let i = 1; i <= 50; i++) pointer(window, "pointermove", 110 + i, 110 + i);
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(commit).not.toHaveBeenCalled();
  expect(view.container.querySelector("aside")!.style.transform).toBe("translate3d(150px, 150px, 0)");
  pointer(window, "pointerup", 160, 160);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledWith(150, 150, false, undefined);
});

it("removes a pending drag when the widget closes", () => {
  vi.useFakeTimers();
  const commit = vi.fn();
  const view = render(<DesktopWidgetContainer id="clock" title="Clock" icon={null} x={100} y={100}
    onPositionChange={commit} onToggleMinimize={() => {}} onClose={() => {}}>Clock</DesktopWidgetContainer>);
  pointer(view.container.querySelector(".desktop-widget-header")!, "pointerdown", 110, 110);
  pointer(window, "pointermove", 180, 180);
  view.unmount();
  pointer(window, "pointerup", 180, 180);
  expect(commit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});


it("clears header docking when floating and ignores identical position writes", () => {
  const { result } = renderHook(() => useDesktopWidgets());
  act(() => result.current.setPosition("clock", 100, 100, true, "header"));
  act(() => result.current.setPosition("clock", 200, 200, false));
  expect(result.current.widgets.clock.dockPosition).toBeUndefined();
  const save = vi.spyOn(Storage.prototype, "setItem");
  act(() => result.current.setPosition("clock", 200, 200, false));
  expect(save).not.toHaveBeenCalled();
});

it("keeps a clamped floating widget inside the viewport when avoiding another widget", () => {
  const { result } = renderHook(() => useDesktopWidgets());
  act(() => result.current.toggleWidget("clock", true));
  act(() => result.current.toggleWidget("countdown-timer", true));
  const x = innerWidth - 280 - 12;
  const y = innerHeight - 160 - 12;
  act(() => result.current.setPosition("countdown-timer", x - 10, y - 10, false));
  act(() => result.current.setPosition("clock", x, y, false));
  expect(result.current.widgets.clock.x).toBe(x);
  expect(result.current.widgets.clock.y).toBe(y);
});

it("resolves rail collisions without moving header widgets or mutating prior state", () => {
  const states = loadWidgetStates();
  states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, dockPosition: "rail", x: 0, y: 100 };
  states["ai-quota"] = { ...states["ai-quota"], enabled: true, minimized: true, dockedToRail: true, dockPosition: "header", x: 100, y: 100 };
  const oldClock = states.clock;
  const oldHeader = states["ai-quota"];
  resolveRailDockCollisions(states, "clock");
  expect(states["ai-quota"]).toBe(oldHeader);
  expect(oldClock.x).toBe(0);
  expect(states.clock.x).toBe(innerWidth - 50);
});

it("docks a floating minimized widget into the header toolbar when dragged to top bar", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const commit = vi.fn();
    const view = render(
      <DesktopWidgetContainer
        id="clock"
        title="Clock"
        icon={null}
        x={300}
        y={200}
        minimized={true}
        isHeaderDockActive={true}
        onPositionChange={commit}
        onToggleMinimize={() => {}}
        onClose={() => {}}
      >
        Clock
      </DesktopWidgetContainer>
    );

    const handle = view.container.querySelector(".desktop-widget-header")!;
    pointer(handle, "pointerdown", 310, 210);
    pointer(window, "pointermove", 310, 40);
    pointer(window, "pointerup", 310, 40);

    expect(commit).toHaveBeenCalledWith(expect.any(Number), 8, true, "header");
  } finally {
    toolbarContainer.remove();
  }
});

it("undocks a header docked widget into floating desktop window when pulled down", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const commit = vi.fn();
    render(
      <DesktopWidgetContainer
        id="clock"
        title="Clock"
        icon={null}
        x={100}
        y={8}
        minimized={true}
        dockedToRail={true}
        dockPosition="header"
        isHeaderDockActive={true}
        onPositionChange={commit}
        onToggleMinimize={() => {}}
        onClose={() => {}}
      >
        Clock
      </DesktopWidgetContainer>
    );

    const card = toolbarContainer.querySelector(".desktop-widget-docked-card")!;
    pointer(card, "pointerdown", 120, 20);
    pointer(window, "pointermove", 120, 150);
    pointer(window, "pointerup", 120, 150);

    expect(commit).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), false, undefined);
  } finally {
    toolbarContainer.remove();
  }
});

it("supports touch events for dragging widgets into header toolbar", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const commit = vi.fn();
    const view = render(
      <DesktopWidgetContainer
        id="clock"
        title="Clock"
        icon={null}
        x={400}
        y={200}
        minimized={true}
        isHeaderDockActive={true}
        onPositionChange={commit}
        onToggleMinimize={() => {}}
        onClose={() => {}}
      >
        Clock
      </DesktopWidgetContainer>
    );

    const handle = view.container.querySelector(".desktop-widget-header")!;
    fireEvent(handle, new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 410, clientY: 210 }));
    fireEvent(window, new PointerEvent("pointermove", { bubbles: true, pointerType: "touch", clientX: 410, clientY: 35 }));
    fireEvent(window, new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", clientX: 410, clientY: 35 }));

    expect(commit).toHaveBeenCalledWith(expect.any(Number), 8, true, "header");
  } finally {
    toolbarContainer.remove();
  }
});

it("transfers rail-docked widgets to header toolbar when isHeaderDockActive is true even in single column mode", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const view = render(
      <DesktopWidgetContainer
        id="clock"
        title="Clock"
        icon={null}
        x={1139}
        y={150}
        minimized={true}
        dockedToRail={true}
        dockPosition="rail"
        isMultiColumn={false}
        isHeaderDockActive={true}
        onPositionChange={() => {}}
        onToggleMinimize={() => {}}
        onClose={() => {}}
      >
        Clock
      </DesktopWidgetContainer>
    );

    const headerDocked = toolbarContainer.querySelector("[data-docked-header='true']");
    expect(headerDocked).toBeTruthy();
    expect(view.container.querySelector(".is-rail-docked")).toBeNull();
  } finally {
    toolbarContainer.remove();
  }
});

it("reorders widgets in header toolbar by computing target slot from sibling centers", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const commitClock = vi.fn();
    const commitPushup = vi.fn();

    render(
      <>
        <DesktopWidgetContainer
          id="clock"
          title="Clock"
          icon={null}
          x={100}
          y={8}
          minimized={true}
          dockedToRail={true}
          dockPosition="header"
          isHeaderDockActive={true}
          onPositionChange={commitClock}
          onToggleMinimize={() => {}}
          onClose={() => {}}
        >
          Clock
        </DesktopWidgetContainer>
        <DesktopWidgetContainer
          id="pushup-reminder"
          title="Pushup"
          icon={null}
          x={200}
          y={8}
          minimized={true}
          dockedToRail={true}
          dockPosition="header"
          isHeaderDockActive={true}
          onPositionChange={commitPushup}
          onToggleMinimize={() => {}}
          onClose={() => {}}
        >
          Pushup
        </DesktopWidgetContainer>
      </>
    );

    const cards = toolbarContainer.querySelectorAll(".desktop-widget-docked-card");
    expect(cards.length).toBe(2);

    const clockEl = toolbarContainer.querySelector("[data-widget-id='clock']") as HTMLElement;
    const pushupEl = toolbarContainer.querySelector("[data-widget-id='pushup-reminder']") as HTMLElement;

    vi.spyOn(clockEl, "getBoundingClientRect").mockReturnValue({
      left: 100, right: 180, width: 80, top: 8, bottom: 44, height: 36, x: 100, y: 8, toJSON: () => {}
    });
    vi.spyOn(pushupEl, "getBoundingClientRect").mockReturnValue({
      left: 200, right: 280, width: 80, top: 8, bottom: 44, height: 36, x: 200, y: 8, toJSON: () => {}
    });

    pointer(cards[1]!, "pointerdown", 240, 20);
    pointer(window, "pointermove", 120, 20);
    pointer(window, "pointerup", 120, 20);

    expect(commitPushup).toHaveBeenCalledWith(50, 8, true, "header");
  } finally {
    toolbarContainer.remove();
  }
});

it("computes getRailTopBoundary beyond resource indicators and prevents placing widgets on top of them", () => {
  const healthRail = document.createElement("nav");
  healthRail.className = "health-indicator-rail";
  const btn1 = document.createElement("button");
  btn1.className = "health-indicator";
  vi.spyOn(btn1, "getBoundingClientRect").mockReturnValue({
    left: 1140, right: 1190, width: 50, top: 100, bottom: 340, height: 240, x: 1140, y: 100, toJSON: () => {}
  });
  healthRail.appendChild(btn1);
  document.body.appendChild(healthRail);

  try {
    const boundary = getRailTopBoundary();
    expect(boundary).toBe(348);

    const states = loadWidgetStates();
    states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, dockPosition: "rail", y: 8 };
    resolveRailDockCollisions(states);
    expect(states.clock.y).toBeGreaterThanOrEqual(348);
  } finally {
    healthRail.remove();
  }
});

it("reorders widgets when dragging from left to right in header toolbar", () => {
  const toolbarContainer = document.createElement("div");
  toolbarContainer.id = "toolbar-docked-widgets";
  document.body.appendChild(toolbarContainer);

  try {
    const commitClock = vi.fn();
    const commitPushup = vi.fn();

    render(
      <>
        <DesktopWidgetContainer
          id="clock"
          title="Clock"
          icon={null}
          x={100}
          y={8}
          minimized={true}
          dockedToRail={true}
          dockPosition="header"
          isHeaderDockActive={true}
          onPositionChange={commitClock}
          onToggleMinimize={() => {}}
          onClose={() => {}}
        >
          Clock
        </DesktopWidgetContainer>
        <DesktopWidgetContainer
          id="pushup-reminder"
          title="Pushup"
          icon={null}
          x={200}
          y={8}
          minimized={true}
          dockedToRail={true}
          dockPosition="header"
          isHeaderDockActive={true}
          onPositionChange={commitPushup}
          onToggleMinimize={() => {}}
          onClose={() => {}}
        >
          Pushup
        </DesktopWidgetContainer>
      </>
    );

    const cards = toolbarContainer.querySelectorAll(".desktop-widget-docked-card");
    expect(cards.length).toBe(2);

    const clockEl = toolbarContainer.querySelector("[data-widget-id='clock']") as HTMLElement;
    const pushupEl = toolbarContainer.querySelector("[data-widget-id='pushup-reminder']") as HTMLElement;

    vi.spyOn(clockEl, "getBoundingClientRect").mockReturnValue({
      left: 100, right: 180, width: 80, top: 8, bottom: 44, height: 36, x: 100, y: 8, toJSON: () => {}
    });
    vi.spyOn(pushupEl, "getBoundingClientRect").mockReturnValue({
      left: 200, right: 280, width: 80, top: 8, bottom: 44, height: 36, x: 200, y: 8, toJSON: () => {}
    });

    // Drag Clock (center at 140) to 260 (past Pushup center at 240)
    pointer(cards[0]!, "pointerdown", 140, 20);
    pointer(window, "pointermove", 260, 20);
    pointer(window, "pointerup", 260, 20);

    expect(commitClock).toHaveBeenCalledWith(250, 8, true, "header");

    const states = loadWidgetStates();
    states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, dockPosition: "header", x: 250, y: 8 };
    states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, dockPosition: "header", x: 200, y: 8 };
    resolveHeaderDockCollisions(states);

    expect(states["pushup-reminder"].x).toBe(100);
    expect(states.clock.x).toBe(200);
  } finally {
    toolbarContainer.remove();
  }
});

it("preserves toolbar relative order when docked widgets switch to the right rail", () => {
  const healthRail = document.createElement("nav");
  healthRail.className = "health-indicator-rail";
  const btn1 = document.createElement("button");
  btn1.className = "health-indicator";
  vi.spyOn(btn1, "getBoundingClientRect").mockReturnValue({
    left: 1140, right: 1190, width: 50, top: 100, bottom: 300, height: 200, x: 1140, y: 100, toJSON: () => {}
  });
  healthRail.appendChild(btn1);
  document.body.appendChild(healthRail);

  try {
    const states = loadWidgetStates();
    // Simulate Clock at slot 100, Pushup at slot 200, AI Quota at slot 300 in header
    states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, dockPosition: "rail", x: 100, y: 8 };
    states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, dockPosition: "rail", x: 200, y: 8 };
    states["ai-quota"] = { ...states["ai-quota"], enabled: true, minimized: true, dockedToRail: true, dockPosition: "rail", x: 300, y: 8 };

    resolveRailDockCollisions(states);

    // All must be placed below 308px (300 + DOCK_GAP 8)
    expect(states.clock.y).toBeGreaterThanOrEqual(308);
    // Relative order (clock < pushup < ai-quota) must be strictly preserved
    expect(states.clock.y).toBeLessThan(states["pushup-reminder"].y);
    expect(states["pushup-reminder"].y).toBeLessThan(states["ai-quota"].y);
  } finally {
    healthRail.remove();
  }
});





it("keeps hook order stable when the first widget is enabled, closed and enabled again", () => {
  const states = loadWidgetStates();
  const controller = { widgets: states, isWidgetEnabled: (id: keyof typeof states) => Boolean(states[id].enabled), setPosition: vi.fn(), toggleMinimize: vi.fn(), bringToFront: vi.fn(), closeWidget: vi.fn(), toggleWidget: vi.fn(), enforceRailSlots: vi.fn(), enforceHeaderSlots: vi.fn() };
  const view = render(<DesktopWidgetsLayer widgetsController={controller as ReturnType<typeof useDesktopWidgets>} />);
  expect(view.container.querySelector('[data-widget-id="clock"]')).toBeNull();
  for (const enabled of [true, false, true]) {
    states.clock = { ...states.clock, enabled };
    view.rerender(<DesktopWidgetsLayer widgetsController={{...controller}} />);
    expect(Boolean(view.container.querySelector('[data-widget-id="clock"]'))).toBe(enabled);
  }
});
