import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DotProfile, DotToolInvocation } from "@space/contracts";
import { DotApprovals } from "../src/features/agent-pane/DotApprovals.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Nova" } as DotProfile;
const pending: DotToolInvocation = { invocationId: "dot_tool:1", dotId: dot.dotId, ownerUserId: "user:1", roomId: "room:1", sessionId: "agent_session:1",
  runId: "agent_run:1", callId: "call-1", toolId: "space.execute", source: "SPACE_CONTROL", risk: "WRITE", status: "APPROVAL_REQUIRED",
  statusReason: "Waiting for the user's approval.", argumentsHash: `sha256:${"a".repeat(64)}`, resultSummary: null,
  approvalSummary: "close Andy, Bob", decidedAt: null, startedAt: "2026-10-10T10:00:00.000Z", completedAt: null };

describe("Dot approvals", () => {
  it("shows exactly what the Dot wants to do and records one decision", async () => {
    const read = vi.fn(async () => ({ dotId: dot.dotId, items: [pending] }));
    const decide = vi.fn(async () => ({}));
    const onDecided = vi.fn();
    render(<DotApprovals dot={dot} sessionId="agent_session:1" pending onDecided={onDecided} read={read} decide={decide} />);
    expect(await screen.findByText("close Andy, Bob")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Nova is waiting for approval" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(dot.dotId, "dot_tool:1", "APPROVE"));
    await waitFor(() => expect(onDecided).toHaveBeenCalled());
    expect(screen.queryByText("close Andy, Bob")).toBeNull();
  });

  it("keeps the request when the decision fails and never renders without a pending request", async () => {
    const read = vi.fn(async () => ({ dotId: dot.dotId, items: [pending] }));
    const decide = vi.fn(async () => { throw Error("offline"); });
    const { rerender } = render(<DotApprovals dot={dot} sessionId="agent_session:1" pending onDecided={vi.fn()} read={read} decide={decide} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    expect(await screen.findByText(/The decision was not recorded/)).toBeTruthy();
    expect(screen.getByText("close Andy, Bob")).toBeTruthy();
    rerender(<DotApprovals dot={dot} sessionId="agent_session:1" pending={false} onDecided={vi.fn()} read={read} decide={decide} />);
    expect(screen.queryByText("close Andy, Bob")).toBeNull();
  });

  it("ignores requests that belong to another Dot or session", async () => {
    const read = vi.fn(async () => ({ dotId: dot.dotId, items: [{ ...pending, sessionId: "agent_session:other" }] }));
    render(<DotApprovals dot={dot} sessionId="agent_session:1" pending onDecided={vi.fn()} read={read} decide={vi.fn()} />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(screen.queryByText("close Andy, Bob")).toBeNull();
  });
});
