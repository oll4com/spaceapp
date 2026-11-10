import type { ReleasesReport } from "@space/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceApiError, type ServerOpsStatus } from "../src/api.js";
import { NousServerOperations, type ServerOpsClient } from "../src/features/nous/NousServerOperations.js";
import { announceUiLanguage } from "../src/features/ui-language/ui-language.js";

const unit = { state: "idle" as const, result: "success" as const, startedAt: null, finishedAt: null };
const status = (patch: Partial<ServerOpsStatus> = {}): ServerOpsStatus => ({
  managedHere: true, queueActive: false, cleanDisk: unit, deployRemotes: { ...unit, lines: ["✓ github main"] },
  services: [{ id: "browser-host", state: "running" }, { id: "pane-hosts", state: "running" }], ...patch
});
const client = (current: ServerOpsStatus) => ({
  serverOps: vi.fn(async () => current),
  runServerOp: vi.fn(async () => ({ message: "browser-host restarted and ready." })),
  releases: vi.fn(async () => ({ pendingCount: 2, promotion: { id: "q-1", status: "DEPLOYED" } }) as unknown as ReleasesReport),
  promoteRelease: vi.fn(async () => ({ status: "QUEUED" as const, ticketId: "q-2", message: "Promotion queued." }))
}) satisfies ServerOpsClient;

afterEach(() => cleanup());

describe("Nous Settings → Operations (nous_msg:5249d11d)", () => {
  it("runs an operation only after its confirm and shows the answer", async () => {
    const fake = client(status());
    render(<NousServerOperations client={fake} />);
    expect(await screen.findByText(/Last promotion q-1 · DEPLOYED/)).toBeTruthy();
    expect(screen.getByText(/✓ github main/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Service to restart"), { target: { value: "pane-hosts" } });
    fireEvent.click(screen.getByRole("button", { name: "Restart a service" }));
    expect(fake.runServerOp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: Restart a service" }));
    await waitFor(() => expect(fake.runServerOp).toHaveBeenCalledWith("restart", "pane-hosts"));
    expect((await screen.findByRole("status")).textContent).toBe("browser-host restarted and ready.");
    fireEvent.click(screen.getByRole("button", { name: "Promote dev to stable" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: Promote dev to stable" }));
    await waitFor(() => expect(fake.promoteRelease).toHaveBeenCalledOnce());
  });

  it("follows the Interface language: English on en, Greek on el, the API's answer too", async () => {
    announceUiLanguage("en");
    const fake = { ...client(status()), runServerOp: vi.fn(async () => ({ message: "Removed 3 worktrees, kept 1." })) };
    render(<NousServerOperations client={fake} />);
    expect(await screen.findByText("Each one asks you to confirm first and is recorded in the audit log.")).toBeTruthy();
    for (const label of ["Promote dev to stable", "Push to GitHub and Gitea", "Clean disk", "Clean worktrees", "Restart a service"]) {
      expect(screen.getByRole("button", { name: label }).textContent).toBe(label === "Restart a service" ? "Restart" : "Run");
    }
    expect(screen.getByText("Browser Host: running · Pane hosts (CLI panes): running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clean worktrees" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: Clean worktrees" }));
    expect(await screen.findByText("Removed 3 worktrees, kept 1.")).toBeTruthy();
    try {
      act(() => announceUiLanguage("el"));
      expect(screen.getByText("Αφαιρέθηκαν 3 worktrees, έμειναν 1.")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Καθαρισμός δίσκου" }).textContent).toBe("Εκτέλεση");
    } finally { act(() => announceUiLanguage("en")); }
  });

  it("is gone where the API has no route, and disabled off stable", async () => {
    const hidden = { ...client(status()), serverOps: vi.fn(async () => { throw new SpaceApiError("NOT_FOUND", { status: 404 }); }) };
    const { container } = render(<NousServerOperations client={hidden} />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    cleanup();
    render(<NousServerOperations client={client(status({ managedHere: false }))} />);
    expect(await screen.findByText("Operations run only on the stable instance.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Clean disk" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
