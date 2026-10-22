/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLocalCliDraftReloadGuard } from "../src/features/terminal-pane/local-cli-draft.js";
import {
  ENTRY_LOAD_RECOVERY_STORAGE_KEY,
  handleStaleBuildLoadError
} from "../src/entry-load-recovery.js";

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    store
  };
}

describe("Space entry load recovery", () => {
  const unregisterGuards: Array<() => void> = [];
  beforeEach(() => {
    document.body.innerHTML = '<main id="root"></main>';
  });
  afterEach(() => { unregisterGuards.splice(0).forEach(unregister => unregister()); });

  it("reloads once for stale dynamic import failures", async () => {
    const storage = createStorage();
    const reload = vi.fn();
    const root = document.getElementById("root");

    const handled = handleStaleBuildLoadError(
      new TypeError("Failed to fetch dynamically imported module: /assets/LiveSpaceApp-old.js"),
      { storage, rootElement: root, reload }
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storage.store.get(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe("1");
    expect(root?.textContent).toBe("");
  });

  it("renders a manual reload fallback instead of looping after the retry was used", async () => {
    const storage = createStorage({ [ENTRY_LOAD_RECOVERY_STORAGE_KEY]: "1" });
    const reload = vi.fn();
    const root = document.getElementById("root");

    const handled = handleStaleBuildLoadError(
      Object.assign(new Error("Loading chunk LiveSpaceApp failed"), { name: "ChunkLoadError" }),
      { storage, rootElement: root, reload }
    );

    expect(handled).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    const button = root?.querySelector("button");
    expect(button?.textContent).toBe("Reload Space");

    button?.click();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("waits for pending attachment storage before consuming the stale-build retry", async () => {
    let finishSave!: (ready: boolean) => void;
    const saved = new Promise<boolean>(resolve => { finishSave = resolve; });
    unregisterGuards.push(registerLocalCliDraftReloadGuard(() => saved));
    const storage = createStorage();
    const reload = vi.fn();

    expect(handleStaleBuildLoadError(new Error("Loading chunk editor failed"), { storage, reload })).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.store.has(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe(false);

    finishSave(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storage.store.get(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe("1");
  });

  it("keeps the one automatic recovery attempt available when a draft is unsaved", async () => {
    let ready = false;
    const guard = vi.fn(() => ready);
    unregisterGuards.push(registerLocalCliDraftReloadGuard(guard));
    const storage = createStorage();
    const reload = vi.fn();
    const failure = new Error("Loading chunk editor failed");

    handleStaleBuildLoadError(failure, { storage, reload });
    await vi.waitFor(() => expect(guard).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
    expect(storage.store.has(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe(false);

    ready = true;
    handleStaleBuildLoadError(failure, { storage, reload });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(storage.store.get(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe("1");
  });

  it("also protects the manual recovery button while a draft cannot be saved", async () => {
    let ready = false;
    const guard = vi.fn(() => ready);
    unregisterGuards.push(registerLocalCliDraftReloadGuard(guard));
    const storage = createStorage({ [ENTRY_LOAD_RECOVERY_STORAGE_KEY]: "1" });
    const reload = vi.fn();
    handleStaleBuildLoadError(new Error("Loading chunk editor failed"), { storage, reload });
    const button = document.querySelector<HTMLButtonElement>("#root button")!;

    button.click();
    await vi.waitFor(() => expect(guard).toHaveBeenCalled());
    expect(reload).not.toHaveBeenCalled();
    ready = true;
    button.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });
});
