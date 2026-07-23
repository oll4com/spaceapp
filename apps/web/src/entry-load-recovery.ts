export const ENTRY_LOAD_RECOVERY_STORAGE_KEY = "space:entry-load-recovery-attempted";

type EntryLoadRecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type EntryLoadRecoveryOptions = {
  storage?: EntryLoadRecoveryStorage | null;
  rootElement?: HTMLElement | null;
  reload?: () => void;
};

const staleBuildLoadPatterns = [
  "chunkloaderror",
  "error loading dynamically imported module",
  "failed to fetch dynamically imported module",
  "failed to load module script",
  "importing a module script failed",
  "loading chunk",
  "unable to preload css"
];

export function isStaleBuildLoadError(error: unknown): boolean {
  const name = typeof (error as { name?: unknown })?.name === "string" ? (error as { name: string }).name : "";
  const message = typeof (error as { message?: unknown })?.message === "string"
    ? (error as { message: string }).message
    : String(error ?? "");
  const normalized = `${name} ${message}`.toLowerCase();
  return staleBuildLoadPatterns.some((pattern) => normalized.includes(pattern));
}

function getDefaultStorage(): EntryLoadRecoveryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getDefaultRootElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById("root") ?? document.body;
}

function reloadPage() {
  if (typeof window !== "undefined") window.location.reload();
}

function hasRecoveryAttemptBeenUsed(storage: EntryLoadRecoveryStorage | null): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(ENTRY_LOAD_RECOVERY_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

function markRecoveryAttempt(storage: EntryLoadRecoveryStorage | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ENTRY_LOAD_RECOVERY_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export function clearStaleBuildRecoveryGuard(storage: EntryLoadRecoveryStorage | null = getDefaultStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(ENTRY_LOAD_RECOVERY_STORAGE_KEY);
  } catch {
    // Ignore storage failures; recovery must never break a successful mount.
  }
}

function renderReloadFallback(rootElement: HTMLElement | null, reload: () => void) {
  const root = rootElement ?? getDefaultRootElement();
  if (!root) return;

  const panel = document.createElement("section");
  panel.setAttribute("role", "alert");
  panel.setAttribute("aria-label", "Space reload required");
  Object.assign(panel.style, {
    alignItems: "center",
    background: "#070b14",
    color: "#eef4ff",
    display: "grid",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    gap: "1rem",
    justifyItems: "center",
    minHeight: "100vh",
    padding: "2rem",
    textAlign: "center"
  });

  const message = document.createElement("p");
  message.textContent = "Space updated while this tab was open.";
  Object.assign(message.style, {
    fontSize: "1rem",
    margin: "0",
    opacity: "0.82"
  });

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Reload Space";
  Object.assign(button.style, {
    background: "#6ee7f9",
    border: "0",
    borderRadius: "999px",
    color: "#03111f",
    cursor: "pointer",
    font: "inherit",
    fontWeight: "700",
    padding: "0.75rem 1rem"
  });
  button.addEventListener("click", reload);

  panel.append(message, button);
  root.replaceChildren(panel);
}

export function handleStaleBuildLoadError(error: unknown, options: EntryLoadRecoveryOptions = {}): boolean {
  if (!isStaleBuildLoadError(error)) return false;

  const storage = options.storage ?? getDefaultStorage();
  const reload = options.reload ?? reloadPage;
  if (!hasRecoveryAttemptBeenUsed(storage) && markRecoveryAttempt(storage)) {
    reload();
    return true;
  }

  renderReloadFallback(options.rootElement ?? null, reload);
  return true;
}
