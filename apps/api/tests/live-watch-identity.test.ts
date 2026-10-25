import { describe, expect, it } from "vitest";
import { controlWatchSchema } from "@space/contracts";
import { liveWatchedTask, liveWatchSubmission } from "../src/live-watch-identity.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";
const task = (taskId: string, status = "COMPLETED") => ({ taskId, status, title: "task", timing: { source: "NATIVE", startedAt: "2026-09-26T12:00:01Z", completedAt: "2026-09-26T12:00:03Z" }, modelsUsed: [] });
const observed = (tasks = [task("old")]) => ({ nativeTaskRef: "thread:reused", tasks }) as unknown as RoomPaneObservation;
const watch = (submission: ReturnType<typeof liveWatchSubmission>) => controlWatchSchema.parse({ id: "watch:one", actorId: "owner", roomId: "room:one", paneId: "pane:one", status: "RUNNING", submission, createdAt: "", updatedAt: "" });
describe("watch native turn binding", () => {
  it("never treats an old completed turn on the same thread as a second prompt's completion", () => {
    const w = watch(liveWatchSubmission(observed(), { nativeTaskRef: "thread:reused" }, "2026-09-26T12:00:00Z"));
    expect(liveWatchedTask(w, observed())).toBeUndefined();
    expect(liveWatchedTask(w, observed([task("old"), task("new")]))?.taskId).toBe("new");
  });
  it("prefers the exact provider turn receipt over thread identity and unrelated completion", () => {
    const w = watch(liveWatchSubmission(observed(), { nativeTaskRef: "thread:reused", turnId: "new" }, "2026-09-26T12:00:00Z"));
    expect(liveWatchedTask(w, observed([task("old"), task("unrelated")]))).toBeUndefined();
    expect(liveWatchedTask(w, observed([task("new")]))?.taskId).toBe("new");
  });
  it("does not infer a new turn from a synthetic idle observation", () => {
    const w = watch(liveWatchSubmission(observed(), {}, "2026-09-26T12:00:00Z"));
    const value = observed([task("new")]); value.tasks[0]!.timing.source = "OBSERVED";
    expect(liveWatchedTask(w, value)).toBeUndefined();
  });
  it("does not guess which of two unbound native turns belongs to the submission", () => {
    const w = watch(liveWatchSubmission(observed(), {}, "2026-09-26T12:00:00Z"));
    expect(liveWatchedTask(w, observed([task("old"), task("first"), task("second")]))).toBeUndefined();
  });
});
