import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexModelPicker, shortModelName } from "../src/features/codex-model-picker/CodexModelPicker.js";
import type { AgentPaneModelProvider, PaneCliModelSettings } from "@space/contracts";

function baseSettings(): PaneCliModelSettings {
  return {
    sessionId: "session_test",
    threadId: null,
    current: { modelId: "kimi-code/k3", reasoningEffort: "none" },
    models: [
      {
        id: "kimi-code/k3",
        displayName: "K3",
        isDefault: true,
        defaultReasoningEffort: "none",
        supportedReasoningEfforts: ["none"]
      }
    ],
    controlMode: "DIRECT",
    isTurnActive: false
  };
}

function provider(partial: Partial<AgentPaneModelProvider> & { providerId: string }): AgentPaneModelProvider {
  return {
    providerName: partial.providerId,
    configIdPrefix: `${partial.providerId}-v1|`,
    isCurrent: false,
    isInactive: false,
    statusReason: null,
    models: [],
    ...partial
  };
}

describe("CodexModelPicker provider availability", () => {
  it("shows the provider status reason inline when a provider has no usable models", async () => {
    const providers: AgentPaneModelProvider[] = [
      provider({
        providerId: "cli:kimi",
        providerName: "Kimi Code",
        isCurrent: true,
        models: [
          {
            id: "kimi-code/k3",
            displayName: "K3",
            isDefault: true,
            defaultReasoningEffort: "none",
            supportedReasoningEfforts: ["none"]
          }
        ]
      }),
      provider({
        providerId: "cli:claude",
        providerName: "Claude Code",
        statusReason: "Claude Code (Legacy) has no available tokens/quota right now."
      })
    ];
    render(
      <CodexModelPicker
        settings={baseSettings()}
        providers={providers}
        onSwitch={async () => ({ current: { modelId: "kimi-code/k3", reasoningEffort: "none" }, message: null })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /change model and reasoning/i }));
    expect(await screen.findByText("Claude Code")).toBeTruthy();
    const reason = await screen.findByText("Claude Code (Legacy) has no available tokens/quota right now.");
    expect(reason).toBeTruthy();
    const claudeOption = screen.getByRole("radio", { name: /Claude Code/ });
    expect((claudeOption as HTMLButtonElement).disabled).toBe(true);
  });
});

function quickSettings(): PaneCliModelSettings {
  return {
    ...baseSettings(),
    current: { modelId: "luna", reasoningEffort: "medium" },
    models: [
      { id: "luna", displayName: "GPT-5.6 Luna", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "max"] },
      { id: "astra", displayName: "GPT-6 Astra", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: ["high", "max"] }
    ]
  };
}

describe("CLI quick model picker", () => {
  it("allows a native CLI model selection before its current model is detected, without inventing effort controls", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    const settings: PaneCliModelSettings = { ...baseSettings(), current: null, controlMode: "NATIVE",
      models: baseSettings().models.map((model) => ({ ...model, reasoningOptions: [] })) };
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={settings} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "kimi-code/k3" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("kimi-code/k3", "none", null));
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("keeps Chat providers distinct when they advertise the same model id and routes the slider to the selected provider", async () => {
    const settings = quickSettings();
    const providers = [provider({ providerId: "one", isCurrent: true, models: settings.models }),
      provider({ providerId: "two", models: settings.models }), provider({ providerId: "offline", statusReason: "Sign in required" })];
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact settings={settings} providers={providers} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    expect(screen.getByRole("option", { name: /Sign in required/ })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "two" } });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "luna" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledWith("luna", "medium", "two"));
    const slider = screen.getByRole("slider");
    await waitFor(() => expect(slider).toHaveProperty("disabled", false));
    fireEvent.change(slider, { target: { value: "3" } });
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(onSwitch).toHaveBeenLastCalledWith("luna", "max", "two"));
  });

  it("previews effort while dragging and applies it once on release, keeping the icon compact", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
    const trigger = screen.getByRole("button", { name: /change model and reasoning/i });
    fireEvent.click(trigger);
    expect(trigger.classList.contains("is-expanded")).toBe(false);
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    fireEvent.change(slider, { target: { value: "3" } });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(slider.getAttribute("aria-valuetext")).toBe("Max");
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("luna", "max", null));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("switches models directly using the new model's supported default effort", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model and reasoning/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "astra" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("astra", "high", null));
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("astra"));
  });

  it("keeps failures visible without claiming the requested model was applied", async () => {
    render(<CodexModelPicker compact settings={quickSettings()} onSwitch={async () => { throw new Error("Model unavailable"); }} />);
    fireEvent.click(screen.getByRole("button", { name: /change model and reasoning/i }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "astra" } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Model unavailable");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("luna");
  });
});


