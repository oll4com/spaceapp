/**
 * A requestAnimationFrame loop that stops while the window is hidden or unfocused (main.tsx marks <html data-window-idle>, where CSS
 * animations pause too) and starts again when it comes back (desktop lag brief 11/11: canvases drew 60 frames a second in the background).
 * Between ticks it sleeps intervalMs on a timer instead of asking for every frame (desktop perf 12/11: the Nous canvases woke the
 * renderer 60 times a second to draw 30).
 */
export function frameLoop(tick: (now: number) => void, intervalMs = 33): () => void {
  const root = document.documentElement;
  let frame = 0, timer = 0;
  const idle = () => root.hasAttribute("data-window-idle");
  const resume = () => { window.clearTimeout(timer); timer = 0; if (!frame && !idle()) frame = window.requestAnimationFrame(run); };
  const run = (now: number) => { frame = 0; tick(now); if (!idle()) timer = window.setTimeout(resume, intervalMs); };
  const observer = new MutationObserver(resume);
  observer.observe(root, { attributes: true, attributeFilter: ["data-window-idle"] });
  resume();
  return () => { observer.disconnect(); window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
}
