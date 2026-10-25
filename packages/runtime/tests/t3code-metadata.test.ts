import { expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/store.js";

it("persists T3 selections through ordinary updates and reopening and rejects stale writes", () => {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "T3 binding fixture", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "T3 Code", mode: "T3CODE" });
  const api = store as any;
  expect(typeof api.compareAndSetT3CodeMetadata, "Persistent metadata writer is missing").toBe("function");
  const metadata = { version: 1, revision: 1, generation: "75578f14-5020-4576-bfdf-0cc0831ecda4", lastSequence: 0,
    selection: { environmentId: "env-live", projectId: "project-live", threadId: "thread-live", draftId: null } };
  expect(api.compareAndSetT3CodeMetadata(pane.id, 0, metadata).t3CodeMetadata).toEqual(metadata);
  expect(api.compareAndSetT3CodeMetadata(pane.id, 0, metadata)).toBeNull();
  store.updatePane(pane.id, { title: "Renamed", isClosed: true });
  store.updatePane(pane.id, { isClosed: false });
  expect((store.getPane(pane.id) as any).t3CodeMetadata).toEqual(metadata);
  expect(store.getPane(pane.id).roomId).toBe(room.id);
  expect(store.getPane(pane.id).paneName).toBe(pane.paneName);
  const chat = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT" });
  expect(() => api.compareAndSetT3CodeMetadata(chat.id, 0, metadata)).toThrow();
});
