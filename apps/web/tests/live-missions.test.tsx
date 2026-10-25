// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { roomAgentMissionSnapshotSchema, type RoomAgentSession } from "@space/contracts";
import { api } from "../src/live-api.js";
import { LiveMissionCard } from "../src/features/live-pane/LiveMissionCard.js";
import { liveMissionBootstrap, readLiveMission, runLiveMissionAction } from "../src/features/live-pane/live-missions.js";
import { buildLiveSessionContext, executeLiveFunction, SPACE_PLAN_MISSION_TOOL } from "../src/features/live-pane/live-session.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const roomId = "room:mission-ui";
function snapshot(status = "RUNNING", objective = "Complete the saved checklist") {
  return roomAgentMissionSnapshotSchema.parse({
    mission: { id: "mission:durable-ui", status, queuedAt: "2026-09-19T00:00:00Z", statusReason: "Waiting for the next verified receipt." },
    objective, source: "LIVE", completionVerified: false, actionCount: 1, actionsTruncated: false,
    actions: [{ actionId: "action:durable-ui", actionType: "CONTROL", status: "RUNNING", statusReason: "Operation is running.",
      paneId: null, attemptCount: 1, controlOperationId: "operation:durable-ui", updatedAt: "2026-09-19T00:00:01Z" }],
    stepCount: 0, stepsTruncated: false, steps: []
  });
}
const session = (value = snapshot()) => ({ roomId, missionSnapshot: value }) as RoomAgentSession;
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); installSpaceRuntime(liveRuntime); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Provider-neutral durable missions", () => {
  it.each(["pause", "resume", "cancel"])("binds %s to the inspected mission on the server as well", async action => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    const control = vi.spyOn(api, "controlRoomAgent").mockResolvedValue(session());
    const stop = vi.spyOn(api, "stopRoomAgent").mockResolvedValue(session());
    await runLiveMissionAction({ roomId, action });
    if (action === "cancel") expect(stop).toHaveBeenCalledWith(roomId, expect.any(String), "mission:durable-ui");
    else expect(control).toHaveBeenCalledWith(roomId, expect.objectContaining({ expectedMissionId: "mission:durable-ui" }));
  });
  it("rejects a control acknowledgement about a different mission", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    const foreign = snapshot();foreign.mission.id = "mission:newer";
    vi.spyOn(api, "controlRoomAgent").mockResolvedValue(session(foreign));
    await expect(runLiveMissionAction({ roomId, action: "pause" })).rejects.toThrow("another mission");
  });
  it("bounds bootstrap waiting and does not interpret a timeout as an empty mission", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "inspectRoomMission").mockImplementation(() => new Promise(() => {}));
    const pending = liveMissionBootstrap(roomId);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toContain("do not assume no mission exists");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not control a replacement mission through stale UI state", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    const control = vi.spyOn(api, "controlRoomAgent");
    await expect(runLiveMissionAction({ roomId, action: "pause", expectedMissionId: "mission:old-ui" })).rejects.toThrow("active mission changed");
    expect(control).not.toHaveBeenCalled();
  });
  it("bootstraps saved mission state on reconnect but respects disabled MCP access", async () => {
    const inspect = vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot("PAUSED") });
    const options = { roomId, model: "gemini-3.8-live", transcripts: [{ id: "turn-1", role: "user" as const, text: "Continue", timestamp: "now" }] };
    const context = await buildLiveSessionContext(options);
    expect(context.combinedPrompt).toContain("Complete the saved checklist");
    expect(context.combinedPrompt).toContain('"status":"PAUSED"');
    expect(context.combinedPrompt).toContain("instead of repeating completed steps");
    const disabled = await buildLiveSessionContext({ ...options, enableMcpTools: false });
    expect(disabled.combinedPrompt).not.toContain("Complete the saved checklist");
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["openai", "google", "vercel"])("uses a stable start request for %s, including a lost acknowledgement", async provider => {
    const start = vi.spyOn(api, "startRoomAgentMission").mockRejectedValueOnce(new Error("Lost reply")).mockResolvedValue(session());
    const input = { roomId, action: "start", goal: " Complete the saved checklist ", provider, callId: "session-1:call-1" };
    await expect(runLiveMissionAction(input)).rejects.toThrow("Lost reply");
    expect((await runLiveMissionAction(input)).snapshot?.mission.status).toBe("RUNNING");
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
    expect(start.mock.calls[0]).toEqual([roomId, "Complete the saved checklist", expect.stringMatching(/^live-mission:[a-f0-9]{64}$/)]);
    await runLiveMissionAction({ ...input, callId: "session-2:call-1" });
    expect(start.mock.calls[2]![2]).not.toBe(start.mock.calls[0]![2]);
  });

  it.each(["next", "skip", "complete"])("never performs browser-side %s transitions", async action => {
    const start = vi.spyOn(api, "startRoomAgentMission");
    await expect(runLiveMissionAction({ roomId, action })).rejects.toThrow("Steps cannot be skipped or completed");
    expect(start).not.toHaveBeenCalled();
    expect(SPACE_PLAN_MISSION_TOOL.parameters.properties.action.enum).not.toContain(action);
  });

  it("requires a real room, goal and stable identifier, and does not advertise unsupported approval mode", async () => {
    const start = vi.spyOn(api, "startRoomAgentMission");
    await expect(runLiveMissionAction({ action: "start", goal: "Goal", callId: "call" })).rejects.toThrow("Select a room");
    await expect(runLiveMissionAction({ roomId, action: "start", goal: "Goal" })).rejects.toThrow("stable request");
    await expect(runLiveMissionAction({ roomId, action: "start", goal: "", callId: "call" })).rejects.toThrow("1–4000");
    await expect(runLiveMissionAction({ roomId, action: "start", goal: "Goal", callId: "call", mode: "step_by_step" })).rejects.toThrow("not available");
    expect(start).not.toHaveBeenCalled();
    expect(SPACE_PLAN_MISSION_TOOL.parameters.properties).not.toHaveProperty("mode");
  });

  it("fails closed for unavailable, malformed or foreign-room state", async () => {
    const inspect = vi.spyOn(api, "inspectRoomMission").mockRejectedValueOnce(new Error("Offline"));
    await expect(readLiveMission(roomId)).rejects.toThrow("Offline");
    inspect.mockResolvedValueOnce({ roomId: "room:foreign", snapshot: snapshot() });
    await expect(readLiveMission(roomId)).rejects.toThrow("another room");
    inspect.mockResolvedValueOnce({ roomId, snapshot: {} as never });
    await expect(readLiveMission(roomId)).rejects.toThrow();
    inspect.mockResolvedValueOnce({ roomId, snapshot: null });
    expect(await readLiveMission(roomId)).toBeNull();
  });

  it("reads actual state for verdict synthesis and does not turn RUNNING into completion", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    vi.spyOn(api, "reportLiveVoiceLog").mockResolvedValue({} as never);
    const onTranscriptUpdate = vi.fn();
    const result = await executeLiveFunction("space_synthesize_verdict", "{}", { roomId, callbacks: { onTranscriptUpdate } });
    expect(JSON.parse(result).snapshot.mission.status).toBe("RUNNING");
    expect(JSON.parse(result).snapshot.completionVerified).toBe(false);
    expect(onTranscriptUpdate.mock.calls.at(-1)![0].text).toBe("Mission state received from server");
  });
  it("does not report a failed MCP receipt as completed", async () => {
    vi.spyOn(api, "executeControlMcp").mockResolvedValue({ result: { structuredContent: { status: "FAILED", error: "pane unavailable" } } } as never);
    vi.spyOn(api, "reportLiveVoiceLog").mockResolvedValue({} as never);
    const onTranscriptUpdate = vi.fn();
    const onStatusChange = vi.fn();
    const result = await executeLiveFunction("space_execute_mcp", JSON.stringify({ actions: [{ kind: "pane", operation: "stop" }] }), { roomId, callbacks: { onTranscriptUpdate, onStatusChange } });
    expect(result).toContain("Error executing Space Control MCP space_execute_mcp");
    expect(onTranscriptUpdate.mock.calls.at(-1)![0].toolCall.status).toBe("error");
    expect(onStatusChange.mock.calls.map(call => call[0])).toEqual(["thinking", "listening"]);
  });
});

