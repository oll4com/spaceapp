import { useEffect, useState } from "react";

const DEV_TITLE_PREFIX = "DEV · ";

/** Reads the public /version endpoint, which also answers before sign-in. */
export async function fetchSpaceInstance(fetcher: typeof fetch = fetch): Promise<"stable" | "dev" | null> {
  try {
    const response = await fetcher("/version", { credentials: "same-origin" });
    if (!response.ok) return null;
    const body = (await response.json()) as { instance?: unknown };
    return body.instance === "dev" ? "dev" : body.instance === "stable" ? "stable" : null;
  } catch {
    return null;
  }
}

/**
 * Marks the dev instance on every screen, including sign-in, so it is never
 * mistaken for the stable Space the operator works in. Renders nothing on stable.
 */
export function InstanceBadge({ fetcher }: { fetcher?: typeof fetch }) {
  const [instance, setInstance] = useState<"stable" | "dev" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchSpaceInstance(fetcher).then((next) => {
      if (!cancelled) setInstance(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  useEffect(() => {
    if (instance !== "dev") return;
    const apply = () => {
      if (!document.title.startsWith(DEV_TITLE_PREFIX)) document.title = `${DEV_TITLE_PREFIX}${document.title}`;
    };
    apply();
    const title = document.querySelector("title");
    if (!title) return;
    // The app retitles the tab per view; keep the prefix on every title it sets.
    const observer = new MutationObserver(apply);
    observer.observe(title, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [instance]);

  if (instance !== "dev") return null;
  return (
    <div className="space-instance-badge" role="status" aria-label="Development instance">
      <span className="space-instance-badge-label">DEV</span>
    </div>
  );
}
