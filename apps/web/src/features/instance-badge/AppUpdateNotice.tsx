import { useEffect, useState } from "react";

const CHECK_MS = 5 * 60_000;
const ENTRY = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** The entry script this tab runs; null under the dev server, which has no hashed entry. */
export function loadedEntry(doc: Document = document): string | null {
  return doc.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute("src")?.match(ENTRY)?.[0] ?? null;
}

/** The entry script the server serves now; null when it cannot be read. */
export async function servedEntry(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher("/", { cache: "no-store", credentials: "same-origin" });
    return response.ok ? (await response.text()).match(ENTRY)?.[0] ?? null : null;
  } catch {
    return null;
  }
}

/**
 * An open tab keeps the build it loaded until it reloads (29/10: Settings showed the old Nous card 40 minutes after the promote),
 * so a tab that comes back into view, and every 5 minutes, compares its build with the served one and offers a reload.
 */
export function AppUpdateNotice({ fetcher }: { fetcher?: typeof fetch }) {
  const [updated, setUpdated] = useState(false);

  useEffect(() => {
    const loaded = loadedEntry();
    if (!loaded) return;
    let cancelled = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void servedEntry(fetcher).then((served) => { if (!cancelled && served && served !== loaded) setUpdated(true); });
    };
    const timer = window.setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [fetcher]);

  if (!updated) return null;
  return (
    <div className="space-app-update" role="status">
      <span>SpaceApp was updated. Reload to use the new version.</span>
      <button type="button" className="space-app-update-reload" onClick={() => window.location.reload()}>Reload</button>
      <button type="button" className="space-app-update-dismiss" aria-label="Dismiss" onClick={() => setUpdated(false)}>×</button>
    </div>
  );
}
