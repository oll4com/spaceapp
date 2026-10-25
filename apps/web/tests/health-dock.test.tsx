import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppVersionStatus } from "../src/live-api.js";
import { createDemoFixture } from "../src/demo/demo-fixture.js";
import { HealthDock } from "../src/features/health/HealthDock.js";

const version = vi.hoisted(() => ({ current: null as AppVersionStatus | null }));
vi.mock("../src/features/app-version/use-app-version.js", () => ({ useAppVersion: () => version.current }));

type Props = ComponentProps<typeof HealthDock>;
const empty: Props = { readiness: null, mcp: null, latestSmoke: null, providers: [], models: [],
  observability: null, workerReadiness: null, storageReadiness: null };
const tile = (name: string) => screen.getByRole("article", { name: `${name} health` });
beforeEach(() => { version.current = null; });

describe("Health dock presentation", () => {
  it("shows unavailable snapshots as loading without claiming a healthy service", () => {
    render(<HealthDock {...empty} />);
    expect(within(screen.getByRole("region", { name: "Space health status" })).getAllByRole("article")).toHaveLength(7);
    expect(tile("Runtime").textContent).toContain("Runtime snapshot loading");
    expect(tile("Provider").textContent).toContain("No provider");
    expect(tile("Requests").textContent).toContain("Observability snapshot loading");
    expect(tile("Version").textContent).toContain("Version unavailable");
    expect(document.querySelectorAll(".status.ok")).toHaveLength(0);
  });

  it("keeps runtime readiness, provider verification, errors and storage distinct", () => {
    const fixture = createDemoFixture();
    const props: Props = { ...empty,
      readiness: { ok: true, dependencies: { store: "ok", runtimeStore: "postgres", eventBus: "ok",
        temporal: "ok", worker: "READY", cliHost: "ok", cliAdminHost: "ok", browserHost: "ok",
        browserHostBuildCommit: null, browserHostCaptureMetrics: null, codexTurns: "ok", codexLb: "ok" } },
      providers: [{ ...fixture.providers[0]!, displayName: "Unavailable provider", status: "ERROR" }],
      models: [{ ...fixture.models[0]!, status: "VERIFIED" }, { ...fixture.models[0]!, id: "unverified", status: "DISABLED" }],
      workerReadiness: { ...fixture.adminDiagnostics.worker, status: "RUNNING", pollerCount: 2, taskQueue: "proof" },
      observability: { ...fixture.adminDiagnostics.observability, totals: { ...fixture.adminDiagnostics.observability.totals,
        requestCount: 17, errorCount: 2, p95Ms: 8.25 } },
      storageReadiness: { ...fixture.storageReadiness, status: "WARN", statusReason: "Low space", dedicatedAppVolume: false,
        app: { ...fixture.storageReadiness.app, availableBytes: 2 * 1024 ** 3 },
        root: { ...fixture.storageReadiness.root, usedPercent: 92 } },
      mcp: { data: [], servers: [], tools: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
        gateway: { ...fixture.adminDiagnostics.mcpGateway, status: "VERIFIED", serverCount: 3, toolCount: 9 },
        dispatcher: { backendCount: 15, staleIds: ["playwright_pane"], checkedAt: "2026-10-13T04:25:32.509Z" } },
      latestSmoke: { ...fixture.adminDiagnostics.mcpDiscoverySmoke, code: "DISCOVERY_OK" }
    };
    render(<HealthDock {...props} />);
    expect(tile("Runtime").querySelector(".status.ok")?.textContent).toBe("postgres / Temporal ok");
    expect(tile("Provider").querySelector(".status.bad")?.textContent).toBe("Unavailable provider");
    expect(tile("Provider").textContent).toContain("1/2 verified models");
    expect(tile("Worker").textContent).toContain("2 pollers / proof");
    expect(tile("Requests").querySelector(".status.bad")?.textContent).toBe("17 req / p95 8.3ms");
    expect(tile("Requests").textContent).toContain("2 errors");
    expect(tile("Storage").textContent).toContain("2.0GB free / root 92% / dedicated no");
    expect(tile("Storage").querySelector(".status.warn")).toBeTruthy();
    expect(tile("MCP").textContent).toContain("3 servers / 9 tools");
    expect(tile("MCP").textContent).toContain("CLI dispatcher 15 backends, 1 stale (playwright_pane)");
    expect(tile("MCP").textContent).toContain("Discovery Ok");
  });

  it("distinguishes a missing percentile from zero and formats measured latency", () => {
    const sample = createDemoFixture().adminDiagnostics.observability;
    const { rerender } = render(<HealthDock {...empty} observability={{ ...sample, totals: { ...sample.totals, requestCount: 0, errorCount: 0, p95Ms: null } }} />);
    expect(tile("Requests").textContent).toContain("0 req / p95 n/a");
    rerender(<HealthDock {...empty} observability={{ ...sample, totals: { ...sample.totals, requestCount: 1, errorCount: 0, p95Ms: 19.7 } }} />);
    expect(tile("Requests").querySelector(".status.ok")?.textContent).toBe("1 req / p95 20ms");
  });

  it("uses supplied release metadata, dirty commit fallback and update state", () => {
    version.current = { appRelease: "2.3.4", currentCommit: "abcdef123", shortCommit: "abcdef1", currentBranch: "main",
      dirty: true, athensTag: null, githubLatest: "2.4.0", githubTagUrl: null, updateAvailable: true,
      behindCount: 1, checkedAt: "2026-10-03T12:00:00Z" };
    const { rerender } = render(<HealthDock {...empty} />);
    // An available update is a notice, not a failure.
    expect(tile("Version").querySelector(".status.warn")?.textContent).toBe("2.3.4");
    expect(tile("Version").textContent).toContain("commit abcdef1 · dirty");
    expect(tile("Version").textContent).toContain("Update available: 2.4.0");
    version.current = { ...version.current, athensTag: "release proof", updateAvailable: false };
    rerender(<HealthDock {...empty} />);
    expect(tile("Version").textContent).toContain("release proof");
    expect(tile("Version").textContent).not.toContain("commit abcdef1");
    expect(tile("Version").textContent).toContain("Up to date");
  });

  it("shows failed snapshots as unavailable and refreshes on demand", async () => {
    let finish: () => void = () => undefined;
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<HealthDock {...empty} loadError="Some health checks could not be loaded. Refresh to try again." onRefresh={onRefresh} />);
    expect(screen.getByRole("status").textContent).toContain("Some health checks could not be loaded");
    expect(tile("Storage").querySelector(".status")?.textContent).toBe("Unavailable");
    expect(screen.getByText("checks reporting", { exact: false }).textContent).toBe("0 of 6 checks reporting");
    const refresh = screen.getByRole("button", { name: "Refresh health" });
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(refresh.getAttribute("aria-busy")).toBeNull();
  });
});
