export type ArcadePalette = Record<"text" | "muted" | "surface" | "accent" | "warning" | "danger" | "border" | "watermark", string>;
const paletteKeys: (keyof ArcadePalette)[] = ["text", "muted", "surface", "accent", "warning", "danger", "border", "watermark"];

/** Resolve inherited app tokens only when its theme changes, never per frame. */
export function observeArcadePalette(element: HTMLElement, update: (palette: ArcadePalette) => void): () => void {
  let disposed = false, queued = false;
  const read = () => {
    queued = false;
    if (disposed) return;
    const probe = document.createElement("span");
    probe.hidden = true;
    element.append(probe);
    try {
      const palette = {} as ArcadePalette;
      for (const key of paletteKeys) {
        probe.style.color = `var(--asteroids-${key})`;
        palette[key] = getComputedStyle(probe).color;
      }
      update(palette);
    } finally { probe.remove(); }
  };
  const queueRead = () => { if (!disposed && !queued) { queued = true; queueMicrotask(read); } };
  const observer = new MutationObserver(queueRead);
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-ui-theme", "data-room-theme", "data-color-mode", "data-interface-theme"] });
  }
  // Theme CSS may finish loading just after the interface attribute changes.
  const stylesheetLoaded = (event: Event) => { if (event.target instanceof HTMLLinkElement && event.target.rel === "stylesheet") queueRead(); };
  document.addEventListener("load", stylesheetLoaded, true);
  read();
  return () => { disposed = true; observer.disconnect(); document.removeEventListener("load", stylesheetLoaded, true); };
}
