import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEffectiveToolPlan, defaultToolRoutingState } from "@space/contracts";
import { AgentCapabilitiesCard } from "../src/features/agent-tools/AgentCapabilitiesCard.js";

const api = vi.hoisted(() => ({
  agentToolsCatalog: vi.fn(), agentToolsUsage: vi.fn(), applyAgentTools: vi.fn(),
  modelCapabilities: vi.fn(), effectiveToolRouting: vi.fn(), saveToolRouting: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const skill = (name: string, description: string) => ({ toolId: `skill:${name}`, kind: "SKILL", name, description, sourceRuntimeIds: ["cli:codex"] });

function setup() {
  api.agentToolsCatalog.mockResolvedValue({
    entries: [skill("space-superpowers", "Opt-in methodology."), skill("space-clipboard-ops", "Clipboard records."), { toolId: "mcp:mcp_dispatcher", kind: "MCP", name: "mcp_dispatcher", description: "Dispatcher", sourceRuntimeIds: ["cli:codex"] }],
    states: [{ toolId: "skill:space-superpowers", runtimeId: "cli:codex", enabled: true }, { toolId: "skill:space-clipboard-ops", runtimeId: "cli:codex", enabled: true }],
    runtimes: [], writableRuntimeIds: ["cli:codex"]
  });
  api.agentToolsUsage.mockResolvedValue({
    available: true, windowDays: 30, complete: true,
    skills: [
      { name: "space-clipboard-ops", uses: 28, failures: 0, lastUsedAt: "2026-10-12T10:00:00.000Z", byRuntime: { "cli:claude": 28 } },
      { name: "space-superpowers/systematic-debugging", uses: 1, failures: 0, lastUsedAt: "2026-10-09T10:00:00.000Z", byRuntime: { "cli:opencode": 1 } }
    ],
    mcp: [{ serverId: "space_ops", toolName: "space_status", calls: 4, errors: 1, lastUsedAt: "2026-10-11T09:00:00.000Z", p95Ms: 900 }],
    backends: [
      { id: "space_ops", name: "Space Ops", description: "Platform operations.", toolCount: 7, schemaBuiltAt: "2026-10-12T18:00:00.000Z", stale: false },
      { id: "playwright_pane", name: "Playwright MCP (Space pane browser)", description: "Pane browser.", toolCount: 0, schemaBuiltAt: null, stale: true }
    ]
  });
  api.applyAgentTools.mockResolvedValue({ results: [{ runtimeId: "cli:codex", files: [{ path: "/x", changed: true, action: "UPDATED" }] }] });
  return render(<AgentCapabilitiesCard />);
}

describe("AgentCapabilitiesCard", () => {
  it("lists skills by 30-day use, filters unused ones and applies an off switch for every agent", async () => {
    const view = setup();
    await waitFor(() => expect(view.container.querySelectorAll("[data-skill]").length).toBe(2));
    const rows = [...view.container.querySelectorAll("[data-skill]")].map((row) => row.getAttribute("data-skill"));
    expect(rows).toEqual(["space-clipboard-ops", "space-superpowers"]);
    expect(screen.getByText("28 uses, last 2026-10-12 (claude)")).toBeTruthy();
    // A nested sub-skill read counts for its installed bundle.
    expect(screen.getByText("1 use, last 2026-10-09 (opencode)")).toBeTruthy();
    expect(view.container.textContent).not.toContain("mcp_dispatcher");

    fireEvent.click(screen.getByRole("switch", { name: /Only unused in 30 days \(0\)/ }));
    expect(view.container.querySelectorAll("[data-skill]").length).toBe(0);
    fireEvent.click(screen.getByRole("switch", { name: /Only unused in 30 days \(0\)/ }));

    const toggle = screen.getByRole("switch", { name: "space-superpowers for every agent" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect((screen.getByRole("switch", { name: "space-superpowers for every agent" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(api.applyAgentTools).toHaveBeenCalledWith([{ toolId: "skill:space-superpowers", kind: "SKILL", scope: "NONE", runtimeIds: [] }]));
    expect(await screen.findByText("Applied to codex. New CLI sessions pick it up.")).toBeTruthy();
  });

  it("shows each tool server's cached tools, stale state and calls", async () => {
    const view = setup();
    await waitFor(() => expect(api.agentToolsUsage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Tool servers" }));
    const ops = view.container.querySelector('[data-backend="space_ops"]') as HTMLElement;
    expect(within(ops).getByText(/7 tools cached 2026-10-12 · 4 calls, 1 failed, p95 900 ms, last 2026-10-11/)).toBeTruthy();
    const pane = view.container.querySelector('[data-backend="playwright_pane"]') as HTMLElement;
    expect(pane.textContent).toContain("Tool list could not be refreshed");
    expect(pane.textContent).toContain("No calls in 30 days");
  });

  it("opens tool routing with the runtimes from the CLI catalogue", async () => {
    const state = defaultToolRoutingState();
    setup();
    api.modelCapabilities.mockResolvedValue({ state, profiles: [] });
    api.effectiveToolRouting.mockImplementation(async (runtimeId: string, modelId: string) => buildEffectiveToolPlan(state, { version: 1, runtimeId, modelId, capabilities: {} }));
    fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
    expect(await screen.findByRole("region", { name: "Tool routing" })).toBeTruthy();
    const options = [...screen.getByRole("combobox", { name: /Agent/ }).querySelectorAll("option")].map((option) => option.getAttribute("value"));
    expect(options).toContain("cli:qoder");
    expect(options).not.toContain("cli:reasonix");
    expect(options).not.toContain("cli:harness");
  });
});
