import { beforeEach, describe, expect, it, vi } from "vitest";

const oc = vi.hoisted(() => ({
  models: vi.fn(), current: vi.fn(), busy: vi.fn(), turnActive: vi.fn(), switchModel: vi.fn()
}));
vi.mock("@space/opencode-control", async (importOriginal) => ({
  ...await importOriginal<object>(),
  fetchOpenCodeSessionModels: oc.models,
  fetchOpenCodeCurrentModel: oc.current,
  fetchOpenCodeSessionIsTurnActive: oc.busy,
  readOpenCodeSessionTurnActive: oc.turnActive,
  switchOpenCodeSessionModel: oc.switchModel
}));
const { createOpenCodePaneModel } = await import("../src/opencode-pane-model.js");

const pane = { id: "pane:p1" } as any;
const session = { sessionId: "cli:s1", paneId: "pane:p1", cwd: "/w", isActive: true, status: "RUNNING" } as any;
const model = { id: "space-gateway/gpt-6", displayName: "GPT-6", supportedReasoningEfforts: ["default", "high"], defaultReasoningEffort: "default" } as any;

function setup(active: any = session) {
  const store = {
    getPaneCliSession: vi.fn(async () => session),
    getActivePaneCliSession: vi.fn(async () => active),
    updatePaneCliSession: vi.fn(async () => undefined),
    updatePane: vi.fn(async () => undefined)
  };
  const cliTerminalManager = {
    runSerializedTerminalMutation: (_id: string, run: () => Promise<unknown>) => run(),
    observeRoomScreen: async () => { throw new Error("no screen"); }
  };
  const resolveOpenCodeServerControl = async () => ({ nativeSessionId: "ses_1" }) as any;
  return { store, ...createOpenCodePaneModel({ store: store as any, cliTerminalManager: cliTerminalManager as any, resolveOpenCodeServerControl }) };
}

describe("OpenCode pane model", () => {
  beforeEach(() => {
    for (const fn of Object.values(oc)) fn.mockReset();
    oc.turnActive.mockResolvedValue(false);
  });

  it("refuses when the server's catalog cannot be read or offers no model", async () => {
    oc.models.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(setup().readPaneOpenCodeModelSettings(pane, session, "t"))
      .rejects.toMatchObject({ errorCode: "OPENCODE_SESSION_CONTROL_UNAVAILABLE" });
    oc.models.mockResolvedValueOnce([]);
    oc.current.mockResolvedValue(null);
    await expect(setup().readPaneOpenCodeModelSettings(pane, session, "t"))
      .rejects.toMatchObject({ errorCode: "OPENCODE_MODEL_CATALOG_UNAVAILABLE" });
  });

  it("refuses a switch OpenCode cannot take safely", async () => {
    await expect(setup().applyOpenCodePaneSelection(pane, session, model, "xhigh", "t"))
      .rejects.toThrow("This reasoning level is not advertised by OpenCode.");
    oc.turnActive.mockResolvedValueOnce(true);
    await expect(setup().applyOpenCodePaneSelection(pane, session, model, "high", "t"))
      .rejects.toThrow("Wait for the OpenCode turn to finish before changing model settings.");
    oc.turnActive.mockResolvedValueOnce(null);
    await expect(setup().applyOpenCodePaneSelection(pane, session, model, "high", "t"))
      .rejects.toThrow("OpenCode did not report whether a turn is running; try again.");
    await expect(setup({ ...session, sessionId: "cli:other" }).applyOpenCodePaneSelection(pane, session, model, "high", "t"))
      .rejects.toThrow("The OpenCode session changed during model selection.");
    oc.switchModel.mockRejectedValueOnce(new Error("400"));
    await expect(setup().applyOpenCodePaneSelection(pane, session, model, "high", "t"))
      .rejects.toThrow("OpenCode server rejected the model switch.");
  });

  it("saves only what the server confirmed", async () => {
    oc.current.mockResolvedValue({ providerID: "space-gateway", id: "gpt-5", variant: null });
    const unconfirmed = setup();
    await expect(unconfirmed.applyOpenCodePaneSelection(pane, session, model, "high", "t"))
      .rejects.toThrow("OpenCode server did not confirm the selected model.");
    expect(unconfirmed.store.updatePaneCliSession).not.toHaveBeenCalled();

    oc.current.mockResolvedValue({ providerID: "space-gateway", id: "gpt-6", variant: "high" });
    const confirmed = setup();
    await confirmed.applyOpenCodePaneSelection(pane, session, model, "high", "t");
    expect(confirmed.store.updatePaneCliSession).toHaveBeenCalledWith("cli:s1", { modelId: "space-gateway/gpt-6", reasoningEffort: "high" }, "t");
    expect(confirmed.store.updatePane).toHaveBeenCalledWith("pane:p1", { modelId: "space-gateway/gpt-6" }, "t");
  });
});
