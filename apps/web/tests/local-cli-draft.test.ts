import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyLocalCliDraft, localCliDraftKey, readLocalCliDraft, writeLocalCliDraft,
  getLocalCliDraftDurability, registerLocalCliDraftReloadGuard, reloadAfterLocalCliDraftsSaved, noteLocalCliDraftChange
} from "../src/features/terminal-pane/local-cli-draft.js";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("durable local CLI drafts", () => {
  it("restores the final Greek/IME edit without waiting for a timer, scoped to owner and pane", () => {
    const key = localCliDraftKey("user:a", "pane:a");
    const draft = writeLocalCliDraft(localStorage, key, "", { ...emptyLocalCliDraft(), text: "γειά σου\nαύριο 👩‍💻" });
    expect(readLocalCliDraft(localStorage, key)).toEqual(draft);
    expect(readLocalCliDraft(localStorage, localCliDraftKey("user:b", "pane:a")).text).toBe("");
    expect(readLocalCliDraft(localStorage, localCliDraftKey("user:a", "pane:b")).text).toBe("");
  });

  it("rejects stale tab writes without overwriting the newer saved draft", () => {
    const key = localCliDraftKey("user:a", "pane:a");
    const initial = emptyLocalCliDraft();
    writeLocalCliDraft(localStorage, key, "", { ...initial, text: "newer tab" });
    expect(() => writeLocalCliDraft(localStorage, key, "", { ...initial, text: "older tab" })).toThrow("Another tab");
    expect(readLocalCliDraft(localStorage, key).text).toBe("newer tab");
  });

  it("retains a failed revision across unmount without rebasing it over another tab, then releases clean state", async () => {
    const key = localCliDraftKey("user:recovery", "pane:recovery");
    const saved = writeLocalCliDraft(localStorage, key, "", { ...emptyLocalCliDraft(), text: "saved" });
    const state = getLocalCliDraftDurability(key);
    const release = state.retain(() => {});
    const unsaved = { ...saved, text: "unsaved original" };
    state.keepUnsaved(unsaved);
    release();
    writeLocalCliDraft(localStorage, key, saved.revision, { ...saved, text: "another tab's saved edit" });
    const reopened = getLocalCliDraftDurability(key);
    expect(reopened).toBe(state);
    expect(reopened.unsavedDraft).toBe(unsaved);
    expect(() => writeLocalCliDraft(localStorage, key, unsaved.revision, unsaved)).toThrow("Another tab");
    const reload = vi.fn();
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(false);
    expect(readLocalCliDraft(localStorage, key).text).toBe("another tab's saved edit");
    // Once the user has recovered the unsaved copy, no inactive clean state is retained.
    state.keepUnsaved(null);
    const clean = getLocalCliDraftDurability(key);
    expect(clean).not.toBe(state);
    clean.retain(() => {})();
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(true);
  });

  it("keeps the previous saved revision if storage fills", () => {
    const key = localCliDraftKey("user:a", "pane:a");
    const previous = writeLocalCliDraft(localStorage, key, "", { ...emptyLocalCliDraft(), text: "saved" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    expect(() => writeLocalCliDraft(localStorage, key, previous.revision, { ...previous, text: "new" })).toThrow();
    expect(readLocalCliDraft(localStorage, key).text).toBe("saved");
  });

  it("waits for file durability before automatic refresh and refuses refresh on failed saves", async () => {
    const reload = vi.fn();
    let finish!: (value: boolean) => void;
    const unregister = registerLocalCliDraftReloadGuard(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const pending = reloadAfterLocalCliDraftsSaved(reload);
    expect(reload).not.toHaveBeenCalled();
    finish(true);
    await expect(pending).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    unregister();
    const failed = registerLocalCliDraftReloadGuard(() => false);
    await expect(reloadAfterLocalCliDraftsSaved(reload)).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    failed();
  });

  it("preserves an unknown storage version instead of silently replacing it", () => {
    const key = localCliDraftKey("user:a", "pane:a");
    localStorage.setItem(key, '{"version":2,"text":"future saved draft"}');
    expect(() => readLocalCliDraft(localStorage, key)).toThrow("stored copy has been kept");
    expect(localStorage.getItem(key)).toContain("future saved draft");
  });

  it("rechecks a pane changed while another pane was saving before reloading", async () => {
    let ready = true;
    let finish!: (value: boolean) => void;
    const first = registerLocalCliDraftReloadGuard(() => ready);
    const second = registerLocalCliDraftReloadGuard(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const reload = vi.fn();
    const pending = reloadAfterLocalCliDraftsSaved(reload);
    ready = false;
    noteLocalCliDraftChange();
    finish(true);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    finish(true);
    await expect(pending).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    first(); second();
  });
});
