import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPaneSession, DotProfile } from "@space/contracts";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { readAgentPaneDraft, writeAgentPaneDraft } from "../src/features/agent-pane/agent-pane-draft.js";
import { readDotDraft, writeDotDraft } from "../src/features/agent-pane/dot-drafts.js";
import { useDotSession } from "../src/features/agent-pane/useDotSession.js";
import { DotHeader, dotStatus } from "../src/features/agent-pane/DotHeader.js";
import { DotPanels } from "../src/features/agent-pane/DotPanels.js";
import { readChatSubmission, writeChatSubmission } from "../src/features/agent-pane/chat-submission.js";
const dots = ["Orbit", "Nova", "Byte", "Comet", "Luna", "Cosmo"].map((name, i) => ({ dotId: `dot:${String(i + 1).repeat(32)}`,
  ownerUserId: "user:one", slot: i + 1, name, appearance: { character: ["astronaut", "star", "robot", "comet", "moon", "planet"][i], accent: "slate" } } as DotProfile));
const draft = { prompt: "last character!", attachments: [] };
beforeEach(() => { installSpaceRuntime(liveRuntime); sessionStorage.clear(); });
afterEach(cleanup);
describe("Dot isolation and guarded transitions", () => {
  it("migrates legacy drafts once to Orbit only, independently by owner/pane/Dot", () => {
    writeAgentPaneDraft("pane:one", draft);
    expect(readDotDraft("pane:one", dots[1]!)).toEqual({ prompt: "", attachments: [] });
    expect(readDotDraft("pane:one", dots[0]!)).toEqual(draft);
    expect(readAgentPaneDraft("pane:one").prompt).toBe("");
    writeDotDraft("pane:one", dots[1]!, { prompt: "Nova", attachments: [] });
    expect(readDotDraft("pane:one", dots[0]!)).toEqual(draft);
    expect(readDotDraft("pane:two", dots[1]!).prompt).toBe("");
    expect(readDotDraft("pane:one", { ...dots[1]!, ownerUserId: "user:two" }).prompt).toBe("");
    writeAgentPaneDraft("pane:one", { prompt: "new legacy", attachments: [] });
    expect(readDotDraft("pane:one", dots[0]!)).toEqual(draft);
  });
  it("acquires the lock before async work and refuses overlapping switches", async () => {
    const { result } = renderHook(() => useDotSession());
    const save = vi.fn(), publish = vi.fn(); let resolve!: (s: AgentPaneSession) => void;
    const request = new Promise<AgentPaneSession>(r => { resolve = r; });
    const next = { dotId: dots[1]!.dotId } as AgentPaneSession;
    let switching!: Promise<boolean>;
    act(() => { switching = result.current.transition({ blocked: false, snapshot: () => draft, save,
      resolve: () => request, publish, reconcile: async () => next }); });
    expect(save).toHaveBeenCalledWith(draft);
    expect(result.current.lockedRef.current).toBe(true);
    await act(async () => { expect(await result.current.transition({ blocked: false, snapshot: () => draft, save,
      resolve: async () => next, publish, reconcile: async () => next })).toBe(false); });
    await act(async () => { resolve(next); await switching; });
    expect(publish).toHaveBeenCalledOnce(); expect(result.current.lockedRef.current).toBe(false);
  });
  it("reconciles a lost retarget response before unlocking, and stays locked if reconciliation fails", async () => {
    const { result } = renderHook(() => useDotSession()); const publish = vi.fn();
    const options = { blocked: false, snapshot: () => draft, save: vi.fn(), publish,
      resolve: async () => { throw Error("lost acknowledgement"); }, reconcile: async () => { throw Error("unavailable"); } };
    await act(async () => { await result.current.transition(options); });
    expect(result.current.lockedRef.current).toBe(true); expect(publish).not.toHaveBeenCalled();
    const active = { dotId: dots[1]!.dotId } as AgentPaneSession;
    await act(async () => { await result.current.reconcile(async () => active, publish); });
    expect(publish).toHaveBeenCalledWith(active); expect(result.current.lockedRef.current).toBe(false);
  });
  it("ignores obsolete responses after teardown", async () => {
    const { result, unmount } = renderHook(() => useDotSession()); const publish = vi.fn();
    let resolve!: (s: AgentPaneSession) => void; const request = new Promise<AgentPaneSession>(r => { resolve = r; });
    let switching!: Promise<boolean>;
    act(() => { switching = result.current.transition({ blocked: false, snapshot: () => draft, save: vi.fn(),
      resolve: () => request, publish, reconcile: () => request }); });
    unmount(); resolve({ dotId: dots[1]!.dotId } as AgentPaneSession); await switching;
    expect(publish).not.toHaveBeenCalled();
  });
  it("persists the original immutable session/Dot alongside the frozen retry envelope", () => {
    const request = { sessionId: "agent_session:original", dotId: dots[0]!.dotId, clientRequestId: "request:original", content: "Work",
      selectedModelConfigId: "original-model", selectedToolIds: ["original-tool"], attachments: [] };
    writeChatSubmission("pane:one", request); expect(readChatSubmission("pane:one")).toEqual(request);
  });
});
const headerProps = { dots, selected: dots[0]!, status: "Ready", blocked: false, motionActive: true, onSelect: () => {}, onManage: () => {},
  onNewConversation: () => {}, newConversationDisabled: false, onCall: () => {}, callDisabledReason: null, panelOpen: false, onTogglePanel: () => {}, actions: [] };