describe('native reasoning availability', () => {
  it('hides the entire unsupported reasoning section', () => {
    const settings=baseSettings();
    settings.models[0]!.reasoningOptions=[];
    render(<CodexModelPicker compact settings={settings} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole('button',{name:/change model and reasoning/i}));
    expect(screen.queryByText('Reasoning adjustment is not available for this model.')).toBeNull();
    expect(screen.queryByText('Reasoning')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});


it('updates an open reasoning slider when the pane reports a newer native setting', async()=>{
  const settings=quickSettings();
  const onSwitch=vi.fn();
  const {rerender}=render(<CodexModelPicker compact settings={settings} onSwitch={onSwitch}/>);
  fireEvent.click(screen.getByRole('button',{name:/change model/i}));
  rerender(<CodexModelPicker compact settings={{...settings,current:{modelId:'luna',reasoningEffort:'high'}}} onSwitch={onSwitch}/>);
  await waitFor(()=>expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('High'));
  expect(onSwitch).not.toHaveBeenCalled();
});


describe("Chat catalog provider grouping and refresh", () => {
  it("groups OpenCode models by their upstream provider while preserving runtime routing and every Codex model", async () => {
    const codexModels = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini"]
      .map(id => ({ ...baseSettings().models[0]!, id, displayName: id }));
    const nativeModels = [
      ["opencode/nemotron", "Nemotron", "OpenCode Zen"],
      ["opencode-go/deepseek-v4-pro", "DeepSeek V4 Pro", "OpenCode Go"],
      ["omniroute/kiro/claude", "Kiro Claude", "OmniRoute"],
      ["deepseek/flash", "Flash", "DeepSeek"],
      ["antigravity/gemini", "Gemini", "Antigravity"],
      ["kimi-for-coding/k3", "K3", "Kimi"]
    ].map(([id, displayName, description]) => ({ ...baseSettings().models[0]!, id: id!, displayName: displayName!, description }));
    const providers = [provider({ providerId: "codex", providerName: "Codex", isCurrent: true, models: codexModels }),
      provider({ providerId: "opencode", models: nativeModels })];
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact settings={{ ...baseSettings(), models: codexModels, current: { modelId: "gpt-6-astra", reasoningEffort: "none" } }} providers={providers} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    expect(within(screen.getByRole("combobox", { name: "Model" })).getAllByRole("option")).toHaveLength(6);
    for (const name of ["OpenCode Zen", "OpenCode Go", "OmniRoute", "DeepSeek", "Antigravity", "Kimi"]) {
      expect(within(screen.getByRole("combobox", { name: "Provider" })).getByRole("option", { name })).toBeTruthy();
    }
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "opencode:opencode-go" } });
    expect(screen.queryByRole("option", { name: "Nemotron" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "opencode-go/deepseek-v4-pro" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("opencode-go/deepseek-v4-pro", "none", "opencode"));
  });

  it("refreshes a stale single-model catalog on opening and renders the full refreshed catalog", async () => {
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const full = quickSettings();
    const stale = { ...full, models: full.models.slice(0, 1) };
    const onSwitch = vi.fn();
    const { rerender } = render(<CodexModelPicker compact settings={stale} onRefreshCatalog={refresh} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("combobox")).toHaveProperty("disabled", false);
    rerender(<CodexModelPicker compact settings={full} onRefreshCatalog={refresh} onSwitch={onSwitch} />);
    finish();
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", false));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("reports refresh failure while retaining the existing catalog and retries in place", async () => {
    const refresh = vi.fn(async () => { throw new Error("offline"); });
    render(<CodexModelPicker compact settings={quickSettings()} onRefreshCatalog={refresh} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not refresh the model catalog.");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    // A catalog is already listed, so no "Refreshing models…" line flashes while it revalidates.
    expect(screen.queryByText("Refreshing models…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("names the current model on a labelled chip and explains why it is disabled", () => {
    const { rerender, container } = render(<CodexModelPicker compact showLabel settings={quickSettings()} onSwitch={vi.fn()} />);
    const chip = screen.getByRole("button", { name: /current GPT-5.6 Luna · Medium/i });
    expect(chip.querySelector(".terminal-model-chip-name")?.textContent).toBe("GPT-5.6 Luna");
    expect(chip.querySelector(".terminal-model-chip-effort")?.textContent).toBe("MED");
    rerender(<CodexModelPicker compact settings={quickSettings()} onSwitch={vi.fn()} />);
    expect(container.querySelector(".terminal-model-chip-name")).toBeNull();
    rerender(<CodexModelPicker compact showLabel disabled disabledReason="Available when the current turn finishes." settings={quickSettings()} onSwitch={vi.fn()} />);
    const disabledChip = screen.getByRole("button", { name: /Available when the current turn finishes\./ });
    expect(disabledChip.getAttribute("title")).toBe("GPT-5.6 Luna · Medium — Available when the current turn finishes.");
    expect(shortModelName("DeepSeek V4 Flash (free)")).toBe("DeepSeek V4 Flash");
    expect(shortModelName("opencode/deepseek-v4-flash-free")).toBe("deepseek-v4-flash-free");
  });

  it("keeps the chosen reasoning effort when the new model supports it", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    const settings = { ...quickSettings(), current: { modelId: "luna", reasoningEffort: "max" } };
    render(<CodexModelPicker compact settings={settings} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "astra" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("astra", "max", null));
  });

  it("falls back to the new model's default effort when the chosen one is unsupported", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "astra" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("astra", "high", null));
  });

  it("switches only after arrow-key browsing settles, or at once on Enter", async () => {
    vi.useFakeTimers();
    try {
      const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
      render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
      fireEvent.click(screen.getByRole("button", { name: /change model/i }));
      const select = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;

      fireEvent.keyDown(select, { key: "ArrowDown" });
      fireEvent.change(select, { target: { value: "astra" } });
      expect(select.value).toBe("astra");
      fireEvent.keyDown(select, { key: "ArrowUp" });
      fireEvent.change(select, { target: { value: "luna" } });
      await vi.advanceTimersByTimeAsync(600);
      // Browsing ended back on the current model, so nothing was switched.
      expect(onSwitch).not.toHaveBeenCalled();

      fireEvent.keyDown(select, { key: "ArrowDown" });
      fireEvent.change(select, { target: { value: "astra" } });
      fireEvent.keyDown(select, { key: "Enter" });
      await vi.advanceTimersByTimeAsync(0);
      expect(onSwitch).toHaveBeenCalledExactlyOnceWith("astra", "high", null);
    } finally {
      vi.useRealTimers();
    }
  });
});

 it("filters native CLI models by provider without changing their routing IDs", async () => {
   const settings = baseSettings();
   settings.models = ["opencode/free", "custom/free", "custom/vendor/model"].map(id => ({
     ...settings.models[0]!, id, displayName: id, reasoningOptions: []
   }));
   settings.current = {modelId: "opencode/free", reasoningEffort: "none"};
   const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({current: {modelId, reasoningEffort}, message: null}));
   render(<CodexModelPicker compact groupNativeProviders settings={settings} onSwitch={onSwitch}/>);
   fireEvent.click(screen.getByRole("button", {name: /change model/i}));
   fireEvent.change(screen.getByRole("combobox", {name: "Provider"}), {target: {value: ":custom"}});
   expect(screen.queryByRole("option", {name: "opencode/free"})).toBeNull();
   expect(onSwitch).not.toHaveBeenCalled();
   fireEvent.change(screen.getByRole("combobox", {name: "Model"}), {target: {value: "custom/vendor/model"}});
   await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("custom/vendor/model", "none", null));
   expect(screen.queryByText("Reasoning")).toBeNull();
 });

