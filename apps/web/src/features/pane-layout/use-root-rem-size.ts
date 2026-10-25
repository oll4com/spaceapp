import { useLayoutEffect, useState } from "react";

/** Observe CSS rem units once for the app, without layout reads during render. */
export function useRootRemSize(): number {
  const [size, setSize] = useState(16);
  useLayoutEffect(() => {
    const accept = (width: number) => {
      if (Number.isFinite(width) && width > 0) setSize(current => current === width ? current : width);
    };
    if (typeof ResizeObserver === "undefined") {
      const measure = () => accept(Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize));
      measure();
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const probe = document.createElement("div");
    probe.dataset.spaceRemProbe = "";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;left:0;top:0;width:1rem;height:0;visibility:hidden;pointer-events:none;overflow:hidden;contain:strict";
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(entry => entry.target === probe);
      if (entry) accept(entry.contentRect.width);
    });
    document.body.appendChild(probe);
    observer.observe(probe);
    return () => { observer.disconnect(); probe.remove(); };
  }, []);
  return size;
}
