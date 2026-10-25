import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SetupConnection,
  SetupConnectionCheckEvent,
  SetupConnectionCheckReplay,
  SetupConnectionCheckRun,
  SetupOverview
} from "@space/contracts";
import { STARTER_PROMPTS, SetupConnectionsWizard } from "../src/features/setup-connections/SetupConnectionsWizard.js";
import type {
  SetupConnectionChecksClient
} from "../src/features/setup-connections/useSetupConnectionsWizard.js";

function connection(
  id: string,
  label: string,
  functionalState: SetupConnection["functionalState"],
  liveVerificationState: SetupConnection["liveVerificationState"] = "NOT_CHECKED"
): SetupConnection {
  const functional = functionalState === "FUNCTIONAL";
  return {
    id,
    label,
    providerName: label.replace(/ (Code )?CLI$/, ""),
    category: "AI coding CLI",
    state: functional ? "CONNECTED" : functionalState,
    functionalState,
    liveVerificationState,
    reasonCode: functional
      ? liveVerificationState === "QUOTA_LIMITED"
        ? "PROVIDER_QUOTA_LIMITED"
        : liveVerificationState === "PROVIDER_FAILED"
          ? "PROVIDER_CHECK_FAILED"
          : liveVerificationState === "TIMED_OUT"
            ? "PROVIDER_CHECK_TIMED_OUT"
            : liveVerificationState === "VERIFIED"
              ? null
              : "NOT_VERIFIED"
      : functionalState === "UNAVAILABLE"
        ? "CLI_RUNTIME_UNAVAILABLE"
        : "CREDENTIAL_REQUIRED",
    verifiedAt: liveVerificationState === "VERIFIED" ? "2026-07-29T10:00:00.000Z" : null,
    staleAt: liveVerificationState === "VERIFIED" ? "2026-08-28T10:00:00.000Z" : null,
    actions: functional
      ? ["VERIFY"]
      : functionalState === "UNAVAILABLE"
        ? ["RUN_HOST_LAUNCHER"]
        : ["OPEN_LOGIN_PANE", "VERIFY"]
  };
}

function overview(connections: SetupConnection[], isComplete = false): SetupOverview {
  const functional = connections.filter((item) => item.functionalState === "FUNCTIONAL").length;
  return {
    onboardingVersion: 1,
    isComplete,
    completedAt: isComplete ? "2026-07-29T10:05:00.000Z" : null,
    starterRoomId: "room:getting-started",
    summary: {
      total: connections.length,
      functional,
      liveVerified: connections.filter((item) => item.liveVerificationState === "VERIFIED").length,
      needsSetup: connections.length - functional
    },
    connections
  };
}

function checkRun(
  overrides: Partial<SetupConnectionCheckRun> = {}
): SetupConnectionCheckRun {
  return {
    id: "setup_check_run:test",
    scope: "ALL",
    connectionIds: ["cli:codex", "cli:autohand"],
    status: "RUNNING",
    totalCount: 2,
    completedCount: 0,
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    finishedAt: null,
    ...overrides
  };
}

function checkEvent(
  sequence: number,
  connectionId: string,
  stage: SetupConnectionCheckEvent["stage"],
  state: SetupConnectionCheckEvent["state"] = "RUNNING",
  connection?: SetupConnection
): SetupConnectionCheckEvent {
  return {
    id: `setup_check_event:${sequence}`,
    runId: "setup_check_run:test",
    sequence,
    connectionId,
    stage,
    state,
    functionalState: connection?.functionalState ?? null,
    liveVerificationState: connection?.liveVerificationState ?? null,
    reasonCode: connection?.reasonCode ?? null,
    createdAt: `2026-07-29T10:00:0${Math.min(sequence, 9)}.000Z`
  };
}

function replay(
  run: SetupConnectionCheckRun,
  nextOverview: SetupOverview,
  events: SetupConnectionCheckEvent[] = []
): SetupConnectionCheckReplay {
  return { run, overview: nextOverview, events };
}

function checks(
  initialReplay: SetupConnectionCheckReplay,
  overrides: Partial<SetupConnectionChecksClient> = {}
): SetupConnectionChecksClient {
  return {
    startSetupConnectionChecks: vi.fn(async () => initialReplay.run),
    startSetupConnectionCheck: vi.fn(async () => ({
      ...initialReplay.run,
      scope: "SINGLE" as const,
      connectionIds: ["cli:codex"],
      totalCount: 1
    })),
    getSetupConnectionCheckReplay: vi.fn(async () => initialReplay),
    openSetupConnectionCheckStream: vi.fn(() => null),
    ...overrides
  };
}

