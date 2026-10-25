import { beforeEach, describe, expect, it, vi } from "vitest";
import { readChatSubmission, submissionWasRejected, writeChatSubmission } from "../src/features/agent-pane/chat-submission.js";
import { installSpaceRuntime, SpaceApiError } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

beforeEach(() => { installSpaceRuntime(liveRuntime); sessionStorage.clear(); });
const request = { clientRequestId: "request:valid", content: "Preserve me", selectedModelConfigId: null, selectedToolIds: [], attachments: [] };
describe("Chat recovery persistence", () => {
  it("freezes result checks with the exact pending submission", () => {
    const checked = { ...request, acceptance: { version: 1 as const, checks: [{ id: "answer", kind: "TEXT_EQUALS" as const,
      expected: "Εντάξει", normalization: "TRIM" as const, critical: true }] } };
    expect(writeChatSubmission("pane:one", checked)).toBe(true);
    expect(readChatSubmission("pane:one")).toEqual(checked);
    sessionStorage.setItem("space.chatSubmission.v1:pane:one", JSON.stringify({ ...checked,
      acceptance: { version: 1, checks: [{ id: "answer", kind: "EXECUTE", script: "return true" }] } }));
    expect(readChatSubmission("pane:one")).toBeNull();
  });
  it("preserves the request by pane and rejects corrupt stored payloads", () => {
    expect(writeChatSubmission("pane:one", request)).toBe(true);
    expect(readChatSubmission("pane:one")).toEqual(request);
    expect(readChatSubmission("pane:other")).toBeNull();
    sessionStorage.setItem("space.chatSubmission.v1:pane:one", JSON.stringify({ ...request, clientRequestId: "short" }));
    expect(readChatSubmission("pane:one")).toBeNull();
  });
  it("reports storage failure so sending can stop before dispatch", () => {
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw Error("quota"); });
    expect(writeChatSubmission("pane:one", request)).toBe(false);
    failure.mockRestore();
  });
  it("keeps uncertain server, timeout and transport outcomes recoverable", () => {
    for (const error of [Error("network"), new SpaceApiError("timeout", { status: 408 }), new SpaceApiError("unavailable", { status: 503 })]) {
      expect(submissionWasRejected(error)).toBe(false);
    }
    expect(submissionWasRejected(new SpaceApiError("invalid", { status: 409 }))).toBe(true);
  });
});
