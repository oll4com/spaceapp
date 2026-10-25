import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatus } from "@space/contracts";
import { DotChannels } from "../src/features/agent-pane/DotChannels.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);
const status = (overrides: Partial<ChannelsStatus> = {}): ChannelsStatus => ({
  providers: [{ provider: "SLACK", configured: true, reason: null }, { provider: "TEAMS", configured: false, reason: "Teams needs a bot registration on this server." }],
  identities: [], threads: [], ...overrides });

describe("Slack and Teams section", () => {
  it("creates a one-time link code for the configured providers and explains what is missing", async () => {
    const createCode = vi.fn(async () => ({ code: "ABCD-2345", expiresAt: "2026-10-11T08:10:00.000Z" }));
    render(<DotChannels read={async () => status()} createCode={createCode} unlink={vi.fn()} />);
    expect(await screen.findByText("No Slack or Teams account linked.")).toBeTruthy();
    expect(screen.getByText("Teams: not set up on this server yet.")).toBeTruthy();
    expect(screen.getByText("How to set it up").closest("details")?.textContent).toContain("Teams needs a bot registration on this server.");
    fireEvent.click(screen.getByRole("button", { name: "Create link code" }));
    expect(await screen.findByText("link ABCD-2345")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/to the Space app in a direct message in Slack before .* The code works once\./);
  });

  it("lists linked accounts and unlinks only after confirmation", async () => {
    const unlink = vi.fn(async (identityId: string) => ({ identityId, unlinked: true }));
    const identityId = `channel_identity:${"1".repeat(32)}`;
    render(<DotChannels read={async () => status({ identities: [{ identityId, provider: "SLACK", tenantId: "T1", displayName: "Maria", linkedAt: "2026-10-11T08:00:00.000Z" }],
      threads: [{ threadId: `channel_thread:${"2".repeat(32)}`, provider: "SLACK", conversationKind: "DIRECT", dotId: `dot:${"3".repeat(32)}`, replyInThread: true, updatedAt: "2026-10-11T08:00:00.000Z" }] })}
      createCode={vi.fn()} unlink={unlink} />);
    expect(await screen.findByText("Slack · Maria")).toBeTruthy();
    expect(screen.getByText(/1 threads/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(unlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Unlink" })[0]!);
    await waitFor(() => expect(unlink).toHaveBeenCalledWith(identityId));
    expect(await screen.findByText("Unlinked. Space no longer accepts messages from that account.")).toBeTruthy();
  });

  it("shows when Slack and Teams are unavailable", async () => {
    render(<DotChannels read={async () => { throw new Error("down"); }} createCode={vi.fn()} unlink={vi.fn()} />);
    expect(await screen.findByText("Slack and Teams unavailable.")).toBeTruthy();
  });
});
