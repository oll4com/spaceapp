import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { HarnessPane } from "../src/features/harness-pane/HarnessPane.js";

vi.mock("../src/api.js", () => ({
  api: {
    harnessUrl: "/api/harness/",
    harnessHealth: vi.fn(),
    bindHarnessTitleSession: vi.fn(async () => ({})),
  },
}));

import { api } from "../src/api.js";

function harnessPane(overrides: Partial<Pane> = {}): Pane {
  return {
    id: "pane:harness-proof",
    roomId: "room:harness-proof",
    title: "Harness 1",
    titleSource: "auto",
    mode: "HARNESS",
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
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HarnessPane", () => {
  it("binds native session selection from its own frame without remounting it or making duplicate requests", async () => {
    vi.mocked(api.harnessHealth).mockResolvedValue({
      ok: true,
      status: 200,
      checkedAt: "2026-07-06T00:00:00.000Z",
      durationMs: 5,
    });
    const view = render(
      <HarnessPane pane={harnessPane()} workspaceTextSize={14} />,
    );
    const frame = (await screen.findByTitle(
      "Harness Harness 1",
    )) as HTMLIFrameElement;
    const data = {
      type: "space:harness-session",
      paneSessionId: "space-pane-harness-proof",
      sessionId: "native-selected",
    };
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://external.invalid",
          source: frame.contentWindow,
          data,
        }),
      );
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data,
        }),
      );
    });
    expect(api.bindHarnessTitleSession).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data,
        }),
      );
    });
    expect(api.bindHarnessTitleSession).toHaveBeenCalledExactlyOnceWith(
      "pane:harness-proof",
      "native-selected",
    );
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data,
        }),
      );
    });
    expect(api.bindHarnessTitleSession).toHaveBeenCalledTimes(1);
    view.rerender(
      <HarnessPane
        pane={harnessPane({ title: "Updated title" })}
        workspaceTextSize={14}
      />,
    );
    expect(screen.getByTitle("Harness Updated title")).toBe(frame);
  });
  it("renders a sandboxed iframe pointed at the harness proxy when healthy", async () => {
    vi.mocked(api.harnessHealth).mockResolvedValue({
      ok: true,
      status: 200,
      checkedAt: "2026-07-06T00:00:00.000Z",
      durationMs: 5,
    });
    render(<HarnessPane pane={harnessPane()} workspaceTextSize={14} />);
    await waitFor(() =>
      expect(screen.getByTitle("Harness Harness 1")).toBeTruthy(),
    );
    const iframe = screen.getByTitle("Harness Harness 1");
    expect(iframe.getAttribute("src")).toBe(
      "/api/harness/?spacePane=pane%3Aharness-proof&frame=0",
    );
    expect(iframe.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
    expect(iframe.getAttribute("sandbox")).not.toContain(
      "allow-top-navigation",
    );
  });

  it("reloads a frame that remains stuck in the Harness plugin bootstrap", async () => {
    vi.useFakeTimers();
    vi.mocked(api.harnessHealth).mockResolvedValue({
      ok: true,
      status: 200,
      checkedAt: "2026-07-06T00:00:00.000Z",
      durationMs: 5,
    });
    render(<HarnessPane pane={harnessPane()} workspaceTextSize={14} />);
    await vi.waitFor(() =>
      expect(screen.getByTitle("Harness Harness 1")).toBeTruthy(),
    );
    const iframe = screen.getByTitle("Harness Harness 1") as HTMLIFrameElement;
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      value: { body: { innerText: "Loading plugins..." } },
    });
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { __ModuleLoader__: { mode: "queue" } },
    });
    await act(async () => {
      iframe.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(
      screen.getByTitle("Harness Harness 1").getAttribute("src"),
    ).toContain("frame=1");
  });

  it("shows an unavailable notice when the upstream is down", async () => {
    vi.mocked(api.harnessHealth).mockResolvedValue({
      ok: false,
      status: 502,
      checkedAt: "2026-07-06T00:00:00.000Z",
      durationMs: 5,
    });
    render(<HarnessPane pane={harnessPane()} workspaceTextSize={14} />);
    await waitFor(() => expect(screen.getByText(/unreachable/i)).toBeTruthy());
    expect(screen.queryByTitle("Harness Harness 1")).toBeNull();
  });

  it("shows a disabled notice when the API returns 404", async () => {
    vi.mocked(api.harnessHealth).mockResolvedValue({
      ok: false,
      status: 404,
      checkedAt: "2026-07-06T00:00:00.000Z",
      durationMs: 5,
    });
    render(<HarnessPane pane={harnessPane()} workspaceTextSize={14} />);
    await waitFor(() => expect(screen.getByText(/disabled/i)).toBeTruthy());
  });
});


describe("Harness background traffic", () => {
  it("does not request health for a hidden warm pane", async () => {
    vi.mocked(api.harnessHealth).mockClear();
    const view = render(<HarnessPane pane={harnessPane()} workspaceTextSize={14} isVisible={false} />);
    await act(async () => {});
    expect(api.harnessHealth).not.toHaveBeenCalled();
    view.unmount();
  });
});
