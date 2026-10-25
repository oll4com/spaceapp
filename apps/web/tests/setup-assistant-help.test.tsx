import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstSetupWizard, type FirstSetupClient } from "../src/features/setup-connections/FirstSetupWizard.js";
import type { SetupAssistantResponse } from "../src/features/setup-connections/SetupAssistantHelp.js";
import { SETUP_CATALOG } from "@space/contracts";

afterEach(cleanup);
function client(): FirstSetupClient {
  return {
    getSetupCatalog: async () => ({ features: SETUP_CATALOG.map(feature => ({ ...feature, availability: "AVAILABLE" as const, reasonCode: null })) }),
    getSetupDraft: async () => ({ id: null, ownerId: "user:owner", revision: null, persona: "everyday", level: "minimal", requestedFeatureIds: [], connectionChoices: [], catalogVersion: "first-setup-v2.0" }),
    getCurrentSetup: async () => ({ run: null, plan: null, tasks: [] })
  } as unknown as FirstSetupClient;
}
describe("persistent wizard assistant help", () => {
  it("aborts a pending answer on close and ignores its late result", async () => {
    const api = client(); let signal: AbortSignal | undefined; let resolve!: (value: SetupAssistantResponse) => void;
    api.askSetupAssistant = vi.fn((_question: string, requestSignal?: AbortSignal) => {
      signal = requestSignal; return new Promise<SetupAssistantResponse>(done => { resolve = done; });
    });
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask setup assistant" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Setup question" }), { target: { value: "Help" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask OpenCode" }));
    fireEvent.click(screen.getByRole("button", { name: "Close assistant help" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ available: true, modelId: "opencode/free", message: "Late answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask setup assistant" }));
    expect(screen.queryByText("Late answer")).toBeNull();
  });
  it("clears obvious credentials and refuses to send them to the assistant", async () => {
    const api = client(); api.askSetupAssistant = vi.fn();
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask setup assistant" }));
    const field = screen.getByRole("textbox", { name: "Setup question" });
    fireEvent.change(field, { target: { value: "password=private-fixture-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask OpenCode" }));
    expect(api.askSetupAssistant).not.toHaveBeenCalled();
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("status").textContent).toContain("dedicated connection forms");
  });
  it("opens keyboard-accessible help and displays a real response without saving the question locally", async () => {
    const api = client();
    api.askSetupAssistant = vi.fn(async () => ({ available: true, modelId: "opencode/fixture-free", message: "Live is optional. Use Skip Live if no provider is connected." }));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask setup assistant" }));
    const field = screen.getByRole("textbox", { name: "Setup question" });
    fireEvent.change(field, { target: { value: "Can I skip Live?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask OpenCode" }));
    expect(await screen.findByText("Live is optional. Use Skip Live if no provider is connected.")).toBeTruthy();
    expect(api.askSetupAssistant).toHaveBeenCalledWith("Can I skip Live?", expect.any(AbortSignal));
    expect((field as HTMLTextAreaElement).value).toBe("");
    expect(JSON.stringify({ ...localStorage })).not.toContain("Can I skip Live?");
    fireEvent.click(screen.getByRole("button", { name: "Close assistant help" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Ask setup assistant" }));
  });
  it("retains built-in versioned guidance when the assistant is unavailable", async () => {
    const api = client(); api.askSetupAssistant = vi.fn().mockRejectedValue(new Error("private provider failure"));
    render(<FirstSetupWizard client={api} onOpenChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask setup assistant" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Setup question" }), { target: { value: "Help me choose" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask OpenCode" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(screen.getByText(/Minimal starts with the free OpenCode assistant/)).toBeTruthy();
    expect(screen.queryByText("private provider failure")).toBeNull();
  });
});
