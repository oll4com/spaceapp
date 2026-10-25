import { useEffect, useState, type RefObject } from "react";

/**
 * Split: the main surface (browser, mail client) beside the rail. Stacked: one surface at a time
 * with the main surface as a rail tab and the tab strip at the bottom, for phones and narrow panes.
 */
export type CopilotLayout = "split" | "stacked";

/** Panes at most this wide (CSS px) stack; a 390–430px phone always does, a half-screen desktop pane does not. */
export const STACKED_LAYOUT_MAX_WIDTH = 640;

/** Panes up to this wide put the rail under the browser in the split layout; at most SHORT_PANE_MAX_HEIGHT tall they stack instead. */
export const SPLIT_ROWS_MAX_WIDTH = 900;
/** A pane this short (CSS px) under SPLIT_ROWS_MAX_WIDTH left a sliver of browser above a sliver of rail: it stacks. */
export const SHORT_PANE_MAX_HEIGHT = 640;

export function layoutForWidth(width: number, height = Number.POSITIVE_INFINITY): CopilotLayout {
  if (width <= 0) return "split";
  return width <= STACKED_LAYOUT_MAX_WIDTH || (width <= SPLIT_ROWS_MAX_WIDTH && height <= SHORT_PANE_MAX_HEIGHT) ? "stacked" : "split";
}

/** The pane's own size decides the layout (a narrow or short desktop pane stacks like a phone); SSR and jsdom start from the window. */
export function useCopilotLayout(ref: RefObject<HTMLDivElement | null>): CopilotLayout {
  const [layout, setLayout] = useState<CopilotLayout>(() => layoutForWidth(typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const apply = (width: number, height: number) => setLayout((current) => { const next = layoutForWidth(width, height); return next === current ? current : next; });
    const box = element.getBoundingClientRect();
    apply(box.width, box.height);
    const observer = new ResizeObserver((entries) => { for (const entry of entries) apply(entry.contentRect.width, entry.contentRect.height); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}
