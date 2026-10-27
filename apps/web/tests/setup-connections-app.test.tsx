import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthMe,
  Pane,
  SetupConnection,
  SetupOverview
} from "@space/contracts";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { App } from "../src/App.js";
import { createDemoFixture } from "../src/demo/demo-fixture.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import {
  SpaceRuntimeProvider,
  type SpaceApiClient,
  type SpaceRuntime
} from "../src/runtime/SpaceRuntime.js";

vi.mock("../src/features/terminal-pane/TerminalPane.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/features/terminal-pane/TerminalPane.js")>();
  return {
    ...original,
    TerminalPane: ({ pane }: { pane: Pane }) => (
      <section data-space-pane-id={pane.id}>
        <header tabIndex={-1}>{pane.title}</header>
      </section>
    )
  };
});

const owner: AuthMe = {
  user: { id: "user:owner", email: "owner@example.com", role: "ADMIN" },
  isAuthenticated: true,
  isSetupRequired: false
};

function connection(state: SetupConnection["state"]): SetupConnection {
  return {
    id: "cli:codex",
    label: "Codex CLI",
    providerName: "Codex",
    category: "AI coding CLI",
    state,
    functionalState: state === "CONNECTED"
      ? "FUNCTIONAL"
      : state === "UNAVAILABLE"
        ? "UNAVAILABLE"
        : "NEEDS_SETUP",
    liveVerificationState: state === "CONNECTED" ? "VERIFIED" : "NOT_CHECKED",
    reasonCode: state === "CONNECTED" ? null : "CREDENTIAL_REQUIRED",
    verifiedAt: state === "CONNECTED" ? "2026-07-29T10:00:00.000Z" : null,
    staleAt: state === "CONNECTED" ? "2026-08-28T10:00:00.000Z" : null,
    actions: state === "CONNECTED" ? ["VERIFY"] : ["OPEN_LOGIN_PANE", "VERIFY"]
  };
}

function overview(
  state: SetupConnection["state"],
  isComplete = false,
  starterRoomId: string | null = "room:demo-launch"
): SetupOverview {
  return {
    onboardingVersion: 1,
    isComplete,
    completedAt: isComplete ? "2026-07-29T10:05:00.000Z" : null,
    starterRoomId,
    summary: {
      total: 1,
      functional: state === "CONNECTED" ? 1 : 0,
      liveVerified: state === "CONNECTED" ? 1 : 0,
      needsSetup: state === "CONNECTED" ? 0 : 1
    },
    connections: [connection(state)]
  };
}

