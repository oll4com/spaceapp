import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { api } from "../src/live-api.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const emptyOverview = {
  data: {
    version: 2 as const, layoutVersion: 2 as const, taxonomyVersion: 1 as const, revisionHash: "c".repeat(64), generatedAt: "2026-07-16T08:00:00.000Z", sourceHash: "a".repeat(64), isStale: false,
    summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 }, nodes: [], edges: [], totalMatchingNodes: 0, totalMatchingEdges: 0, truncated: false,
    filters: { q: null, nodeType: null, scope: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "RELATIONS" as const, month: null }, months: []
  }
};
const mount = async () => {
  await act(async () => { render(<MemoryWorkspace shellMode="desktop" activeRoomId="room:test" onClose={() => undefined} initialMode="atlas" />); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" })); });
};

describe("3D view errors in the workspace", () => {
  beforeEach(() => installSpaceRuntime(liveRuntime));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows a failed default overview request over the 3D canvas", async () => {
    vi.spyOn(api, "memoryGraphOverview").mockRejectedValue(new Error("Memory could not be loaded right now."));
    await mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Memory could not be loaded right now.");
    expect(document.querySelector(".memory-3d-surface canvas")).not.toBeNull();
  });

  it("shows the server's 403 for a large size, and requests it with an explicit limit through the worker path", async () => {
    const overview = vi.spyOn(api, "memoryGraphOverview").mockResolvedValue(emptyOverview);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "ADMIN_REQUIRED", message: "Loading more than 2,000 memory nodes requires administrator permissions." } }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load 50,000 nodes" })); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("requires administrator permissions"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("limit=50000");
    expect(overview.mock.calls.every(([query]) => !(query as { limit?: number } | undefined)?.limit)).toBe(true); // the main thread never fetched the large graph
    // choosing the size again (toggling it off) clears the error and returns to the default sample
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load 50,000 nodes" })); });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
