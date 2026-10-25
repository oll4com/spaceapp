import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, VncPreset } from "@space/contracts";
import { VncPane } from "../src/features/vnc-pane/VncPane.js";

const apiMock = vi.hoisted(() => ({
  vncPresets: vi.fn(),
  vncStreamWebSocketUrl: vi.fn(),
  updatePane: vi.fn()
}));

vi.mock("../src/api.js", () => ({
  api: apiMock
}));

const rfbMock = vi.hoisted(() => {
  const listeners: Record<string, (event: { detail?: { message?: string; clean?: boolean; reason?: string; name?: string } }) => void> = {};
  return {
    instances: [] as Array<{ container: HTMLElement; url: string; options: Record<string, unknown> }>,
    listeners,
    constructorError: null as Error | null,
    disconnect: vi.fn(),
    requestFullscreen: vi.fn(),
    emit(type: string, detail?: { message?: string; clean?: boolean; reason?: string; name?: string }) {
      listeners[type]?.({ detail });
    }
  };
});

vi.mock("@novnc/novnc", () => ({
  default: class {
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    focusOnClick = false;
    disconnect = rfbMock.disconnect;
    requestFullscreen = rfbMock.requestFullscreen;
    addEventListener = vi.fn((type: string, handler: (event: { detail?: unknown }) => void) => {
      rfbMock.listeners[type] = handler as never;
    });
    constructor(container: HTMLElement, url: string, options: Record<string, unknown>) {
      if (rfbMock.constructorError) throw rfbMock.constructorError;
      rfbMock.instances.push({ container, url, options });
    }
  }
}));

function pane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:vnc-proof",
    roomId: "room:vnc-proof",
    title: "VNC 1",
    titleSource: "auto",
    mode: "VNC",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: null,
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides
  };
}

function preset(input: Partial<VncPreset> = {}): VncPreset {
  return {
    id: "vm207-desktop",
    name: "public-host Desktop",
    host: "127.0.0.1",
    port: 5900,
    ...input
  };
}

describe("VncPane", () => {
  beforeEach(() => {
    apiMock.vncPresets.mockReset().mockResolvedValue({ presets: [preset()] });
    apiMock.vncStreamWebSocketUrl.mockReset().mockReturnValue("ws://space.test/api/panes/pane:vnc-proof/vnc/stream?host=127.0.0.1&port=5900");
    apiMock.updatePane.mockReset().mockResolvedValue(pane());
    rfbMock.instances.length = 0;
    for (const key of Object.keys(rfbMock.listeners)) delete rfbMock.listeners[key];
    rfbMock.constructorError = null;
    rfbMock.disconnect.mockReset();
    rfbMock.requestFullscreen.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the connect dialog when no target is stored and stays idle", async () => {
    render(<VncPane pane={pane()} />);
    expect(screen.getByText("VNC connection")).toBeTruthy();
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(rfbMock.instances).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole("option", { name: "public-host Desktop" })).toBeTruthy());
  });

  it("applies a preset to host and port fields", async () => {
    render(<VncPane pane={pane()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "public-host Desktop" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "vm207-desktop" } });
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("127.0.0.1");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("5900");
  });

  it("connects with stored credentials and remembers the target", async () => {
    render(<VncPane pane={pane()} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "public-host Desktop" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "192.0.2.20" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "5900" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("switch", { name: /Remember this target/i }));
    fireEvent.submit(screen.getByText("VNC connection").closest("form")!);
    await waitFor(() => expect(apiMock.vncStreamWebSocketUrl).toHaveBeenCalledWith("pane:vnc-proof", "192.0.2.20", 5900));
    expect(rfbMock.instances).toHaveLength(1);
    expect(apiMock.updatePane).toHaveBeenCalledWith("pane:vnc-proof", {
      vncTarget: { presetId: null, host: "192.0.2.20", port: 5900, password: "s3cret" }
    });
    rfbMock.emit("connect");
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());
  });

  it("auto-connects when the pane carries a stored target", async () => {
    render(<VncPane pane={pane({ vncTarget: { presetId: "vm207-desktop", host: "127.0.0.1", port: 5900, password: null } })} />);
    await waitFor(() => expect(apiMock.vncStreamWebSocketUrl).toHaveBeenCalledWith("pane:vnc-proof", "127.0.0.1", 5900));
    expect(rfbMock.instances).toHaveLength(1);
    expect(screen.queryByText("VNC connection")).toBeNull();
  });

  it("does not connect when host is empty", async () => {
    render(<VncPane pane={pane()} />);
    fireEvent.submit(screen.getByText("VNC connection").closest("form")!);
    await waitFor(() => expect(apiMock.vncStreamWebSocketUrl).not.toHaveBeenCalled());
    expect(rfbMock.instances).toHaveLength(0);
  });

  it("shows a security failure message and exposes dismiss", async () => {
    render(<VncPane pane={pane({ vncTarget: { presetId: null, host: "192.0.2.20", port: 5900, password: null } })} />);
    await waitFor(() => expect(rfbMock.instances).toHaveLength(1));
    rfbMock.emit("securityfailure", { reason: "Authentication failed" });
    await waitFor(() => expect(screen.getByText("Authentication failed")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(screen.queryByText("Authentication failed")).toBeNull();
  });

  it("disconnects via the toolbar and renders the screen container", async () => {
    render(<VncPane pane={pane({ vncTarget: { presetId: null, host: "127.0.0.1", port: 5900, password: null } })} />);
    await waitFor(() => expect(rfbMock.instances).toHaveLength(1));
    expect(document.querySelector(".vnc-pane-screen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(rfbMock.disconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("Disconnected")).toBeTruthy());
  });

  it("awaits an asynchronous stream URL before constructing noVNC", async () => {
    apiMock.vncStreamWebSocketUrl.mockReturnValue(Promise.resolve("ws://space.test/vnc/async"));
    render(<VncPane pane={pane({ vncTarget: { presetId: null, host: "127.0.0.1", port: 5900, password: null } })} />);
    await waitFor(() => expect(rfbMock.instances).toHaveLength(1));
    expect(rfbMock.instances[0]?.url).toBe("ws://space.test/vnc/async");
  });

  it("contains a noVNC constructor failure inside the pane", async () => {
    rfbMock.constructorError = new Error("Raw channel missing property: send");
    render(<VncPane pane={pane({ vncTarget: { presetId: null, host: "127.0.0.1", port: 5900, password: null } })} />);
    await waitFor(() => expect(screen.getByText("VNC connection could not be started. Retry the connection.")).toBeTruthy());
    expect(screen.getByText("Error")).toBeTruthy();
    expect(document.querySelector(".vnc-pane")).toBeTruthy();
  });
});
