import { describe, expect, it, vi } from "vitest";
import { createSpaceControlInspectSections } from "../src/space-control-inspect-sections.js";

const actor = { id: "user:operator" } as never;

function fixture(store: Record<string, unknown> = {}) {
  const controlQuota = vi.fn(async () => ({ quota: "native" }));
  const { inspectControlSection } = createSpaceControlInspectSections({
    store: { getPane: async (id: string) => ({ id, roomId: id === "pane:here" ? "room:one" : "room:other" }), upsertUser: async () => ({ id: "user:operator" }), ...store } as never,
    config: {} as never,
    controlUser: async () => undefined,
    controlQuota: controlQuota as never,
    antigravityUsageProvider: async () => ({ data: [{ id: "agy:one" }] }) as never,
    toolbarUsageProvider: async () => ({ data: [{ id: "codex:one" }] }) as never,
    readCliVpnApplications: vi.fn() as never,
    healthMonitor: { snapshot: vi.fn() } as never,
    taskTitleRepository: { getSettings: async () => ({ enabled: true }) },
    spaceControl: { layout: async () => ({ mode: "GRID" }) }
  });
  const inspect = (input: Record<string, unknown>) => inspectControlSection(actor, { roomId: "room:one", offset: 0, limit: 25, ...input } as never);
  return { inspect, controlQuota };
}

describe("Space Control inspect sections", () => {
  it("reads a pane's native quota only in its own room, else the account totals", async () => {
    const { inspect, controlQuota } = fixture();
    await expect(inspect({ section: "QUOTA", paneId: "pane:elsewhere" })).rejects.toThrow("Pane is outside this room.");
    expect(await inspect({ section: "QUOTA", paneId: "pane:here" })).toEqual({ quota: "native" });
    expect(controlQuota).toHaveBeenCalledOnce();
    expect(await inspect({ section: "QUOTA" })).toMatchObject({ accounts: { data: [{ id: "codex:one" }] }, antigravityAccounts: [{ id: "agy:one" }] });
  });

  it("lists only the section's artifacts, paged by offset and limit", async () => {
    const listArtifacts = vi.fn(async () => [
      { id: "artifact:file", kind: "EXPORT", mimeType: "text/plain", createdAt: "t1", storageUri: "space-artifact://agent-files/a.txt" },
      { id: "artifact:upload", kind: "IMAGE", mimeType: "image/png", createdAt: "t2", storageUri: "space-artifact://user-uploads/b.png" }
    ]);
    const { inspect } = fixture({ listArtifacts });
    expect(await inspect({ section: "FILES", offset: 50 })).toEqual([{ id: "artifact:file", kind: "EXPORT", mimeType: "text/plain", createdAt: "t1" }]);
    expect(listArtifacts).toHaveBeenCalledWith({ roomId: "room:one", page: 3, pageSize: 25, sortOrder: "desc" });
    expect(await inspect({ section: "MEDIA" })).toEqual([{ id: "artifact:upload", kind: "IMAGE", mimeType: "image/png", createdAt: "t2" }]);
  });

  it("summarizes settings without provider keys, survives failing reads, and answers unsupported sections", async () => {
    const { inspect } = fixture({
      listCliRuntimeSettings: async () => { throw new Error("down"); },
      getProviderSettings: async () => ({ defaultProviderId: "openai", providers: [{ id: "openai", name: "OpenAI", enabled: true, hasKey: true, apiKey: "sk-secret", models: [] }] }),
      listAgentToolAssignments: async () => [],
      getRoom: async () => ({ paneLayoutColumns: 3 })
    });
    const settings = await inspect({ section: "SETTINGS" }) as Record<string, unknown>;
    expect(settings).toMatchObject({ cli: [], providers: { defaultProviderId: "openai", providers: [{ id: "openai", name: "OpenAI", enabled: true, configured: true, models: [] }] },
      taskTitles: { enabled: true }, appearance: { layoutColumns: 3, layoutMode: "GRID" } });
    expect(JSON.stringify(settings)).not.toContain("sk-secret");
    expect(await inspect({ section: "STATE" })).toEqual({ supported: false, section: "STATE" });
  });
});
