import { beforeEach, describe, expect, it, vi } from "vitest";

const opencode = vi.hoisted(() => ({ messages: vi.fn(), busy: vi.fn() }));
vi.mock("@space/opencode-control", async (importOriginal) => ({
  ...await importOriginal<object>(),
  fetchOpenCodeSessionMessages: opencode.messages,
  fetchOpenCodeSessionIsTurnActive: opencode.busy
}));
const { roomOpenCodeInspection, roomOpenCodeTasks } = await import("../src/opencode-room-inspection.js");

const control = { nativeSessionId: "ses_abc" } as any;

describe("OpenCode room inspection", () => {
  beforeEach(() => { opencode.messages.mockReset(); opencode.busy.mockReset().mockResolvedValue(false); });

  it("keeps only the user and assistant text in the transcript", async () => {
    opencode.messages.mockResolvedValue([
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: " Fix the login \n" }, { type: "file", text: "x" }] },
      { info: { id: "t1", role: "tool" }, parts: [{ type: "text", text: "tool output" }] },
      { info: { id: "a1", role: "assistant" }, parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "Done." }, { type: "text", text: "  " }] },
      null
    ]);
    const inspection = await roomOpenCodeInspection(control);
    expect(inspection.transcript).toBe("[User]\nFix the login\n\n[Assistant]\nDone.");
    expect(opencode.messages).toHaveBeenCalledWith(control, "ses_abc", 512);
    expect((await roomOpenCodeTasks(control)).length).toBeGreaterThan(0);
  });

  it("refuses when OpenCode cannot list the session's messages", async () => {
    opencode.messages.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(roomOpenCodeInspection(control)).rejects.toThrow("OpenCode task history is unavailable.");
  });
});