describe("Live mission card", () => {
  it("retries an explicit start with the same request identifier and waits for acknowledgement", async () => {
    const inspect = vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: null });
    const start = vi.spyOn(api, "startRoomAgentMission").mockRejectedValueOnce(new Error("Lost start reply"))
      .mockImplementation(async () => {
        const queued = snapshot("QUEUED", "Verify the full checklist");
        inspect.mockResolvedValue({ roomId, snapshot: queued });
        return session(queued);
      });
    render(<LiveMissionCard roomId={roomId} />);
    await screen.findByText("No mission");
    fireEvent.change(screen.getByLabelText("Mission goal"), { target: { value: "Verify the full checklist" } });
    fireEvent.click(screen.getByRole("button", { name: "Start mission" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Lost start reply");
    expect(screen.queryByRole("button", { name: "Stop mission" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start mission" }));
    expect(await screen.findByRole("heading", { name: "Verify the full checklist" })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1]);
  });
  it("shows persisted progress without a voice session and never shows the fixed demo", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    render(<LiveMissionCard roomId={roomId} />);
    expect(await screen.findByText("Complete the saved checklist")).toBeTruthy();
    expect(screen.getByText("Operation: operation:durable-ui")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause mission" })).toBeTruthy();
    expect(screen.queryByText(/9 Βήματα|Skip mission|Complete mission/)).toBeNull();
  });

  it("does not show supervisor completion as verified when receipts are pending", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot("COMPLETED") });
    render(<LiveMissionCard roomId={roomId} />);
    expect(await screen.findByText("NEEDS VERIFICATION")).toBeTruthy();
    expect(screen.getByText("Operation is running.")).toBeTruthy();
  });

  it("waits for the server before displaying pause and keeps server errors visible", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValue({ roomId, snapshot: snapshot() });
    let finish!: (value: RoomAgentSession) => void;
    const pause = vi.spyOn(api, "controlRoomAgent").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<LiveMissionCard roomId={roomId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause mission" }));
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Resume mission" })).toBeNull();
    vi.mocked(api.inspectRoomMission).mockResolvedValue({ roomId, snapshot: snapshot("PAUSED") });
    await act(async () => finish(session(snapshot("PAUSED"))));
    expect(await screen.findByRole("button", { name: "Resume mission" })).toBeTruthy();
    pause.mockRejectedValueOnce(new Error("Control unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Resume mission" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Control unavailable");
    expect(screen.getByRole("button", { name: "Resume mission" })).toBeTruthy();
  });

  it("does not leak old room state through delayed replies and stops polling on unmount", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: Awaited<ReturnType<typeof api.inspectRoomMission>>) => void;
    const inspect = vi.spyOn(api, "inspectRoomMission").mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue({ roomId: "room:new-room", snapshot: snapshot("RUNNING", "New room goal") });
    const ui = render(<LiveMissionCard roomId={roomId} />);
    ui.rerender(<LiveMissionCard roomId="room:new-room" />);
    await act(async () => { await Promise.resolve(); resolveOld({ roomId, snapshot: snapshot("RUNNING", "Old room goal") }); });
    expect(screen.getByText("New room goal")).toBeTruthy();
    expect(screen.queryByText("Old room goal")).toBeNull();
    ui.unmount(); const calls = inspect.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(inspect).toHaveBeenCalledTimes(calls);
  });

  it("marks stale state and blocks controls when the next server read fails", async () => {
    vi.spyOn(api, "inspectRoomMission").mockResolvedValueOnce({ roomId, snapshot: snapshot() }).mockRejectedValue(new Error("Offline"));
    render(<LiveMissionCard roomId={roomId} />);
    expect(await screen.findByRole("button", { name: "Pause mission" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh mission" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Offline Displayed progress may be stale.");
    expect(screen.getByRole("button", { name: "Pause mission" })).toHaveProperty("disabled", true);
  });
});
