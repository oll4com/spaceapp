import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultToolRoutingState, buildEffectiveToolPlan } from "@space/contracts";
import { ToolRoutingSettings } from "../src/features/agent-tools/ToolRoutingSettings.js";

const client = vi.hoisted(() => ({ modelCapabilities: vi.fn(), effectiveToolRouting: vi.fn(), saveToolRouting: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: client }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() {
  const state = defaultToolRoutingState();
  client.modelCapabilities.mockResolvedValue({ state, profiles: [] });
  client.effectiveToolRouting.mockImplementation(async (runtimeId, modelId) => buildEffectiveToolPlan(state, { version: 1, runtimeId, modelId, capabilities: {} }));
  client.saveToolRouting.mockImplementation(async (input) => ({ ...state, ...input, revision: 1 }));
  render(<ToolRoutingSettings />);
}
describe("routing settings", () => {
  it("saves an exact runtime/model override and distinguishes unsaved policy", async () => {
    setup();
    const select = await screen.findByLabelText("mcp:space_vision routing");
    fireEvent.change(select, { target: { value: "NATIVE_ONLY" } });
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
    await waitFor(() => expect(client.saveToolRouting).toHaveBeenCalledWith({
      expectedRevision: 0, enabledRuntimeIds: ["cli:codex", "cli:claude"], overrides: [
        { toolId: "mcp:space_vision", runtimeId: "cli:codex", modelId: "*", mode: "NATIVE_ONLY" }
      ]
    }));
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());
  });
  it("keeps a failed save editable and cannot enable an unsupported startup adapter", async () => {
    setup();
    fireEvent.change(await screen.findByLabelText("mcp:space_vision routing"), { target: { value: "DISABLED" } });
    client.saveToolRouting.mockRejectedValue(new Error("Routing policy changed; reload before saving."));
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
    expect((await screen.findByRole("alert")).textContent).toContain("reload before saving");
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "cli:opencode" } });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Other agents keep their existing configuration/)).toBeTruthy();
  });
  it("lets Claude Code start without MCP like Codex", async () => {
    setup();
    fireEvent.change(await screen.findByLabelText("Agent"), { target: { value: "cli:claude" } });
    expect((await screen.findByRole("switch", { name: "Enable capability routing for new sessions" }) as HTMLInputElement).checked).toBe(true);
    expect(await screen.findByText("At start, no tool servers are registered; agents reach Space tools on demand. Sessions already open keep their setup.")).toBeTruthy();
    expect(screen.queryByText(/Other agents keep their existing configuration/)).toBeNull();
  });
});