describe("CLI quick model picker with a large native catalog", () => {
  function largeCatalog(): PaneCliModelSettings {
    // Reasonix returns 300+ models; the picker must stay scannable and searchable
    // without dropping the model that is currently selected.
    const models = Array.from({ length: 320 }, (_, index) => ({
      id: `openrouter/vendor/model-${index}`,
      displayName: `Model ${index}`,
      isDefault: index === 0,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["high"]
    }));
    models.push({
      id: "codex-lb/gpt-6-astra",
      displayName: "GPT-6 Astra",
      isDefault: false,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
    });
    return { ...baseSettings(), controlMode: "NATIVE", current: null, models };
  }

  it("renders a bounded list and reports how many models are hidden", () => {
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={largeCatalog()} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    // 20 rendered models plus the disabled "Select model" placeholder.
    expect(screen.getAllByRole("option")).toHaveLength(21);
    expect(screen.getByRole("status").textContent).toContain("Showing 20 of 321 models");
  });

  it("searches the whole catalog instead of only the rendered page", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={largeCatalog()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    // Model 300 is far outside the first twenty rendered options.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "Model 300" } });
    expect(screen.getAllByRole("option").map(option => option.getAttribute("value")))
      .toEqual(["", "openrouter/vendor/model-300"]);
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "openrouter/vendor/model-300" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("openrouter/vendor/model-300", "high", null));
  });

  it("reaches a codex-lb xhigh model that the unbounded catalog would have buried", async () => {
    const onSwitch = vi.fn(async (modelId: string, reasoningEffort: string) => ({ current: { modelId, reasoningEffort }, message: null }));
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={largeCatalog()} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "astra" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "codex-lb/gpt-6-astra" } });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledExactlyOnceWith("codex-lb/gpt-6-astra", "xhigh", null));
  });

  it("keeps the selected model visible when it falls outside the rendered page", () => {
    const settings = largeCatalog();
    settings.current = { modelId: "openrouter/vendor/model-250", reasoningEffort: "high" };
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={settings} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /change model/i }));
    const values = screen.getAllByRole("option").map(option => option.getAttribute("value"));
    expect(values).toContain("openrouter/vendor/model-250");
  });

  it("reports an empty search instead of pretending the catalog is empty", () => {
    render(<CodexModelPicker compact allowSelectionWithoutCurrent settings={largeCatalog()} onSwitch={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Select model and reasoning" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "no-such-model" } });
    expect(screen.getByRole("option", { name: "No matching model" })).toHaveProperty("disabled", true);
  });
});

 it("keeps rapid selections responsive and applies the latest queued model and effort", async () => {
   const pending: Array<() => void> = [];
   const onSwitch = vi.fn((modelId: string, reasoningEffort: string) => new Promise<{ current: {modelId: string; reasoningEffort: string}; message: null }>(resolve => {
     pending.push(() => resolve({ current: { modelId, reasoningEffort }, message: null }));
   }));
   render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
   fireEvent.click(screen.getByRole("button", {name: /change model/i}));
   const select = screen.getByRole("combobox", {name: "Model"});
   fireEvent.change(select, {target: {value: "astra"}});
   expect(select).toHaveProperty("disabled", false);
   expect(select).toHaveProperty("value", "astra");
   const slider = screen.getByRole("slider");
   expect(slider).toHaveProperty("disabled", false);
   fireEvent.change(slider, {target: {value: "1"}});
   fireEvent.pointerUp(slider);
   fireEvent.change(select, {target: {value: "luna"}});
   fireEvent.change(slider, {target: {value: "3"}});
   fireEvent.pointerUp(slider);
   expect(onSwitch).toHaveBeenCalledTimes(1);
   expect(slider.getAttribute("aria-valuetext")).toBe("Max");
   pending.shift()!();
   await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
   expect(onSwitch).toHaveBeenLastCalledWith("luna", "max", null);
   expect(select).toHaveProperty("value", "luna");
   pending.shift()!();
   await waitFor(() => expect(screen.queryByText("Applying selection…")).toBeNull());
   expect(slider.getAttribute("aria-valuetext")).toBe("Max");
 });

 it("opening, previewing, and pressing Enter in the picker never submits or applies a draft", () => {
   const onSwitch = vi.fn();
   const submit = vi.fn();
   render(<form onSubmit={event => { event.preventDefault(); submit(); }} onKeyDown={submit}>
     <CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} /></form>);
   fireEvent.click(screen.getByRole("button", {name: /change model/i}));
   const slider = screen.getByRole("slider");
   fireEvent.change(slider, {target: {value: "3"}});
   fireEvent.keyDown(slider, {key: "Enter"});
   fireEvent.keyUp(slider, {key: "Enter"});
   expect(onSwitch).not.toHaveBeenCalled();
   expect(submit).not.toHaveBeenCalled();
 });

