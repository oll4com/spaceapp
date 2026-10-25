import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { executeMemoryActionBridge } from "../src/memory-action-bridge.js";

describe("worker canonical memory actions", () => {
  it("routes selected memory save and search actions through the canonical bridge", async () => {
    const store = new InMemorySpaceStore();
    const saved: unknown[] = [];
    const searched: unknown[] = [];
    const turnInput = dummyTurnInputSchema.parse({
      roomId: "room:worker-memory-canonical",
      paneId: "pane:worker-memory-canonical",
      prompt: "remember this",
      agentSessionId: "agent_session:worker-memory-canonical",
      selectedToolIds: ["memory:search", "memory:save"],
      traceId: "trace:worker-memory-canonical"
    });

    const result = await executeMemoryActionBridge({
      turnInput,
      store,
      canonicalMemory: {
        async list(query) {
          searched.push(query);
          return [
            {
              id: "gemini_memory:worker-memory-match",
              scope: "SYSTEM",
              roomId: null,
              title: "Canonical worker match",
              body: "Canonical memory contains storage.",
              provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
              createdAt: "2026-07-06T00:00:00.000Z"
            }
          ];
        },
        async save(entry) {
          saved.push(entry);
          return {
            id: "gemini_memory:worker-memory-save",
            scope: "SYSTEM",
            roomId: null,
            title: entry.title,
            body: entry.body,
            provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
            createdAt: "2026-07-06T00:00:00.000Z"
          };
        }
      },
      assistantContent: [
        "I will update shared memory.",
        "",
        "```space-memory-actions",
        JSON.stringify({
          version: 1,
          actions: [
            {
              toolId: "memory:save",
              action: {
                type: "save",
                title: "Canonical worker note",
                body: "Shared state marker",
                provenance: "worker-memory-test",
                tags: ["Space-Agent", "μνήμη"]
              }
            },
            { toolId: "memory:search", action: { type: "search", q: "storage", pageSize: 1 } }
          ]
        }),
        "```"
      ].join("\n")
    });

    expect(result.executedActionCount).toBe(2);
    expect(saved).toEqual([
      expect.objectContaining({
        scope: "ROOM",
        roomId: "room:worker-memory-canonical",
        title: "Canonical worker note",
        provenance: "worker-memory-test",
        tags: ["Space-Agent", "μνήμη"]
      })
    ]);
    expect(searched).toEqual([expect.objectContaining({ q: "storage", scope: "ROOM", roomId: "room:worker-memory-canonical" })]);
    expect(result.toolMessageContent).toContain("EXECUTED memory:save");
    expect(result.toolMessageContent).toContain("gemini_memory:worker-memory-match");
    expect(store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" })).toEqual([]);
  });
});
