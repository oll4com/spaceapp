import type { DeployQueueReport, DeployQueueTicket, ReleasesReport } from "@space/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleasesSettingsCard, type ReleasesClient } from "../src/features/releases/ReleasesSettingsCard.js";

const idleQueue: DeployQueueReport = {
  available: true, daemonRunning: true, heartbeatAt: null, paused: null, current: null, active: [], recent: []
};

function report(overrides: Partial<ReleasesReport> = {}): ReleasesReport {
  return {
    available: true,
    managedHere: true,
    defaultTarget: "dev",
    stable: { commit: "1".repeat(40), url: "http://127.0.0.1:4911" },
    dev: { commit: "2".repeat(40), verifiedCommit: "2".repeat(40), url: "http://127.0.0.1:4911:4940" },
    pending: [
      { commit: "3".repeat(40), ticketId: "q-20261012-100000-aaaa", summary: "Feature A", committedAt: "2026-10-12T10:00:00Z" },
      { commit: "4".repeat(40), ticketId: null, summary: "Feature B", committedAt: "2026-10-12T10:05:00Z" }
    ],
    pendingCount: 2,
    promotion: null,
    hotfixes: [],
    devQueue: idleQueue,
    ...overrides
  };
}

function client(initial: ReleasesReport): ReleasesClient & { promoteRelease: ReturnType<typeof vi.fn>; approveHotfix: ReturnType<typeof vi.fn> } {
  return {
    releases: vi.fn(async () => initial),
    promoteRelease: vi.fn(async () => ({ status: "QUEUED" as const, ticketId: "q-20261012-110000-bbbb", message: "Promotion queued." })),
    approveHotfix: vi.fn(async (ticketId: string) => ({ status: "APPROVED" as const, ticketId, message: "Hotfix approved for stable." }))
  };
}

afterEach(() => cleanup());

// A promotion of an older dev commit than the verified one ("2…").
const promotion: DeployQueueTicket = { id: "q-20261012-120000-cccc", status: "DEPLOYING", branch: "dev", summary: "Promote dev 1111111111 to stable", sha: "1".repeat(40), submittedAt: "", updatedAt: "", note: null, deployedCommit: null, conflictFiles: [], autoResolvedFiles: [], remotes: null };

describe("ReleasesSettingsCard", () => {
  it("lists dev changes and promotes only after confirmation", async () => {
    const fake = client(report());
    render(<ReleasesSettingsCard client={fake} />);
    expect(await screen.findByText("Feature A")).toBeTruthy();
    expect(screen.getByText("On dev, not yet on stable (2)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open dev" }).getAttribute("href")).toBe("http://127.0.0.1:4911:4940");
    fireEvent.click(screen.getByRole("button", { name: "Promote dev to stable" }));
    expect(fake.promoteRelease).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm promotion" }).textContent).toMatch(/Promote 2 changes now\?/);
    fireEvent.click(screen.getByRole("button", { name: "Promote now" }));
    await waitFor(() => expect(fake.promoteRelease).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Promotion queued.")).toBeTruthy();
  });

  it("disables promotion when nothing is waiting, the running promotion ships dev already, or this is the dev instance", async () => {
    for (const [overrides, reason] of [
      [{ pending: [], pendingCount: 0 }, "Stable already runs everything that is on dev."],
      [{ promotion: { ...promotion, sha: "2".repeat(40) } }, "The promotion in progress already ships everything that is on dev."],
      [{ managedHere: false }, "You are on the test copy (dev). Promote from your everyday Space (stable)."]
    ] as const) {
      render(<ReleasesSettingsCard client={client(report(overrides as Partial<ReleasesReport>))} />);
      expect(await screen.findByText(reason)).toBeTruthy();
      expect((screen.getByRole("button", { name: "Promote dev to stable" }) as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
  });

  it("promotes while dev deploys or an older promotion runs (operator 2026-10-21)", async () => {
    const busyDev: DeployQueueReport = { ...idleQueue, current: { batchId: "b-1", phase: "DEPLOYING", ticketIds: [], candidate: "9".repeat(40) } };
    render(<ReleasesSettingsCard client={client(report({ promotion, devQueue: busyDev }))} />);
    expect(await screen.findByText("Promoting")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Promote dev to stable" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("approves a stable hotfix", async () => {
    const fake = client(report({
      hotfixes: [{ id: "q-20261012-130000-dddd", status: "AWAITING_APPROVAL", branch: "space/wt-fix", summary: "Urgent fix", sha: "5".repeat(40), submittedAt: "", updatedAt: "", note: null, deployedCommit: null, conflictFiles: [], autoResolvedFiles: [], remotes: null }]
    }));
    render(<ReleasesSettingsCard client={fake} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fake.approveHotfix).toHaveBeenCalledWith("q-20261012-130000-dddd"));
  });

  it("explains a server without a dev instance", async () => {
    render(<ReleasesSettingsCard client={client(report({ available: false }))} />);
    expect(await screen.findByText(/There is no dev instance on this server/)).toBeTruthy();
  });
});
