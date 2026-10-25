import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CliSessionCleanupPreviewResponse,
  CliSessionCleanupResponse,
  CodexHistoryPurgePreviewResponse,
  CodexHistoryPurgeResponse,
  CodexLbSpeedDefaultsResponse
} from "@space/contracts";
import {
  AdminCodexToolsDialog,
  type AdminCodexToolsClient
} from "../src/features/admin-codex-tools/AdminCodexToolsDialog.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const checkedAt = "2026-07-17T08:00:00.000Z";
const previewId = "9943e22b-97a3-48b6-ae84-1a2cced6a353";
const backupId = "c3d866d1-9690-4db5-b44c-6294c07aa83e";

const speedDefaults: CodexLbSpeedDefaultsResponse = {
  models: [
    { modelId: "gpt-5.5", displayName: "GPT-5.5", tier: "STANDARD" },
    { modelId: "gpt-5.4", displayName: "GPT-5.4", tier: "FAST" }
  ],
  updatedAt: checkedAt,
  checkedAt
};

const purgePreview: CodexHistoryPurgePreviewResponse = {
  status: "READY",
  previewId,
  candidates: { threads: 12, cliTasks: 7, indexEntries: 10, rolloutFiles: 11, shellSnapshots: 4 },
  protectedThreads: 3,
  expiresAt: "2026-07-17T08:05:00.000Z",
  checkedAt
};

const purgeResult: CodexHistoryPurgeResponse = {
  status: "COMPLETED",
  previewId,
  backupId,
  purged: purgePreview.candidates,
  protectedThreads: 4,
  newlyProtectedThreads: 1,
  completedAt: checkedAt
};

