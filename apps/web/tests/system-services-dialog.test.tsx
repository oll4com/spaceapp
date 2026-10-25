import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SystemServicesResponse } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SystemServicesDialog,
  type SystemServicesClient
} from "../src/features/service-control/SystemServicesDialog.js";

const mockSnapshot: SystemServicesResponse = {
  units: [
    {
      unit: "space-api.service",
      description: "Space API Server",
      type: "service",
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled",
      timerActivates: null,
      timerNextElapse: null,
      timerLastTrigger: null
    },
    {
      unit: "space-app-version-sync.timer",
      description: "Schedule version tag sync",
      type: "timer",
      loadState: "loaded",
      activeState: "active",
      subState: "waiting",
      unitFileState: "enabled",
      timerActivates: "space-app-version-sync.service",
      timerNextElapse: "2026-09-24T12:00:00.000Z",
      timerLastTrigger: "2026-09-24T06:00:00.000Z"
    },
    {
      unit: "space-deepseek-harness-relay.service",
      description: "Space DeepSeek Relay",
      type: "service",
      loadState: "loaded",
      activeState: "failed",
      subState: "failed",
      unitFileState: "disabled",
      timerActivates: null,
      timerNextElapse: null,
      timerLastTrigger: null
    },
    {
      unit: "space-cli-permissions-fix.service",
      description: "Space CLI permissions fix",
      type: "service",
      loadState: "loaded",
      activeState: "inactive",
      subState: "dead",
      unitFileState: "static",
      timerActivates: null,
      timerNextElapse: null,
      timerLastTrigger: null
    }
  ],
  summary: {
    total: 4,
    active: 2,
    inactive: 2,
    failed: 1,
    services: 3,
    timers: 1,
    enabled: 2,
    disabled: 1
  },
  sampledAt: "2026-09-24T09:27:56.000Z"
};

describe("SystemServicesDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders header, visual distribution bar, filter pills and unit rows", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const client: SystemServicesClient = { listSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    expect(screen.getByText("Loading system services…")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "System services" })).toBeTruthy();
    });

    const filterGroup = within(screen.getByRole("radiogroup", { name: "Service filters" }));

    // Summary filter pills are rendered and interactive
    expect(filterGroup.getByRole("button", { name: /4 units/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /2 active/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /2 inactive/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /1 failed/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /3 services/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /1 timers/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /2 enabled/i })).toBeTruthy();
    expect(filterGroup.getByRole("button", { name: /1 disabled/i })).toBeTruthy();

    // Table rows are rendered
    expect(screen.getByText("space-api.service")).toBeTruthy();
    expect(screen.getByText("space-app-version-sync.timer")).toBeTruthy();
    expect(screen.getByText("space-deepseek-harness-relay.service")).toBeTruthy();
  });

  it("filters units when clicking filter pills", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const client: SystemServicesClient = { listSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("space-api.service")).toBeTruthy();
    });

    const filterGroup = within(screen.getByRole("radiogroup", { name: "Service filters" }));

    // Click "failed" filter pill
    const failedPill = filterGroup.getByRole("button", { name: /1 failed/i });
    fireEvent.click(failedPill);

    // Only the failed service should appear
    expect(screen.getByText("space-deepseek-harness-relay.service")).toBeTruthy();
    expect(screen.queryByText("space-api.service")).toBeNull();
    expect(screen.queryByText("space-app-version-sync.timer")).toBeNull();

    // Click "timers" filter pill
    const timersPill = filterGroup.getByRole("button", { name: /1 timers/i });
    fireEvent.click(timersPill);

    expect(screen.getByText("space-app-version-sync.timer")).toBeTruthy();
    expect(screen.queryByText("space-api.service")).toBeNull();
    expect(screen.queryByText("space-deepseek-harness-relay.service")).toBeNull();

    // Click "all units" to restore full view
    const allPill = filterGroup.getByRole("button", { name: /4 units/i });
    fireEvent.click(allPill);

    expect(screen.getByText("space-api.service")).toBeTruthy();
    expect(screen.getByText("space-app-version-sync.timer")).toBeTruthy();
  });

  it("filters units using the quick search input", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const client: SystemServicesClient = { listSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("space-api.service")).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText(/Filter by unit name, description, target/i);
    fireEvent.change(searchInput, { target: { value: "relay" } });

    expect(screen.getByText("space-deepseek-harness-relay.service")).toBeTruthy();
    expect(screen.queryByText("space-api.service")).toBeNull();
    expect(screen.queryByText("space-app-version-sync.timer")).toBeNull();

    // Clear filters button
    const clearBtn = screen.getByRole("button", { name: "Clear filters" });
    fireEvent.click(clearBtn);

    expect(screen.getByText("space-api.service")).toBeTruthy();
  });

  it("toggles unit details drawer when clicking a row", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const client: SystemServicesClient = { listSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("space-app-version-sync.timer")).toBeTruthy();
    });

    // Initially details are not visible
    expect(screen.queryByText("Activates Unit")).toBeNull();

    // Click row
    fireEvent.click(screen.getByText("space-app-version-sync.timer"));

    // Details drawer opens
    expect(screen.getByText("Activates Unit")).toBeTruthy();
    expect(screen.getByText("space-app-version-sync.service")).toBeTruthy();
    expect(screen.getByText((content) => content.includes("systemctl status space-app-version-sync.timer"))).toBeTruthy();
  });

  it("calls resetFailedSystemServices when clicking Reset Failed button", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const resetFailedSystemServices = vi.fn().mockResolvedValue({ success: true, reset: "space-*" });
    const client: SystemServicesClient = { listSystemServices, resetFailedSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reset Failed" })).toBeTruthy();
    });

    const resetBtn = screen.getByRole("button", { name: "Reset Failed" });
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(resetFailedSystemServices).toHaveBeenCalled();
    });
  });

  it("closes when pressing Escape key", async () => {
    const listSystemServices = vi.fn().mockResolvedValue(mockSnapshot);
    const client: SystemServicesClient = { listSystemServices };
    const onClose = vi.fn();

    render(<SystemServicesDialog client={client} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText("space-api.service")).toBeTruthy();
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
