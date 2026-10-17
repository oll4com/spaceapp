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