describe("truthful status and selector accessibility", () => {
  it("requires runtime evidence, never infers approval from permissions or offline from request failure", () => {
    const session = { runtimeState: "AVAILABLE", runStatus: "IDLE", binding: { status: "READY" }, permissionMode: "ask_for_approval" } as AgentPaneSession;
    expect(dotStatus(session)).toBe("Ready");
    expect(dotStatus({ ...session, runtimeState: "UNKNOWN" })).toBe("Status unavailable");
    expect(dotStatus({ ...session, runtimeState: "UNAVAILABLE" })).toBe("Offline");
    expect(dotStatus({ ...session, runStatus: "RUNNING", pendingRequest: { kind: "APPROVAL" } })).toBe("Waiting for approval");
    expect(dotStatus({ ...session, runStatus: "RUNNING" })).toBe("Working");
    expect(dotStatus(null)).toBe("Status unavailable");
  });
  it("offers all six choices with keyboard navigation, Escape dismissal and focus return", async () => {
    const select = vi.fn(); render(<DotHeader {...headerProps} onSelect={select} />);
    const trigger = screen.getByRole("button", { name: "Choose Dot (Orbit)" }); fireEvent.click(trigger);
    const options = screen.getAllByRole("menuitemradio"); expect(options).toHaveLength(6);
    expect(screen.getByRole("menuitem", { name: "Manage Dots in Settings" })).toBeTruthy();
    fireEvent.keyDown(options[0]!, { key: "ArrowRight" }); expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: "ArrowDown" }); expect(document.activeElement).toBe(options[4]);
    fireEvent.keyDown(options[4]!, { key: "Escape" }); expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it("dismisses outside pointer presses without taking focus from the clicked control", () => {
    const select = vi.fn();
    render(<><DotHeader {...headerProps} onSelect={select} />
      <button type="button">Outside control</button></>);
    const trigger = screen.getByRole("button", { name: "Choose Dot (Orbit)" });
    fireEvent.click(trigger);
    const option = screen.getAllByRole("menuitemradio")[1]!;
    fireEvent.pointerDown(option.querySelector("svg")!);
    expect(screen.queryByRole("menu")).not.toBeNull();
    fireEvent.pointerDown(trigger.querySelector("span")!);
    expect(screen.queryByRole("menu")).not.toBeNull();
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("menuitemradio")[1]!);
    expect(select).toHaveBeenCalledWith(dots[1]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("shows failed and empty reads distinctly, and Computer loads the Dot's real computer", async () => {
    const read = vi.fn().mockRejectedValue(Error("request failed"));
    const { rerender } = render(<DotPanels tab="Activity" dot={dots[0]!} session={null} read={read} />);
    expect(await screen.findByText("Activity unavailable.")).toBeTruthy();
    expect(screen.queryByText("No activity yet.")).toBeNull();
    read.mockResolvedValue({ dotId: dots[0]!.dotId, items: [], limit: 50, offset: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No activity yet.");
    rerender(<DotPanels tab="Computer" dot={dots[0]!} session={null} read={read} />);
    expect(screen.getByRole("region", { name: `${dots[0]!.name}'s computer` })).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });
  it("does not apply a delayed collection from another selected Dot", async () => {
    let resolve!: (v: unknown) => void; const read = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
      .mockResolvedValue({ dotId: dots[1]!.dotId, items: [], limit: 50, offset: 0 });
    const { rerender } = render(<DotPanels tab="Memory" dot={dots[0]!} session={null} read={read} />);
    rerender(<DotPanels tab="Memory" dot={dots[1]!} session={null} read={read} />);
    await screen.findByText("No attributed memory yet.");
    await act(async () => { resolve({ dotId: dots[0]!.dotId, items: [{ dotId: dots[0]!.dotId, title: "Old memory" }], limit: 50, offset: 0 }); });
    expect(screen.queryByText("Old memory")).toBeNull(); expect(read).toHaveBeenCalledWith(dots[1]!.dotId, "memory");
  });
});

it("pauses the selected mascot for hidden/minimized presentation and document visibility", () => {
  const { container, rerender } = render(<DotHeader {...headerProps} motionActive={false} />);
  expect(container.querySelectorAll(".dots-selected-mascot")).toHaveLength(1);
  expect(container.querySelector(".dots-selected-mascot")?.getAttribute("data-motion-active")).toBe("false");
  rerender(<DotHeader {...headerProps} motionActive />);
  expect(container.querySelector(".dots-selected-mascot")?.getAttribute("data-motion-active")).toBe("true");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(container.querySelector(".dots-selected-mascot")?.getAttribute("data-motion-active")).toBe("false");
  visibility.mockRestore();
});

it("renders attributed memory fields as read-only text without serializing extra payloads", async () => {
  const read = vi.fn().mockResolvedValue({ dotId: dots[0]!.dotId, items: [{ dotId: dots[0]!.dotId, kind: "ROOM", title: "Recorded preference",
    body: "Use small commits", scope: "ROOM", source: "Explicit operator note", payload: { secret: "must-not-render" } }], limit: 50, offset: 0 });
  render(<DotPanels tab="Memory" dot={dots[0]!} session={null} read={read} />);
  await screen.findByText("Use small commits"); expect(screen.getByText("Source: Explicit operator note")).toBeTruthy();
  expect(screen.queryByText(/must-not-render/)).toBeNull(); expect(screen.queryByRole("button", { name: /edit|delete|save/i })).toBeNull();
});
