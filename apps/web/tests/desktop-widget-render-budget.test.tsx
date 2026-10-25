import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DesktopWidgetsLayer, preloadDesktopWidgets } from "../src/features/desktop-widgets/DesktopWidgetsLayer.js";
import { useDesktopWidgets, loadWidgetStates, saveWidgetStates } from "../src/features/desktop-widgets/widget-storage.js";

beforeAll(() => preloadDesktopWidgets());
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("does not remeasure or reschedule unchanged widgets on unrelated app renders", () => {
  vi.useFakeTimers();
  const states = loadWidgetStates();
  states.clock = { ...states.clock, enabled: true, x: 100, y: 100 };
  saveWidgetStates(states);
  function App({ tick }: { tick: number }) {
    const controller = useDesktopWidgets();
    return <><output>{tick}</output><DesktopWidgetsLayer widgetsController={controller} isHeaderDockActive={false} /></>;
  }
  const view = render(<App tick={0} />);
  act(() => vi.advanceTimersByTime(250));
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get");
  const frame = vi.spyOn(window, "requestAnimationFrame");
  for (let tick = 1; tick <= 20; tick++) view.rerender(<App tick={tick} />);
  expect(width).not.toHaveBeenCalled();
  expect(frame).not.toHaveBeenCalled();
  view.unmount();
});

it("still shows, moves and closes widgets after controller actions", () => {
  let controller: ReturnType<typeof useDesktopWidgets>;
  function App() {
    controller = useDesktopWidgets();
    return <DesktopWidgetsLayer widgetsController={controller} />;
  }
  const view = render(<App />);
  expect(view.container.querySelector("aside")).toBeNull();
  act(() => controller.toggleWidget("clock", true));
  expect(view.container.querySelector("aside")).not.toBeNull();
  act(() => controller.setPosition("clock", 100, 100, false));
  expect(view.container.querySelector("aside")!.style.transform).toContain("100px, 100px");
  act(() => controller.closeWidget("clock"));
  expect(view.container.querySelector("aside")).toBeNull();
});