const cleanupPreview: CliSessionCleanupPreviewResponse = {
  status: "READY",
  previewId,
  counts: {
    opencode: { sessions: 12, newSessionSessions: 4, emptySessions: 3, mappingFiles: 2 },
    opencodeTmp: { entries: 500, bytes: 15302234047 },
    codex: { status: "NOOP", previewId: null, threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
    codexOrphans: { rolloutFiles: 0, bytes: 0 },
    codexPaneHomes: { dirs: 3, bytes: 2140027020 },
    cliStores: [{ cli: "grok", entries: 0, bytes: 0 }],
    totalBytes: 17442261067
  },
  checkedAt
};

const cleanupResult: CliSessionCleanupResponse = {
  status: "COMPLETED",
  previewId,
  cleaned: {
    opencode: { sessions: 12, newSessionSessions: 4, emptySessions: 3, mappingFiles: 2 },
    opencodeTmp: { entries: 500, bytes: 15302234047 },
    codex: { status: "COMPLETED", threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
    codexOrphans: { rolloutFiles: 0, bytes: 0 },
    codexPaneHomes: { dirs: 3, bytes: 2140027020 },
    cliStores: [{ cli: "grok", entries: 0, bytes: 0 }]
  },
  totalBytes: 17442261067,
  failures: [],
  completedAt: checkedAt
};

function createClient(overrides: Partial<AdminCodexToolsClient> = {}) {
  return {
    speedDefaults: vi.fn(async () => speedDefaults),
    updateSpeedDefault: vi.fn(async (modelId, tier) => ({
      ...speedDefaults,
      models: speedDefaults.models.map((model) => model.modelId === modelId ? { ...model, tier } : model)
    }) as CodexLbSpeedDefaultsResponse),
    previewHistoryPurge: vi.fn(async () => purgePreview),
    executeHistoryPurge: vi.fn(async () => purgeResult),
    previewCliSessionCleanup: vi.fn(async () => cleanupPreview),
    executeCliSessionCleanup: vi.fn(async () => cleanupResult),
    ...overrides
  } satisfies AdminCodexToolsClient;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(cleanup);

describe("AdminCodexToolsDialog", () => {
  it("keeps admin tools visible as OFF without loading or mutating Codex state", () => {
    const speedClient = createClient();
    const speed = render(
      <AdminCodexToolsDialog
        initialTool="speed"
        client={speedClient}
        isCodexEnabled={false}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Codex speed defaults" })).toBeTruthy();
    expect(screen.getByText("OFF")).toBeTruthy();
    expect(speedClient.speedDefaults).not.toHaveBeenCalled();
    speed.unmount();

    const historyClient = createClient();
    render(
      <AdminCodexToolsDialog
        initialTool="history"
        client={historyClient}
        isCodexEnabled={false}
        anyCliEnabled={false}
        onClose={vi.fn()}
      />
    );
    const preview = screen.getByRole("button", { name: "Preview history purge" });
    expect((preview as HTMLButtonElement).disabled).toBe(true);
    expect(preview.getAttribute("title")).toBe("Enable a CLI in Settings");
    fireEvent.click(preview);
    expect(historyClient.previewHistoryPurge).not.toHaveBeenCalled();
  });

  it("allows history purge when codex is off but another CLI runtime is enabled", async () => {
    const client = createClient();
    render(
      <AdminCodexToolsDialog
        initialTool="history"
        client={client}
        isCodexEnabled={false}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Purge history" });
    expect(within(dialog).queryByText("OFF")).toBeNull();
    const preview = within(dialog).getByRole("button", { name: "Preview history purge" });
    expect((preview as HTMLButtonElement).disabled).toBe(false);
    expect(preview.getAttribute("title")).toBeNull();
    fireEvent.click(preview);
    await waitFor(() => expect(client.previewHistoryPurge).toHaveBeenCalled());
  });

  it("disables an already-open speed dialog when the master capability turns Off", async () => {
    const client = createClient();
    const view = render(
      <AdminCodexToolsDialog
        initialTool="speed"
        client={client}
        isCodexEnabled
        onClose={vi.fn()}
      />
    );

    const fast = await screen.findByRole("button", { name: "Set GPT-5.5 to Fast" });
    expect((fast as HTMLButtonElement).disabled).toBe(false);

    view.rerender(
      <AdminCodexToolsDialog
        initialTool="speed"
        client={client}
        isCodexEnabled={false}
        onClose={vi.fn()}
      />
    );

    expect((fast as HTMLButtonElement).disabled).toBe(true);
    expect(fast.getAttribute("title")).toBe("Enable Codex in Settings");
  });

  it.each(["unchanged", "missing"])("does not claim a speed change when the response is %s", async (response) => {
    const client = createClient({
      updateSpeedDefault: vi.fn(async () => ({
        ...speedDefaults,
        models: response === "missing" ? [] : speedDefaults.models
      }))
    });
    render(<AdminCodexToolsDialog initialTool="speed" client={client} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set GPT-5.5 to Fast" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Speed default was not changed.");
    expect(screen.queryByText("GPT-5.5 now uses Fast.")).toBeNull();
  });

  it("loads exact model defaults and updates only the selected speed tier", async () => {
    const client = createClient();
    render(<AdminCodexToolsDialog initialTool="speed" client={client} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Codex speed defaults" });
    expect(await within(dialog).findByText("GPT-5.5")).toBeTruthy();
    expect(within(dialog).getByText(/currently advertised provider model/i)).toBeTruthy();
    expect(dialog.textContent).not.toContain("exact GPT-5.5 or GPT-5.4");
    expect(within(dialog).getByRole("button", { name: "Set GPT-5.5 to Standard" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "Set GPT-5.4 to Fast" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Set GPT-5.5 to Fast" }));
    await waitFor(() => expect(client.updateSpeedDefault).toHaveBeenCalledWith("gpt-5.5", "FAST"));
    expect((await within(dialog).findByRole("status")).textContent).toContain("GPT-5.5 now uses Fast");
    expect(within(dialog).getByRole("button", { name: "Set GPT-5.5 to Fast" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("requires a fresh preview and exact typed confirmation before purging", async () => {
    const client = createClient();
    render(<AdminCodexToolsDialog initialTool="history" client={client} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "Purge history" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview history purge" }));
    expect(await within(dialog).findByText("12")).toBeTruthy();
    expect(within(dialog).getByText("Shared CLI tasks").nextSibling?.textContent).toBe("7");
    expect(within(dialog).getByText(/3 active threads are protected/i)).toBeTruthy();

    const confirmation = within(dialog).getByLabelText("Type PURGE HISTORY to confirm");
    const execute = within(dialog).getByRole("button", { name: "Purge history" });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(confirmation, { target: { value: "PURGE" } });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(confirmation, { target: { value: "PURGE HISTORY" } });
    expect((execute as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(execute);

    await waitFor(() => expect(client.executeHistoryPurge).toHaveBeenCalledWith(previewId, "PURGE HISTORY"));
    expect((await within(dialog).findByRole("status")).textContent).toMatch(
      /12 native threads and 7 shared CLI tasks purged/i
    );
    expect(dialog.textContent).not.toContain("Codex");
    expect(within(dialog).getByText(/1 thread became protected after preview/i)).toBeTruthy();
  });

  it("keeps protected and empty history safe when preview returns NOOP", async () => {
    const noop: CodexHistoryPurgePreviewResponse = {
      ...purgePreview,
      status: "NOOP",
      candidates: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
      protectedThreads: 5
    };
    const client = createClient({ previewHistoryPurge: vi.fn(async () => noop) });
    render(<AdminCodexToolsDialog initialTool="history" client={client} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview history purge" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/no removable history/i);
    expect(screen.queryByLabelText("Type PURGE HISTORY to confirm")).toBeNull();
    expect(client.executeHistoryPurge).not.toHaveBeenCalled();
  });

  it("reports a safe NOOP when previewed history becomes protected before purge", async () => {
    const noopResult: CodexHistoryPurgeResponse = {
      ...purgeResult,
      status: "NOOP",
      purged: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
      protectedThreads: 15,
      newlyProtectedThreads: 12
    };
    const client = createClient({ executeHistoryPurge: vi.fn(async () => noopResult) });
    render(<AdminCodexToolsDialog initialTool="history" client={client} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview history purge" }));
    fireEvent.change(await screen.findByLabelText("Type PURGE HISTORY to confirm"), {
      target: { value: "PURGE HISTORY" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Purge history" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/no history was removed/i);
    expect(screen.getByText(/12 threads became protected after preview/i)).toBeTruthy();
  });

  it("runs a CLI session cleanup only after a fresh preview and typed confirmation", async () => {
    const client = createClient();
    render(<AdminCodexToolsDialog initialTool="cleanup" client={client} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Clean CLI sessions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview CLI session cleanup" }));

    expect(await screen.findByText("Removable CLI sessions")).toBeTruthy();
    expect(screen.getByText(/14.3 GB/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Type CLEAN CLI SESSIONS to confirm"), {
      target: { value: "CLEAN CLI SESSIONS" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Clean CLI sessions" }));

    await waitFor(() => expect(client.executeCliSessionCleanup).toHaveBeenCalledWith(previewId, "CLEAN CLI SESSIONS"));
    expect((await screen.findByRole("status")).textContent).toMatch(/cleanup completed successfully/i);
    expect(screen.getByText(/14.3 GB/)).toBeTruthy();
  });

  it("blocks the cleanup without the exact typed confirmation", async () => {
    const client = createClient();
    render(<AdminCodexToolsDialog initialTool="cleanup" client={client} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Preview CLI session cleanup" }));
    await screen.findByText("Removable CLI sessions");
    fireEvent.change(await screen.findByLabelText("Type CLEAN CLI SESSIONS to confirm"), {
      target: { value: "clean cli sessions" }
    });

    expect(screen.getByRole("button", { name: "Clean CLI sessions" }).hasAttribute("disabled")).toBe(true);
    expect(client.executeCliSessionCleanup).not.toHaveBeenCalled();
  });
});
