import { describe, expect, it, vi } from "vitest";
import { InMemoryLiveMemoryRepository } from "@space/db";
import { createLivePersonalMemory } from "../src/live-personal-memory.js";

function fixture() {
  const repository = new InMemoryLiveMemoryRepository();
  return { repository, service: createLivePersonalMemory({ repository }) };
}

describe("Owner-scoped versioned Live personal memory", () => {
  it("keeps two owners' facts isolated, including deletes and change receipts", async () => {
    const { service } = fixture();
    const saved = await service.save("one", { key: "language", value: "el" });
    expect((await service.read("two")).items).toEqual([]);
    await service.delete("two", saved.item.id);
    expect((await service.read("one")).items).toHaveLength(1);
    expect(await service.changes("one")).toHaveLength(1);
  });
  it("preserves concurrent writes from independent service instances", async () => {
    const { repository, service } = fixture();
    const other = createLivePersonalMemory({ repository });
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? service : other).save("owner", { key: `key-${index}`, value: `${index}` })));
    const state = await service.read("owner");
    expect(state.items).toHaveLength(12);
    expect(state.revision).toBe(12);
  });
  it("reads stored items with an unknown category instead of failing the whole memory", async () => {
    const { repository, service } = fixture();
    const item = { key: "agentFiles", value: "Only on request.", createdAt: "", updatedAt: "" };
    await repository.write("owner", 0, { items: [
      { ...item, id: "a", category: "rule" }, { ...item, id: "b", key: "b", category: "custom" }, { ...item, id: "c", key: "c", category: "fact" }
    ] }, { kind: "TEST" });
    expect((await service.read("owner")).items.map(entry => entry.category)).toEqual(["instruction", "note", "fact"]);
    await service.save("owner", { key: "language", value: "el" });
    expect((await service.read("owner")).items).toHaveLength(4);
    await expect(service.save("owner", { key: "x", value: "y", category: "rule" })).rejects.toThrow();
  });
  it("rejects stale explicit revisions without losing the accepted value", async () => {
    const { service } = fixture();
    await service.save("owner", { key: "language", value: "el", expectedRevision: 0 });
    await expect(service.save("owner", { key: "language", value: "en", expectedRevision: 0 })).rejects.toThrow("Reload");
    expect((await service.read("owner")).items[0]?.value).toBe("el");
  });
  it("imports legacy memory only once for its designated owner and never resurrects deletions", async () => {
    const { repository } = fixture();
    const readLegacy = vi.fn(async () => JSON.stringify([{ id: "legacy:1", key: "name", value: "User", category: "core", createdAt: "", updatedAt: "" }]));
    const service = createLivePersonalMemory({ repository, legacyOwnerId: "owner", readLegacy });
    await service.read("other");
    expect(readLegacy).not.toHaveBeenCalled();
    expect((await service.read("owner")).items).toHaveLength(1);
    await service.delete("owner", "legacy:1");
    expect((await createLivePersonalMemory({ repository, legacyOwnerId: "owner", readLegacy }).read("owner")).items).toEqual([]);
    expect(readLegacy).toHaveBeenCalledOnce();
    expect(await service.changes("owner")).toEqual(expect.arrayContaining([expect.objectContaining({ change: expect.objectContaining({ kind: "LEGACY_IMPORT", sourceHash: expect.any(String) }) })]));
  });
  it("reports conflicting same-key values for review without auto-resolving them", async () => {
    const { repository, service } = fixture();
    await repository.write("owner", 0, { items: [
      { id: "a", key: "language", value: "el", category: "preference", createdAt: "", updatedAt: "2026-01-01" },
      { id: "b", key: "Language", value: "en", category: "preference", createdAt: "", updatedAt: "2026-01-02" },
      { id: "c", key: "name", value: "Νίκος", category: "profile", createdAt: "", updatedAt: "2026-01-03" }
    ] }, { kind: "IMPORT" });
    const review = await service.review("owner");
    expect(review).toMatchObject({ revision: 1, conflicts: [{ key: "language", items: [{ id: "a" }, { id: "b" }] }] });
    expect((await service.read("owner")).items).toHaveLength(3);
  });
  it("fails closed on malformed legacy memory without creating an empty replacement", async () => {
    const { repository } = fixture();
    const service = createLivePersonalMemory({ repository, legacyOwnerId: "owner", readLegacy: async () => "invalid" });
    await expect(service.read("owner")).rejects.toThrow();
    expect(await repository.get("owner")).toBeNull();
  });
  it("deduplicates only identical facts and leaves conflicting facts unchanged", async () => {
    const { repository, service } = fixture();
    const common = { key: "language", category: "preference", createdAt: "", updatedAt: "" };
    await repository.write("owner", 0, { items: [
      { ...common, id: "a", value: "el" }, { ...common, id: "b", value: "el" }, { ...common, id: "c", value: "en" }
    ] }, { kind: "IMPORT" });
    const result = await service.maintain("owner", 1);
    expect(result.items.map(item => item.value)).toEqual(["el", "en"]);
    expect(result.removedCount).toBe(1);
  });
  it("never stores deleted personal values in mutation metadata", async () => {
    const { service } = fixture();
    const saved = await service.save("owner", { key: "fact", value: "private-personal-fact" });
    await service.delete("owner", saved.item.id);
    expect(JSON.stringify(await service.changes("owner"))).not.toContain("private-personal-fact");
  });
});
