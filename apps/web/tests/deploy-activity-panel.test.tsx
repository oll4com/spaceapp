// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeployQueueReport, DeployQueueTicket } from "@space/contracts";
import { DeployActivityPanel } from "../src/features/deploy-queue/DeployActivityPanel.js";
import { elapsed } from "../src/features/deploy-queue/deploy-queue-format.js";

afterEach(cleanup);

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
const ticket = (overrides: Partial<DeployQueueTicket>): DeployQueueTicket => ({
  id: "q-1", status: "QUEUED", branch: "space/wt-a", summary: "Change", sha: "a".repeat(40),
  submittedAt: ago(90), updatedAt: ago(90), statusSince: ago(90), note: null, deployedCommit: null,
  conflictFiles: [], autoResolvedFiles: [], remotes: null, submitter: null, ...overrides
});
const report = (overrides: Partial<DeployQueueReport> = {}): DeployQueueReport => ({
  available: true, daemonRunning: true, heartbeatAt: ago(2), paused: null, current: null, next: null, active: [], recent: [], ...overrides
});

describe("Deploy activity panel", () => {
  it("lists the waiting changes in order with who submitted them and how long they wait", async () => {
    const deployQueue = vi.fn().mockResolvedValue(report({
      next: { batchId: "b-2", phase: "READY", ticketIds: ["q-2"] },
      active: [
        ticket({ id: "q-2", status: "VERIFYING", summary: "Prepared change", submitter: { runtimeId: "cli:codex", cliSessionId: null, paneId: "pane:b", roomId: null, paneTitle: "Refactor", roomName: null } }),
        ticket({ id: "q-3", summary: "Waiting change", submittedAt: ago(61), submitter: { runtimeId: "cli:opencode", cliSessionId: null, paneId: "pane:c", roomId: null, paneTitle: null, roomName: null } })
      ]
    }));
    render(<DeployActivityPanel client={{ deployQueue }} />);
    const panel = await screen.findByRole("region", { name: "Deploys" });
    expect(await within(panel).findByText("Waiting")).toBeTruthy();
    expect(within(panel).getByText("No deploy is running.")).toBeTruthy();
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map(row => within(row).getByLabelText(/^Position/).textContent)).toEqual(["1", "2"]);
    expect(within(rows[0]!).getByText("Refactor")).toBeTruthy();
    expect(within(rows[0]!).getByText("Next")).toBeTruthy();
    // A closed pane still shows which CLI submitted the change.
    expect(within(rows[1]!).getByText("OpenCode CLI")).toBeTruthy();
    expect(within(rows[1]!).getByText(/^waiting 1m 0\ds$/)).toBeTruthy();
  });

  it("folds and states a paused queue and a load failure plainly", async () => {
    render(<DeployActivityPanel client={{ deployQueue: vi.fn().mockResolvedValue(report({ paused: { reason: "Operator maintenance.", at: ago(10) } })) }} />);
    expect(await screen.findByText("Paused: Operator maintenance.")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /^Deploys/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Paused: Operator maintenance.")).toBeNull();
    cleanup();
    render(<DeployActivityPanel client={{ deployQueue: vi.fn().mockRejectedValue(new Error("The deploy queue requires ADMIN.")) }} />);
    expect((await screen.findByRole("alert")).textContent).toBe("The deploy queue requires ADMIN.");
  });

  it("does not ask the queue while its dock is hidden", async () => {
    const deployQueue = vi.fn().mockResolvedValue(report());
    render(<DeployActivityPanel client={{ deployQueue }} active={false} />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(deployQueue).not.toHaveBeenCalled();
  });

  it("formats elapsed time compactly", () => {
    const now = Date.parse("2026-10-12T10:00:00.000Z");
    expect(elapsed("2026-10-12T09:59:15.000Z", now)).toBe("45s");
    expect(elapsed("2026-10-12T09:53:48.000Z", now)).toBe("6m 12s");
    expect(elapsed("2026-10-12T08:57:00.000Z", now)).toBe("1h 03m");
    expect(elapsed(null, now)).toBeNull();
  });
});
