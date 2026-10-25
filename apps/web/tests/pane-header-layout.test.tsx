import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveSpaceApp as App } from "../src/live/LiveSpaceApp.js";
import { installFetchFixture, reviewPanes, setViewport } from "./responsive-shell-fixture.js";

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("space.uiTheme.v1", "modern");
  window.history.replaceState({}, "", "/");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reuses a measured pane header on warm return, then measures on observed resize", async () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  });
  const reads = new Map<Element, number>();
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".pane-card > header")) reads.set(this, (reads.get(this) ?? 0) + 1);
    return 640;
  });
  setViewport(1440, 900);
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": reviewPanes("room:alpha", 1), "room:beta": reviewPanes("room:beta", 1) }
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Open Beta" });
  const header = await waitFor(() => {
    const header = container.querySelector('[data-space-pane-id="pane:room:alpha:1"] > header');
    expect(header).not.toBeNull(); return header!;
  });
  await waitFor(() => expect(reads.get(header)).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));
  await waitFor(() => expect(header.closest(".room-runtime-layer")?.getAttribute("data-presentation-state")).toBe("hidden"));
  reads.set(header, 0);
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));
  await waitFor(() => expect(header.closest(".room-runtime-layer")?.getAttribute("data-presentation-state")).toBe("displayed"));
  expect(reads.get(header)).toBe(0);
  const observer = observers.find(observer => observer.targets.has(header));
  expect(observer).toBeTruthy();
  observer!.callback([], observer as unknown as ResizeObserver);
  expect(reads.get(header)).toBeGreaterThan(0);
  width.mockRestore();
});

it("waits for the browser resize delivery before measuring a returning pane grid", async () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  });
  const reads = new Map<Element, number>();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.matches(".pane-grid")) reads.set(this, (reads.get(this) ?? 0) + 1);
    return 640;
  });
  setViewport(1440, 900);
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": reviewPanes("room:alpha", 1), "room:beta": reviewPanes("room:beta", 1) }
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Open Beta" });
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));
  reads.clear();
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));
  const grid = container.querySelector('.room-runtime-layer[data-room-runtime-id="room:alpha"] .pane-grid')!;
  expect(reads.get(grid) ?? 0).toBe(0);
  const observer = observers.find(observer => observer.targets.has(grid));
  expect(observer).toBeTruthy();
  observer!.callback([], observer as unknown as ResizeObserver);
  expect(reads.get(grid)).toBeGreaterThan(0);
});


it("uses delivered pane-grid content dimensions and keeps them through zero-size hidden deliveries", async () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  });
  setViewport(1440, 900);
  installFetchFixture({ panes: reviewPanes("room:responsive", 2), paneLayoutColumns: 2 });
  const { container } = render(<App />);
  const grid = await waitFor(() => {
    const grid = container.querySelector<HTMLElement>(".pane-grid");
    expect(grid).not.toBeNull(); return grid!;
  });
  const observer = observers.find(observer => observer.targets.has(grid));
  expect(observer).toBeTruthy();
  const readWidth = vi.fn(() => 1440);
  const readHeight = vi.fn(() => 900);
  Object.defineProperty(grid, "clientWidth", { configurable: true, get: readWidth });
  Object.defineProperty(grid, "clientHeight", { configurable: true, get: readHeight });
  const deliver = (width: number, height: number) => act(() => observer!.callback([
    { target: document.body, contentRect: { width: 1440, height: 900 } },
    { target: grid, contentRect: { width, height } }
  ] as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver));
  deliver(700.2, 500.4);
  expect(grid.getAttribute("data-column-count")).toBe("1");
  deliver(0, 0);
  expect(grid.getAttribute("data-column-count")).toBe("1");
  deliver(900.2, 500.4);
  expect(grid.getAttribute("data-column-count")).toBe("2");
  expect(readWidth).not.toHaveBeenCalled();
  expect(readHeight).not.toHaveBeenCalled();
});


it("reuses unchanged observed header boxes on warm return and remeasures changed controls", async () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  });
  const reads = new Map<Element, number>();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function(this: HTMLElement) {
    if (this.matches(".pane-card > header")) reads.set(this, (reads.get(this) ?? 0) + 1);
    return 640;
  });
  setViewport(1440, 900);
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": reviewPanes("room:alpha", 1), "room:beta": reviewPanes("room:beta", 1) }
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Open Beta" });
  const header = await waitFor(() => {
    const header = container.querySelector('[data-space-pane-id="pane:room:alpha:1"] > header');
    expect(header).not.toBeNull(); return header!;
  });
  const first = observers.find(observer => observer.targets.has(header))!;
  const entries = [...first.targets].map(target => ({ target, contentRect: { width: 640, height: 30 } })) as unknown as ResizeObserverEntry[];
  act(() => first.callback(entries, first as unknown as ResizeObserver));
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
  await waitFor(() => expect(header.closest(".room-runtime-layer")?.getAttribute("data-presentation-state")).toBe("hidden"));
  fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
  await waitFor(() => expect(header.closest(".room-runtime-layer")?.getAttribute("data-presentation-state")).toBe("displayed"));
  const returning = observers.find(observer => observer.targets.has(header))!;
  reads.set(header, 0);
  act(() => returning.callback(entries, returning as unknown as ResizeObserver));
  expect(reads.get(header)).toBe(0);
  const control = entries.find(entry => entry.target !== header)!;
  act(() => returning.callback([{ ...control, contentRect: { width: 680, height: 30 } }] as unknown as ResizeObserverEntry[], returning as unknown as ResizeObserver));
  expect(reads.get(header)).toBeGreaterThan(0);
});

it("computes warm grid columns without root style reads and follows observed rem changes", async () => {
  const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
  vi.stubGlobal("ResizeObserver", class {
    targets = new Set<Element>();
    constructor(public callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
  const computedStyle = window.getComputedStyle.bind(window);
  let rootReads = 0;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element === document.documentElement) rootReads++;
    return computedStyle(element, pseudo);
  });
  setViewport(1440, 900);
  installFetchFixture({
    rooms: [{ id: "room:alpha", name: "Alpha" }, { id: "room:beta", name: "Beta" }],
    panesByRoom: { "room:alpha": reviewPanes("room:alpha", 4), "room:beta": reviewPanes("room:beta", 4) }
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Open Beta" });
  fireEvent.click(screen.getByRole("button", { name: "Open Beta" }));
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:beta"));
  const alphaButton = screen.getByRole("button", { name: "Open Alpha" });
  rootReads = 0;
  fireEvent.click(alphaButton);
  await waitFor(() => expect(container.querySelector(".space-shell")?.getAttribute("data-room-id")).toBe("room:alpha"));
  expect(rootReads).toBe(0);
  const grid = container.querySelector('.room-runtime-layer[data-room-runtime-id="room:alpha"] .pane-grid')!;
  expect(grid.getAttribute("data-column-count")).toBe("4");
  const probe = document.querySelector('[data-space-rem-probe]')!;
  const observer = observers.find(observer => observer.targets.has(probe))!;
  expect(observer).toBeTruthy();
  act(() => observer.callback([{ target: probe, contentRect: { width: 32 } }] as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver));
  expect(grid.getAttribute("data-column-count")).toBe("2");
});
