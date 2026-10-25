// Warms the browser cache with the T3 Code client bundle while the Space page
// is idle, so even the first T3 pane opens from cache. Immutable files that
// are already cached resolve locally without a request.
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;
let scheduled = false;

export async function prefetchT3Bundle(fetchFn: typeof fetch = fetch): Promise<number> {
  const response = await fetchFn("/api/t3code/startup-assets", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return 0;
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object") return 0;
  const { basePath, files } = value as { basePath?: unknown; files?: unknown };
  if (basePath !== "/api/t3code/assets/" || !Array.isArray(files)) return 0;
  let warmed = 0;
  for (const file of files.slice(0, 32)) {
    if (typeof file !== "string" || !FILE.test(file)) continue;
    // One at a time and at low priority, behind the page's own requests.
    const ok = await fetchFn(basePath + file, { credentials: "same-origin", priority: "low" } as RequestInit)
      .then(async (asset) => { await asset.arrayBuffer(); return asset.ok; }).catch(() => false);
    if (ok) warmed++;
  }
  return warmed;
}

// Re-checked periodically so a long-lived page also warms a new T3 runtime's
// files; when nothing changed this is one small list request.
const REFRESH_MS = 30 * 60_000;

export function scheduleT3BundlePrefetch(delayMs = 8_000) {
  if (scheduled || typeof window === "undefined" || window.location.pathname.startsWith("/demoappnew")) return;
  scheduled = true;
  const run = () => { void prefetchT3Bundle().catch(() => {}); };
  const whenIdle = () => {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout: 10_000 });
    else run();
  };
  window.setTimeout(whenIdle, delayMs);
  window.setInterval(() => { if (document.visibilityState === "visible") whenIdle(); }, REFRESH_MS);
}
