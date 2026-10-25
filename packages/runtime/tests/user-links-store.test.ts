import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceConflictError, SpaceNotFoundError } from "../src/index.js";

describe("user links store", () => {
  it("seeds defaults once without resurrecting deletions", () => {
    const store = new InMemorySpaceStore();
    const initial = store.listUserLinks("user:one", { page: 1, pageSize: 25 });
    expect(initial.items).toEqual([]);
    const created = store.createUserLink({
      ownerUserId: "user:one",
      title: "Docs",
      description: "Public documentation",
      url: "https://example.com/docs",
      openMode: "EMBEDDED",
      isQuick: true
    });
    store.deleteUserLink("user:one", created.id);
    expect(store.listUserLinks("user:one", { page: 1, pageSize: 25 }).total).toBe(0);
  });

  it("isolates owners and supports CRUD, search, pagination, and quick filtering", () => {
    const store = new InMemorySpaceStore();
    store.listUserLinks("user:one", { page: 1, pageSize: 25 });
    const created = store.createUserLink({ ownerUserId: "user:one", title: "Docs", description: "Useful reference", url: "https://example.com/docs#top", openMode: "EMBEDDED", isQuick: false });
    expect(created.url).toBe("https://example.com/docs");
    expect(store.updateUserLink("user:one", created.id, { title: "Reference", isQuick: true })).toMatchObject({ title: "Reference", isQuick: true, sortOrder: 0 });
    expect(store.listUserLinks("user:one", { q: "useful", isQuick: true, page: 1, pageSize: 1 })).toMatchObject({ total: 1, items: [{ id: created.id }] });
    expect(store.listUserLinks("user:two", { page: 1, pageSize: 25 }).items.some((link) => link.id === created.id)).toBe(false);
    expect(() => store.updateUserLink("user:two", created.id, { title: "Stolen" })).toThrow(SpaceNotFoundError);
    expect(() => store.deleteUserLink("user:two", created.id)).toThrow(SpaceNotFoundError);
  });

  it("rejects canonical URL duplicates and invalid HTTP embedding after partial updates", () => {
    const store = new InMemorySpaceStore();
    store.listUserLinks("user:one", { page: 1, pageSize: 25 });
    const first = store.createUserLink({ ownerUserId: "user:one", title: "One", description: "", url: "https://example.com/path#one", openMode: "EMBEDDED", isQuick: false });
    expect(() => store.createUserLink({ ownerUserId: "user:one", title: "Two", description: "", url: "https://EXAMPLE.com/path#two", openMode: "EMBEDDED", isQuick: false })).toThrow(SpaceConflictError);
    expect(() => store.updateUserLink("user:one", first.id, { url: "http://example.com/path" })).toThrow();
  });
});
