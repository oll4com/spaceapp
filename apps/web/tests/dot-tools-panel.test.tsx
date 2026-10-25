import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDotToolCatalog, type DotProfile, type DotToolInvocation } from "@space/contracts";
import { DotPanels } from "../src/features/agent-pane/DotPanels.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const dot = { dotId: `dot:${"1".repeat(32)}`, name: "Orbit" } as DotProfile;
const catalog = buildDotToolCatalog({ role: "USER", browserSessionsEnabled: true, browserPaneIds: [], installedMcpServers: [], mcpTools: [] })
  .map(({ inputSchema: _schema, ...tool }) => tool);
const receipt: DotToolInvocation = { invocationId: "dot_tool:1", dotId: dot.dotId, ownerUserId: "user:1", roomId: "room:1", sessionId: "agent_session:1",
  runId: "agent_run:1", callId: "call-1", toolId: "space.execute", source: "SPACE_CONTROL", risk: "WRITE", status: "COMPLETED", statusReason: null,
  argumentsHash: `sha256:${"a".repeat(64)}`, resultSummary: "Minimized 1 pane", approvalSummary: null, decidedAt: null, startedAt: "2026-10-10T10:00:00.000Z", completedAt: "2026-10-10T10:00:01.000Z" };

describe("Dot Tools view", () => {
  it("shows the real catalog with honest availability, filters it and lists recorded receipts", async () => {
    const readTools = vi.fn(async () => ({ dotId: dot.dotId, tools: catalog }));
    const readReceipts = vi.fn(async () => ({ dotId: dot.dotId, items: [receipt] }));
    render(<DotPanels tab="Tools" dot={dot} session={null} roomId="room:1" readTools={readTools} readReceipts={readReceipts} />);
    await screen.findByText("Recorded receipts");
    expect(readTools).toHaveBeenCalledWith(dot.dotId, "room:1");
    const deploy = screen.getByText("resource.ops.deploy").closest("li")!;
    expect(within(deploy).getByText(/Not allowed/)).toBeTruthy();
    expect(within(deploy).getByText("Tests and deploys are never available to Native agents.")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), { target: { value: "memory" } });
    expect(screen.getByText("memory.search")).toBeTruthy();
    expect(screen.queryByText("resource.ops.deploy")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tools" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(screen.getByRole("button", { name: "Browser" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("browser.navigate")).toBeTruthy();
    expect(screen.queryByText("memory.search")).toBeNull();
    expect(screen.getAllByText("space.execute").length).toBeGreaterThan(0);
    expect(screen.getByText("Minimized 1 pane")).toBeTruthy();
  });

  it("distinguishes a failed read from an empty one and recovers on retry", async () => {
    const readTools = vi.fn().mockRejectedValueOnce(Error("offline")).mockResolvedValue({ dotId: dot.dotId, tools: catalog });
    const readReceipts = vi.fn(async () => ({ dotId: dot.dotId, items: [] }));
    render(<DotPanels tab="Tools" dot={dot} session={null} readTools={readTools} readReceipts={readReceipts} />);
    await screen.findByText("Tools unavailable.");
    expect(screen.queryByText("No invocation receipts yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No invocation receipts yet.");
  });

  it("rejects data that belongs to another Dot", async () => {
    const readTools = vi.fn(async () => ({ dotId: `dot:${"2".repeat(32)}`, tools: catalog }));
    const readReceipts = vi.fn(async () => ({ dotId: dot.dotId, items: [] }));
    render(<DotPanels tab="Tools" dot={dot} session={null} readTools={readTools} readReceipts={readReceipts} />);
    await waitFor(() => expect(screen.getByText("Tools unavailable.")).toBeTruthy());
  });
});
