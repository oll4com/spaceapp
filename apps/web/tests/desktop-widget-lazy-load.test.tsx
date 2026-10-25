import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DesktopWidgetsLayer } from "../src/features/desktop-widgets/DesktopWidgetsLayer.js";
import { loadWidgetStates, useDesktopWidgets } from "../src/features/desktop-widgets/widget-storage.js";

afterEach(() => { cleanup(); localStorage.clear(); });

function Harness({ enabled }: { enabled: boolean }) {
  const controller = useDesktopWidgets();
  const states = loadWidgetStates();
  states.clock = { ...states.clock, enabled, x: 120, y: 140 };
  return <DesktopWidgetsLayer widgetsController={{ ...controller, widgets: states, isWidgetEnabled: (id) => Boolean(states[id]?.enabled) }} />;
}

it("renders nothing for disabled widgets and loads an enabled widget on demand", async () => {
  const view = render(<Harness enabled={false} />);
  expect(view.container.querySelector(".desktop-widgets-layer")).toBeNull();

  view.rerender(<Harness enabled />);
  // The widget module is fetched only once a widget is enabled.
  expect(view.container.querySelector('[data-widget-id="clock"]')).toBeNull();
  expect(await screen.findByLabelText("Clock widget", {}, { timeout: 5_000 })).toBeTruthy();
  expect(view.container.querySelector('[data-widget-id="clock"]')).not.toBeNull();

  // Re-enabling after the first load renders synchronously from the module cache.
  view.rerender(<Harness enabled={false} />);
  expect(view.container.querySelector('[data-widget-id="clock"]')).toBeNull();
  view.rerender(<Harness enabled />);
  expect(view.container.querySelector('[data-widget-id="clock"]')).not.toBeNull();
});
