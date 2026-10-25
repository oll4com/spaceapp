import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppView } from "../src/features/help/useAppView.js";

describe("useAppView", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    document.title = "";
  });

  it("starts from the location and keeps the document title in sync", () => {
    window.history.replaceState({}, "", "/help");
    const { result } = renderHook(() => useAppView({ onLeaveWorkspace: vi.fn() }));
    expect(result.current.appView).toBe("help");
    expect(document.title).toBe("Space Help");
    act(() => result.current.closeHelp());
    expect(window.location.pathname).toBe("/");
    expect(document.title).toBe("Space");
  });

  it("pushes Help and the benchmark onto the history and replaces them on close", () => {
    const { result } = renderHook(() => useAppView({ onLeaveWorkspace: vi.fn() }));
    const length = window.history.length;
    act(() => result.current.openBenchmark());
    expect(window.location.pathname).toBe("/benchmark");
    expect(window.history.length).toBe(length + 1);
    expect(document.title).toBe("Space Benchmark");
    act(() => result.current.closeBenchmark());
    expect(result.current.appView).toBe("workspace");
    act(() => result.current.openHelp());
    expect(result.current.appView).toBe("help");
  });

  it("follows browser navigation and reports leaving the workspace", () => {
    const onLeaveWorkspace = vi.fn();
    const { result } = renderHook(() => useAppView({ onLeaveWorkspace }));
    window.history.pushState({}, "", "/help");
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.appView).toBe("help");
    expect(onLeaveWorkspace).toHaveBeenCalledTimes(1);
    window.history.pushState({}, "", "/");
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.appView).toBe("workspace");
    expect(onLeaveWorkspace).toHaveBeenCalledTimes(1);
  });
});