function renderSetupApp(
  configure: (baseApi: SpaceApiClient) => Partial<SpaceApiClient>
) {
  const bundle = createDemoRuntime();
  const overrides: Partial<SpaceApiClient> = {
    panes: async (roomId) => ({
      ...(await bundle.runtime.api.panes(roomId)),
      data: []
    }),
    ...configure(bundle.runtime.api)
  };
  const api = new Proxy(bundle.runtime.api, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property as keyof SpaceApiClient];
      }
      return Reflect.get(target, property, receiver) as unknown;
    }
  });
  const runtime: SpaceRuntime = { ...bundle.runtime, api };
  return {
    ...render(
      <SpaceRuntimeProvider runtime={runtime}>
        <VoiceInputProvider><App /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    ),
    baseApi: bundle.runtime.api
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Setup & connections App integration", () => {
  it("auto-opens for an existing owner only after rooms have loaded when onboarding is incomplete", async () => {
    const calls: string[] = [];

    renderSetupApp((baseApi) => ({
      me: vi.fn(async () => owner),
      rooms: vi.fn(async () => {
        const result = await baseApi.rooms();
        calls.push("rooms");
        return result;
      }),
      setupOverview: vi.fn(async () => {
        calls.push("overview");
        return overview("NEEDS_SETUP");
      })
    }));

    expect(await screen.findByRole("heading", { name: "Your Space" })).toBeTruthy();
    expect(calls.indexOf("rooms")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("overview")).toBeGreaterThan(calls.indexOf("rooms"));
  });

  it("does not auto-open after completed onboarding", async () => {
    const setupOverview = vi.fn(async () => overview("CONNECTED", true));

    renderSetupApp(() => ({
      me: vi.fn(async () => owner),
      setupOverview
    }));

    await waitFor(() => expect(setupOverview).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
  });

  it("tells the owner when setup status cannot be loaded instead of staying silent", async () => {
    const setupOverview = vi.fn(async () => { throw new Error("setup overview unavailable"); });
    renderSetupApp(() => ({
      me: vi.fn(async () => owner),
      setupOverview
    }));

    await waitFor(() => expect(setupOverview).toHaveBeenCalled());
    expect(await screen.findByText(/Setup status could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
  });

  it("opens Setup & connections inside Manage Connections", async () => {
    renderSetupApp(() => ({
      me: vi.fn(async () => owner),
      setupOverview: vi.fn(async () => overview("CONNECTED", true))
    }));

    fireEvent.click(await screen.findByRole("button", { name: "Admin mode" }));
    fireEvent.click(await screen.findByRole("button", { name: "Workspace" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Utilities" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(await screen.findByRole("dialog", { name: "Manage" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    fireEvent.click(screen.getByRole("button", { name: "Setup & connections" }));
    expect(await screen.findByRole("heading", { name: "Setup & connections" })).toBeTruthy();
  });

  it("creates and activates Getting Started before opening login when no room is active", async () => {
    const starterRoom = {
      ...createDemoFixture().rooms[0]!,
      id: "room:getting-started",
      name: "Getting Started"
    };
    const setupStarterRoom = vi.fn(async () => ({
      room: starterRoom,
      onboarding: {
        onboardingVersion: 1,
        isComplete: false,
        completedAt: null,
        starterRoomId: starterRoom.id
      }
    }));
    const cliLogin = vi.fn();

    renderSetupApp((baseApi) => ({
      me: vi.fn(async () => owner),
      rooms: vi.fn(async () => ({
        ...(await baseApi.rooms()),
        data: [],
        total: 0
      })),
      setupOverview: vi.fn(async () => overview("NEEDS_SETUP", false, null)),
      setupStarterRoom,
      cliLogin: cliLogin.mockImplementation(async (roomId, runtimeId) => {
        const result = await baseApi.cliLogin("room:demo-launch", runtimeId);
        return {
          ...result,
          pane: { ...result.pane, roomId },
          session: { ...result.session, roomId }
        };
      })
    }));

    await screen.findByRole("heading", { name: "Your Space" });
    fireEvent.click(screen.getByRole("button", { name: "Save and close setup" }));
    window.dispatchEvent(new CustomEvent("space:manage", { detail: { action: "setup-connections" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Codex CLI" }));

    await waitFor(() => expect(setupStarterRoom).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cliLogin).toHaveBeenCalledWith(starterRoom.id, "cli:codex"));
    expect(setupStarterRoom.mock.invocationCallOrder[0]).toBeLessThan(cliLogin.mock.invocationCallOrder[0]!);
    await act(async () => {
      await cliLogin.mock.results[0]?.value;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
    });
    await waitFor(() => {
      const paneHeader = document.querySelector<HTMLElement>('[data-space-pane-id] header');
      expect(document.activeElement).toBe(paneHeader);
    });
  });

  it.each([false, true])("reopens only after login exposes a credential (embedded=%s)", async (embedded) => {
    let verified = false;
    const setupOverview = vi.fn(async () => overview(verified ? "CONNECTED" : "NEEDS_SETUP", embedded));

    renderSetupApp((baseApi) => ({
      me: vi.fn(async () => owner),
      setupOverview,
      cliLogin: vi.fn(async (roomId, runtimeId) => {
        const result = await baseApi.cliLogin(roomId, runtimeId);
        return result;
      })
    }));

    if (!embedded) {
      await screen.findByRole("heading", { name: "Your Space" });
      fireEvent.click(screen.getByRole("button", { name: "Save and close setup" }));
    } else {
      await screen.findByRole("button", { name: "Admin mode" });
    }
    window.dispatchEvent(new CustomEvent("space:manage", { detail: { action: "setup-connections" } }));
    const connectButton = await screen.findByRole("button", { name: "Connect Codex CLI" });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(connectButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.queryByRole("heading", { name: "Setup & connections" })).toBeNull();
    expect(screen.queryByText(/is functional. Continue/)).toBeNull();
    verified = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    vi.useRealTimers();

    expect(await screen.findByText("Codex CLI is functional. Continue with the next tool when you are ready.")).toBeTruthy();
    expect(screen.getAllByText("Functional")).toHaveLength(1);
  });
});