class FakeEventSource extends EventTarget {
  readonly close = vi.fn();

  emit(type: string, payload?: unknown) {
    this.dispatchEvent(
      payload === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(payload) })
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("SetupConnectionsWizard", () => {
  it("guides setup with OpenCode first, optional connections, and a truthful result without running checks", async () => {
    const data = overview([connection("cli:codex", "Codex CLI", "NEEDS_SETUP"), connection("cli:opencode", "OpenCode CLI", "FUNCTIONAL")], true);
    const client = checks(replay(checkRun({ status: "COMPLETED" }), data));
    render(<SetupConnectionsWizard guided open checks={client} finish={vi.fn(async () => data)}
      loadOverview={vi.fn(async () => data)} onOpenChange={vi.fn()} openLogin={vi.fn()}
      connectionsContent={<input aria-label="Optional draft" defaultValue="" />} />);
    expect(await screen.findByText("Your workspace, one step at a time")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "OpenCode CLI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "OpenCode CLI" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Codex CLI" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all tools" }));
    expect(screen.getByRole("heading", { name: "Codex CLI" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Optional draft"), { target: { value: "retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Setup result").textContent).toContain("1 of 2 tools are ready");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(screen.getByRole("region", { name: "Try a first prompt" }).textContent).toContain(STARTER_PROMPTS[0]);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt 1" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(STARTER_PROMPTS[0]));
    expect(await screen.findByText("Copied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText("Optional draft") as HTMLInputElement).value).toBe("retained");
    expect(client.startSetupConnectionChecks).not.toHaveBeenCalled();
  });
  it("shows canonical summary and immediate durable partial progress", async () => {
    const initial = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL"),
      connection("cli:autohand", "Autohand Code CLI", "NEEDS_SETUP")
    ]);
    const verifiedCodex = connection("cli:codex", "Codex CLI", "FUNCTIONAL", "VERIFIED");
    const partialOverview = overview([verifiedCodex, initial.connections[1]!]);
    const events = [
      checkEvent(1, "cli:codex", "Detecting CLI"),
      checkEvent(2, "cli:codex", "Checking saved credential"),
      checkEvent(3, "cli:codex", "Sending live provider challenge"),
      checkEvent(4, "cli:codex", "Confirming credential identity"),
      checkEvent(5, "cli:codex", "Saving result"),
      checkEvent(6, "cli:codex", "Verified", "COMPLETED", verifiedCodex)
    ];
    const partial = replay(checkRun({ completedCount: 1 }), partialOverview, events);
    const checkClient = checks(partial);
    const finish = vi.fn(async () => ({ ...partialOverview, isComplete: true }));
    const onOpenChange = vi.fn();

    render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={finish}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={onOpenChange}
        open
        openLogin={vi.fn(async () => undefined)}
        replayIntervalMs={60_000}
      />
    );

    expect(await screen.findByText("1 of 2 functional")).toBeTruthy();
    expect(screen.getByText("0 live verified")).toBeTruthy();
    expect(screen.getByText("1 needs setup")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check all CLIs" }));
    await waitFor(() => expect(checkClient.startSetupConnectionChecks).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("1 of 2 completed")).toBeTruthy();
    expect(screen.getByText("1 live verified")).toBeTruthy();
    expect(screen.getByText("6 steps completed")).toBeTruthy();
    expect(screen.getAllByText("Verified")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Finish for now" }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(checkClient.openSetupConnectionCheckStream).toHaveBeenCalled();
  });

  it("keeps quota and generic provider failures functional with only a live retry action", async () => {
    const quota = connection("cli:kimi", "Kimi Code CLI", "FUNCTIONAL", "QUOTA_LIMITED");
    const failed = connection("cli:codex", "Codex CLI", "FUNCTIONAL", "PROVIDER_FAILED");
    const initial = overview([quota, failed]);
    const run = checkRun({
      id: "setup_check_run:single",
      scope: "SINGLE",
      connectionIds: ["cli:kimi"],
      totalCount: 1
    });
    const checkClient = checks(replay(run, initial));

    render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
      />
    );

    expect(await screen.findByText("2 of 2 functional")).toBeTruthy();
    expect(screen.getByText("Quota limited")).toBeTruthy();
    expect(screen.getByText("Provider failed")).toBeTruthy();
    expect(screen.queryByText("Connect")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check live response for Kimi Code CLI" }));
    await waitFor(() => {
      expect(checkClient.startSetupConnectionCheck).toHaveBeenCalledWith("cli:kimi");
    });
  });

  it("recovers missing SSE progress through durable replay after a reconnect error", async () => {
    const initial = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL"),
      connection("cli:autohand", "Autohand Code CLI", "NEEDS_SETUP")
    ]);
    const running = replay(checkRun(), initial);
    const verifiedCodex = connection("cli:codex", "Codex CLI", "FUNCTIONAL", "VERIFIED");
    const completeOverview = overview([verifiedCodex, initial.connections[1]!]);
    const completedRun = checkRun({
      status: "COMPLETED",
      completedCount: 2,
      updatedAt: "2026-07-29T10:00:10.000Z",
      finishedAt: "2026-07-29T10:00:10.000Z"
    });
    const completed = replay(completedRun, completeOverview, [
      checkEvent(7, "cli:autohand", "Needs setup", "COMPLETED", initial.connections[1])
    ]);
    const source = new FakeEventSource();
    const getReplay = vi.fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValue(completed);
    const checkClient = checks(running, {
      getSetupConnectionCheckReplay: getReplay,
      openSetupConnectionCheckStream: vi.fn(() => source as unknown as EventSource)
    });

    render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
        replayIntervalMs={100}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Check all CLIs" }));
    await waitFor(() => expect(checkClient.openSetupConnectionCheckStream).toHaveBeenCalled());
    act(() => source.emit("error"));
    expect(await screen.findByText(/Live progress is reconnecting/i)).toBeTruthy();
    await waitFor(() => expect(getReplay).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2 of 2 completed")).toBeTruthy();
    expect(screen.getByText("1 live verified")).toBeTruthy();
  });

  it("keeps the SSE stream open for the canonical overview after a terminal run event", async () => {
    const initial = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL"),
      connection("cli:autohand", "Autohand Code CLI", "NEEDS_SETUP")
    ]);
    const running = replay(checkRun(), initial);
    const source = new FakeEventSource();
    const checkClient = checks(running, {
      openSetupConnectionCheckStream: vi.fn(() => source as unknown as EventSource)
    });
    const completedRun = checkRun({
      status: "COMPLETED",
      completedCount: 2,
      updatedAt: "2026-07-29T10:00:10.000Z",
      finishedAt: "2026-07-29T10:00:10.000Z"
    });
    const completedOverview = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL", "VERIFIED"),
      initial.connections[1]!
    ]);

    render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Check all CLIs" }));
    await waitFor(() => expect(checkClient.openSetupConnectionCheckStream).toHaveBeenCalled());

    act(() => source.emit("run", completedRun));
    expect(source.close).not.toHaveBeenCalled();

    act(() => source.emit("overview", completedOverview));
    expect(await screen.findByText("1 live verified")).toBeTruthy();
  });

  it("recovers an active server run after the wizard remounts", async () => {
    const initial = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL"),
      connection("cli:autohand", "Autohand Code CLI", "NEEDS_SETUP")
    ]);
    const running = replay(checkRun({ completedCount: 1 }), initial, [
      checkEvent(1, "cli:codex", "Detecting CLI")
    ]);
    const checkClient = checks(running);
    const first = render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Check all CLIs" }));
    await waitFor(() => expect(checkClient.getSetupConnectionCheckReplay).toHaveBeenCalledTimes(1));
    first.unmount();

    render(
      <SetupConnectionsWizard
        checks={checkClient}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
      />
    );

    await waitFor(() => expect(checkClient.getSetupConnectionCheckReplay).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("1 of 2 completed")).toBeTruthy();
  });

  it("finishes for now without losing the active run on reopen", async () => {
    const initial = overview([
      connection("cli:codex", "Codex CLI", "FUNCTIONAL"),
      connection("cli:autohand", "Autohand Code CLI", "NEEDS_SETUP")
    ]);
    const running = replay(checkRun({ completedCount: 1 }), initial);
    const checkClient = checks(running);

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Reopen setup</button>
          <SetupConnectionsWizard
            checks={checkClient}
            finish={vi.fn(async () => ({ ...initial, isComplete: true }))}
            loadOverview={vi.fn(async () => initial)}
            onOpenChange={setOpen}
            open={open}
            openLogin={vi.fn(async () => undefined)}
          />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Check all CLIs" }));
    await waitFor(() => expect(checkClient.getSetupConnectionCheckReplay).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Finish for now" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reopen setup" }));
    expect(await screen.findByRole("heading", { name: "Setup & connections" })).toBeTruthy();
    await waitFor(() => expect(checkClient.getSetupConnectionCheckReplay).toHaveBeenCalledTimes(2));
    expect(screen.getByText("1 of 2 completed")).toBeTruthy();
  });

  it("closes for terminal login and reopens when the CLI becomes functional", async () => {
    const initial = overview([connection("cli:codex", "Codex CLI", "NEEDS_SETUP")]);
    const functional = overview([connection("cli:codex", "Codex CLI", "FUNCTIONAL")]);
    const loadOverview = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(functional);
    const openLogin = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();

    render(
      <SetupConnectionsWizard
        checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
        finish={vi.fn(async () => functional)}
        loadOverview={loadOverview}
        onOpenChange={onOpenChange}
        open
        openLogin={openLogin}
        pollIntervalMs={10}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect Codex CLI" }));
    await waitFor(() => expect(openLogin).toHaveBeenCalledWith("cli:codex"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Codex CLI is functional. Continue with the next tool when you are ready.")).toBeTruthy();
  });

  it("reopens with a retry path after login observation times out", async () => {
    const initial = overview([connection("cli:codex", "Codex CLI", "NEEDS_SETUP")]);
    const onOpenChange = vi.fn();

    render(
      <SetupConnectionsWizard
        checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={onOpenChange}
        open
        openLogin={vi.fn(async () => undefined)}
        pollIntervalMs={5}
        pollTimeoutMs={15}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect Codex CLI" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
    expect((await screen.findByRole("alert")).textContent).toMatch(/still not functional/i);
    expect(screen.getByRole("button", { name: "Connect Codex CLI" })).toBeTruthy();
  });

  it("does not claim login started when opening the terminal fails", async () => {
    const initial = overview([connection("cli:claude", "Claude Code CLI", "NEEDS_SETUP")]);

    render(
      <SetupConnectionsWizard
        checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => {
          throw new Error("CLI runtime cli:claude does not support terminal login.");
        })}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect Claude Code CLI" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/does not support terminal login/i);
    expect(screen.queryByText(/Complete login in the Claude Code CLI terminal/i)).toBeNull();
  });

  it("opens maintenance for unavailable runtimes that require host repair", async () => {
    const unavailable = connection("cli:codex", "Codex CLI", "UNAVAILABLE");
    const initial = overview([unavailable]);
    const onOpenMaintenance = vi.fn();

    render(
      <SetupConnectionsWizard
        checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
        onOpenMaintenance={onOpenMaintenance}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open maintenance" }));
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
  });

  it("keeps reverse keyboard navigation trapped when focus starts on the dialog heading", async () => {
    const initial = overview([connection("cli:codex", "Codex CLI", "NEEDS_SETUP")]);

    render(
      <SetupConnectionsWizard
        checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
        finish={vi.fn(async () => initial)}
        loadOverview={vi.fn(async () => initial)}
        onOpenChange={vi.fn()}
        open
        openLogin={vi.fn(async () => undefined)}
      />
    );

    const heading = await screen.findByRole("heading", { name: "Setup & connections" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    fireEvent.keyDown(heading, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Finish for now" }));
  });

  it("dismisses with Escape, restores focus, and keeps mobile bottom-sheet rules", async () => {
    const initial = overview([connection("cli:codex", "Codex CLI", "NEEDS_SETUP")]);

    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open setup</button>
          <SetupConnectionsWizard
            checks={checks(replay(checkRun({ totalCount: 1 }), initial))}
            finish={vi.fn(async () => initial)}
            loadOverview={vi.fn(async () => initial)}
            onOpenChange={setOpen}
            open={open}
            openLogin={vi.fn(async () => undefined)}
            triggerRef={triggerRef}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open setup" });
    fireEvent.click(trigger);
    const heading = await screen.findByRole("heading", { name: "Setup & connections" });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    fireEvent.keyDown(heading, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    const css = readFileSync("src/features/setup-connections/setup-connections.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 42rem\)[\s\S]*place-items: end center/);
    expect(css).toMatch(/@media \(max-width: 42rem\)[\s\S]*border-radius: 12px 12px 0 0/);
    expect(css).not.toContain("!important");
  });
});
