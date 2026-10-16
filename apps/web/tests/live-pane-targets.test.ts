// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { livePromptPaneReceipts, rememberLivePaneGroup, resolveLivePaneTargets } from "../src/features/live-pane/live-pane-targets.js";
import { createLiveToolReplay } from "../src/features/live-pane/live-tool-replay.js";

const panes = [
  { id: "codex", mode: "TERMINAL", runtimeId: "cli:codex", paneName: "Andy" },
  { id: "chat", mode: "CHAT", paneName: "Bob" },
  { id: "control", mode: "TERMINAL", runtimeId: "cli:gemini", paneName: "Nik" },
  { id: "live", mode: "LIVE" }
];
const scope = { userId: "operator", liveSessionId: "conversation" };
describe("exact Live pane groups", () => {
  it("includes CLI and Chat in an explicit all selection", () => {
    expect(resolveLivePaneTargets("room:a", panes, { all: true }, scope, true)).toEqual(["codex", "chat", "control"]);
  });
  it("resolves targets by paneNames and Greek transliterations", () => {
    expect(resolveLivePaneTargets("room:a", panes, { paneNames: ["Andy", "Bob"] }, scope, true)).toEqual(["codex", "chat"]);
    expect(resolveLivePaneTargets("room:a", panes, { paneNames: ["Άντι", "νικ"] }, scope, true)).toEqual(["codex", "control"]);
    expect(resolveLivePaneTargets("room:a", panes, { paneName: "Bob" }, scope, true)).toEqual(["chat"]);
    expect(resolveLivePaneTargets("room:a", panes, { paneIds: ["codex"], paneNames: ["Andy"] }, scope, true)).toEqual(["codex"]);
  });
  it("rejects unknown pane name or conflicting paneIds and paneNames", () => {
    expect(() => resolveLivePaneTargets("room:a", panes, { paneNames: ["Unknown"] }, scope, true)).toThrow();
    expect(() => resolveLivePaneTargets("room:a", panes, { paneIds: ["chat"], paneNames: ["Andy"] }, scope, true)).toThrow();
  });
  it("preserves only the last opened group across reconnect", () => {
    rememberLivePaneGroup("room:a", ["control"], scope);
    rememberLivePaneGroup("room:a", ["codex", "chat"], scope);
    expect(resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened" }, { ...scope }, true)).toEqual(["codex", "chat"]);
    expect(resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened" }, scope, false)).toEqual(["codex", "chat"]);
  });
  it("lets the named panes win over lastOpened and narrows the group by cliType", () => {
    rememberLivePaneGroup("room:a", ["codex", "control"], scope);
    // 2026-10-16 dialogue: "Finn and Hugo" sent with targetGroup lastOpened was rejected and nothing reached the panes.
    expect(resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened", paneNames: ["Andy", "Bob"] }, scope, true)).toEqual(["codex", "chat"]);
    expect(resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened", paneNames: ["Bob"] }, {}, true)).toEqual(["chat"]);
    expect(resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened", cliType: "gemini" }, scope, true)).toEqual(["control"]);
    expect(() => resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened", cliType: "claude" }, scope, true)).toThrow("CLI type");
  });
  it.each([
    { ...scope, userId: "other" }, { ...scope, liveSessionId: "new" }, {}
  ])("rejects another owner or session: %j", identity => {
    expect(() => resolveLivePaneTargets("room:a", panes, { targetGroup: "lastOpened" }, identity, true)).toThrow();
  });
  it("rejects another room and drops panes of the group closed since it was opened", () => {
    rememberLivePaneGroup("room:a", ["codex", "chat"], scope);
    expect(() => resolveLivePaneTargets("room:b", panes, { targetGroup: "lastOpened" }, scope, true)).toThrow();
    expect(resolveLivePaneTargets("room:a", [panes[0]], { targetGroup: "lastOpened" }, scope, true)).toEqual(["codex"]);
    expect(resolveLivePaneTargets("room:a", [panes[0], { ...panes[1], isClosed: true }], { targetGroup: "lastOpened" }, scope, true)).toEqual(["codex"]);
    expect(() => resolveLivePaneTargets("room:a", [{ ...panes[0], isClosed: true }], { targetGroup: "lastOpened" }, scope, true)).toThrow("closed");
  });
  it.each([{ paneIds: ["codex", "missing"], all: true }, { paneIds: ["codex", "live"] }, { paneIds: [] }, {}, { targetGroup: "lastOpened", all: true }])(
    "never drops invalid IDs or broadens ambiguous selection: %j", args => {
      expect(() => resolveLivePaneTargets("room:a", panes, args, scope, true)).toThrow();
    });
  it("reports each submission without confusing it with task completion", () => {
    expect(livePromptPaneReceipts(["codex", "chat", "control"], { results: [
      { paneId: "codex", status: "COMPLETED", evidence: { result: { turnId: "native:one", watchId: "watch:one" } } },
      { paneId: "chat", status: "FAILED", detail: "Model unavailable" }
    ] })).toEqual([
      expect.objectContaining({ paneId: "codex", submission: "ACCEPTED", nativeTaskRef: "native:one", watchId: "watch:one", taskCompleted: false }),
      expect.objectContaining({ paneId: "chat", submission: "FAILED", detail: "Model unavailable", taskCompleted: false }),
      expect.objectContaining({ paneId: "control", submission: "PENDING", taskCompleted: false })
    ]);
  });
});

describe("provider call replay", () => {
  it("returns the same in-flight and completed result without submitting twice", async () => {
    const replay = createLiveToolReplay();
    const execute = vi.fn(async () => "accepted");
    const first = replay.run("one", "space_send_prompt", '{"prompt":"hello"}', execute);
    const second = replay.run("one", "space_send_prompt", '{"prompt":"hello"}', execute);
    expect(first).toBe(second);
    expect(await first).toBe("accepted");
    expect(await replay.run("one", "space_send_prompt", '{"prompt":"hello"}', execute)).toBe("accepted");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await replay.run("two", "space_send_prompt", '{"prompt":"hello"}', execute)).toBe("accepted");
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("rejects a changed call ID payload and keeps old results at capacity", async () => {
    const replay = createLiveToolReplay(1), execute = vi.fn(async () => "saved");
    await replay.run("one", "space_send_prompt", "{}", execute);
    expect(await replay.run("one", "space_close_panes", "{}", execute)).toContain("LIVE_CALL_ID_CONFLICT");
    expect(await replay.run("two", "space_send_prompt", "{}", execute)).toContain("LIVE_CALL_LIMIT");
    expect(await replay.run("one", "space_send_prompt", "{}", execute)).toBe("saved");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
