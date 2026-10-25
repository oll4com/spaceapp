import { createElement, lazy, useState, type ComponentType } from "react";

export type PreloadableComponent<Component extends ComponentType<any>> = Component & {
  preload: () => Promise<void>;
};

const idlePreloads = new Set<() => Promise<void>>();

/**
 * React.lazy suspends on first render even when its chunk is already cached,
 * so a preloaded dock still flashed its fallback (and React may hold the real
 * content back for its fallback throttle). Once preloaded, this renders the
 * resolved component directly; before that it behaves exactly like lazy().
 */
export function lazyWithPreload<Component extends ComponentType<any>>(
  loader: () => Promise<{ default: Component }>,
  options: { idle?: boolean } = {}
): PreloadableComponent<Component> {
  let resolved: Component | null = null;
  let pending: Promise<{ default: Component }> | null = null;
  const load = () => {
    pending ??= loader().then(
      (module) => {
        resolved = module.default;
        return module;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      }
    );
    return pending;
  };
  const LazyComponent = lazy(load);

  function PreloadableSurface(props: object) {
    // Choose the component once per mount: switching from the lazy wrapper to
    // the resolved component later would remount the surface and drop state.
    const [Surface] = useState<ComponentType<any>>(() => resolved ?? LazyComponent);
    return createElement(Surface, props);
  }

  const preload = () => load().then(() => undefined);
  if (options.idle) idlePreloads.add(preload);
  return Object.assign(PreloadableSurface, { preload }) as unknown as PreloadableComponent<Component>;
}

/** Resolves every surface registered with `idle: true`; failures stay lazy. */
export function preloadIdleSurfaces(): Promise<unknown> {
  return Promise.allSettled([...idlePreloads].map((preload) => preload()));
}
