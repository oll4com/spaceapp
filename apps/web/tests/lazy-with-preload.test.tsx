import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Suspense, useState } from "react";
import { lazyWithPreload, preloadIdleSurfaces } from "../src/lazy-with-preload.js";

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {label} {count}
    </button>
  );
}

describe("lazyWithPreload", () => {
  it("suspends like React.lazy before the chunk is preloaded", async () => {
    let resolveModule: ((module: { default: typeof Counter }) => void) | null = null;
    const Surface = lazyWithPreload(
      () => new Promise<{ default: typeof Counter }>((resolve) => { resolveModule = resolve; })
    );
    render(
      <Suspense fallback={<span>Loading surface</span>}>
        <Surface label="Dock" />
      </Suspense>
    );
    expect(screen.getByText("Loading surface")).toBeTruthy();
    await act(async () => {
      resolveModule?.({ default: Counter });
    });
    expect(await screen.findByRole("button", { name: "Dock 0" })).toBeTruthy();
  });

  it("renders a preloaded surface on its first render without a fallback", async () => {
    const Surface = lazyWithPreload(async () => ({ default: Counter }), { idle: true });
    await preloadIdleSurfaces();
    render(
      <Suspense fallback={<span>Loading surface</span>}>
        <Surface label="Menu" />
      </Suspense>
    );
    expect(screen.queryByText("Loading surface")).toBeNull();
    expect(screen.getByRole("button", { name: "Menu 0" })).toBeTruthy();
  });

  it("keeps a mounted surface's state when its chunk resolves later", async () => {
    let resolveModule: ((module: { default: typeof Counter }) => void) | null = null;
    const Surface = lazyWithPreload(
      () => new Promise<{ default: typeof Counter }>((resolve) => { resolveModule = resolve; })
    );
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((value) => value + 1)}>Rerender {tick}</button>
          <Suspense fallback={<span>Loading surface</span>}>
            <Surface label="Panel" />
          </Suspense>
        </>
      );
    }
    render(<Host />);
    await act(async () => {
      resolveModule?.({ default: Counter });
    });
    const panel = await screen.findByRole("button", { name: "Panel 0" });
    act(() => panel.click());
    expect(screen.getByRole("button", { name: "Panel 1" })).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Rerender 0" }).click());
    // The host re-render must not swap the lazy wrapper for the resolved
    // component (which would remount it and reset the counter).
    expect(screen.getByRole("button", { name: "Panel 1" })).toBeTruthy();
  });

  it("retries the loader after a failed preload", async () => {
    let attempts = 0;
    const Surface = lazyWithPreload(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk failed");
      return { default: Counter };
    });
    await expect(Surface.preload()).rejects.toThrow("chunk failed");
    await Surface.preload();
    expect(attempts).toBe(2);
    render(<Surface label="Retry" />);
    expect(screen.getByRole("button", { name: "Retry 0" })).toBeTruthy();
  });
});