it("cancels a reasoning drag without applying its preview", () => {
  const onSwitch = vi.fn();
  render(<CodexModelPicker compact settings={quickSettings()} onSwitch={onSwitch} />);
  fireEvent.click(screen.getByRole("button", {name: /change model/i}));
  const slider = screen.getByRole("slider");
  fireEvent.change(slider, {target: {value: "3"}});
  fireEvent.pointerCancel(slider);
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  expect(onSwitch).not.toHaveBeenCalled();
});

describe("visible reasoning display", () => {
  it("renders a reasoning-colored frame and descriptive title on the model chip without badge", () => {
    render(<CodexModelPicker compact settings={quickSettings()} onSwitch={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /change model and reasoning/i });
    expect(trigger.getAttribute("title")).toBe("GPT-5.6 Luna · Medium");
    expect(trigger.classList.contains("has-reasoning")).toBe(true);
    expect(trigger.getAttribute("data-effort")).toBe("medium");
    expect(trigger.querySelector(".terminal-model-reasoning-badge")).toBeNull();
  });

  it("updates the reasoning effort frame when a model with high reasoning is active", () => {
    const settings: PaneCliModelSettings = {
      ...quickSettings(),
      current: { modelId: "astra", reasoningEffort: "high" }
    };
    render(<CodexModelPicker compact settings={settings} onSwitch={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /change model and reasoning/i });
    expect(trigger.getAttribute("title")).toBe("GPT-6 Astra · High");
    expect(trigger.getAttribute("data-effort")).toBe("high");
    expect(trigger.querySelector(".terminal-model-reasoning-badge")).toBeNull();
  });

  it("provides distinct progressive colors across all reasoning levels", async () => {
    const { reasoningEffortColor } = await import("../src/features/codex-model-picker/reasoning-effort.js");
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
    const colors = levels.map(level => reasoningEffortColor(level).border);
    const uniqueColors = new Set(colors);
    expect(uniqueColors.size).toBe(levels.length);
    expect(reasoningEffortColor("high").border).not.toBe(reasoningEffortColor("xhigh").border);
    expect(reasoningEffortColor("xhigh").border).not.toBe(reasoningEffortColor("max").border);
    expect(reasoningEffortColor("max").border).not.toBe(reasoningEffortColor("ultra").border);
  });
});
