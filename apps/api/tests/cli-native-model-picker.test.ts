import { describe, expect, it, vi } from "vitest";
import { claudeModelMenu, findNativeCliModel, nativeCliCatalogModels, nativeCliConfirmedModel, nativeCliConfirmedReasoning, switchNativeCliModel, switchNativeCliReasoning, prepareNativeCliSettings } from "../src/cli-native-model-picker.js";

const model = { id: "provider/model-2", displayName: "Model Two", isDefault: false,
  defaultReasoningEffort: "none", supportedReasoningEfforts: ["none"] };

describe("native CLI model acknowledgement", () => {
  it("groups Cursor context, speed and effort variants into the families selectable by its native menu", () => {
    const models = nativeCliCatalogModels("/bin/cursor-vscode-parity",
      "gpt-5.5-low\tGPT-5.5 272K Low\ngpt-5.5-high\tGPT-5.5 1M High\ngpt-5.5-fast\tGPT-5.5 272K Medium Fast\n");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "cursor-family:gpt-5-5", displayName: "GPT-5.5", supportedReasoningEfforts: ["low", "medium", "high"] });
    expect(nativeCliConfirmedModel("GPT-5.5 Medium       Run Everything", models, "cli:cursor")).toBe(models[0]!.id);
  });
  it.each(["Model: provider/model-2", "Switched to Model Two", "Model changed to provider/model-2", "✓ Model set to Model Two"])("recognizes %s", (text) => {
    expect(nativeCliConfirmedModel(text, [model])).toBe(model.id);
  });
  it.each(["> /model provider/model-2", "❯ Model Two", "Model: provider/model-20", "Error: Model changed to Model Two", "Model Two is unavailable"])("does not treat %s as success", (text) => {
    expect(nativeCliConfirmedModel(text, [model])).toBeNull();
  });

  it("separates the native command from Enter and waits for a fresh acknowledgement", async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: ">", revision: 1 })
      .mockResolvedValueOnce({ text: "> /model provider/model-2", revision: 2 })
      .mockResolvedValue({ text: "Model changed to Model Two\n>", revision: 3 });
    await switchNativeCliModel({ model, runtimeId: "cli:grok", read, write,
      assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/model provider/model-2"], ["\r"]]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("never reports a command echo as an applied selection", async () => {
    await expect(switchNativeCliModel({ model, runtimeId: "cli:grok",
      read: async () => ({ text: "Model: other-model\n> /model provider/model-2", revision: 5 }),
      write: async () => undefined, assertCurrent: async () => undefined, wait: async () => undefined
    })).rejects.toThrow("has not confirmed");
  });

  it("stops before Enter when the session or controller changes", async () => {
    const write = vi.fn(async () => undefined);
    const assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("session changed"));
    await expect(switchNativeCliModel({ model, runtimeId: "cli:cursor",
      read: async () => ({ text: ">", revision: 1 }), write, assertCurrent, wait: async () => undefined
    })).rejects.toThrow("session changed");
    expect(write.mock.calls).toEqual([["/model Model Two"]]);
  });

  it("does not type into a running turn or approval dialog", async () => {
    for (const text of ["Esc to interrupt", "Enter to confirm", "Allow once"]) {
      const write = vi.fn();
      await expect(switchNativeCliModel({ model, runtimeId: "cli:copilot",
        read: async () => ({ text, revision: 1 }), write, assertCurrent: async () => undefined
      })).rejects.toThrow("Finish the current CLI turn or dialog");
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("selects only the visible target in a native model menu and verifies the acknowledgement", async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: ">", revision: 1 })
      .mockResolvedValueOnce({ text: "Select a model\nAlt+S session-only\n> Model One\n  Model Two", revision: 2 })
      .mockResolvedValueOnce({ text: "Select a model\nAlt+S session-only\n  Model One\n> Model Two", revision: 3 })
      .mockResolvedValue({ text: "Model: Model Two\n>", revision: 4 });
    await switchNativeCliModel({ model, runtimeId: "cli:kimi", read, write,
      assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/model provider/model-2"], ["\r"], ["Model Two"], ["\u001bs"]]);
  });

  it("filters Droid's selector, picks the level and confirms from the footer, never from an older acknowledgement", async () => {
    const droid = { id: "custom:Claude-Opus-5.5-API-credits-0", displayName: "Claude Opus 5.5 API credits", isDefault: false,
      defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      reasoningOptions: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })) };
    const footer = (model: string) => `● Model switched to Claude Opus 5.5 API credits\n Auto (Off) · all actio… ${model}\n│ >   │\n? for help`;
    const selector = (filter: string, rows: string) => `│ Select Model For This Session │\n│ ◉ Main | ○ Spec │\n│ ${filter} │\n│ │\n${rows}\n  Type search   ↑↓ focus list   Enter select`;
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: footer("GPT-6.1 Sol (High)"), revision: 1 })
      .mockResolvedValueOnce({ text: selector("Filter models...", "│ ● GPT-6.1 Sol (High) │\n│   Opus 5.5 │"), revision: 2 })
      .mockResolvedValueOnce({ text: selector("Claude Opus 5.5 API credits", "│   Claude Opus 5.5 API credits │"), revision: 3 })
      .mockResolvedValueOnce({ text: "│   Low │\n│   Medium │\n│ > High (current) │\n│   Extra high │\n│   Max │\n  Use ↑↓ to navigate, Enter to select", revision: 4 })
      .mockResolvedValue({ text: footer("Claude Opus 5.5 API credits (Extra high)"), revision: 5 });
    await switchNativeCliModel({ model: droid, effort: "xhigh", runtimeId: "cli:droid", read, write,
      readUndimmed: async () => footer("GPT-6.1 Sol (High)"), assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/model custom:Claude-Opus-5.5-API-credits-0"], ["\r"], ["Claude Opus 5.5 API credits"], ["\u001b[B\r"], ["\u001b[B\r"]]);
    expect(nativeCliConfirmedReasoning(footer("Claude Opus 5.5 API credits (Extra high)"), "cli:droid", droid)).toBe("xhigh");
    expect(nativeCliConfirmedReasoning(" Auto… Claude Opus 5.5 API credits (High)\n│ >    │", "cli:droid", droid)).toBe("high");
  });

  // Captured from droid 0.244.0 in tmux (2026-10-18).
  const opus = { id: "custom:Claude-Opus-5.5-API-credits-0", displayName: "Claude Opus 5.5 API credits", isDefault: false,
    defaultReasoningEffort: "high", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    reasoningOptions: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })) };
  const droidIdle = (footer: string) => `●  Model switched to Claude Fable 5.1\n   API credits\n\n${footer}\n╭────────────────────────────────────────╮\n│ >                                      │\n╰────────────────────────────────────────╯\n? for help                  MCP ✓ | TMUX ⧉`;

  it.each([" Auto… Claude Opus 5.5 API credits (High)", " Aut… Claude Opus 5.5 API credits (High)", " A… Claude Opus 5.5 API credits (High)",
    " Auto (… Claude Opus 5.5 API credits (High)", " … Claude Opus 5.5 API credits (High)", "Claude Opus 5.5 API credits (High)",
    " Auto (High) · allow all commands                          Claude Opus 5.5 API credits (High)"])("reads Droid's footer clipped to %s", (footer) => {
    expect(nativeCliConfirmedModel(droidIdle(footer), [opus], "cli:droid")).toBe(opus.id);
    expect(nativeCliConfirmedReasoning(droidIdle(footer), "cli:droid", opus)).toBe("high");
  });

  it("steps the current Droid model's level with Tab, which works in any pane size", async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: droidIdle(" Auto… Claude Opus 5.5 API credits (High)"), revision: 1 })
      .mockResolvedValueOnce({ text: droidIdle("Claude Opus 5.5 API credits (Extra high)"), revision: 2 })
      .mockResolvedValue({ text: droidIdle(" Auto … Claude Opus 5.5 API credits (Max)"), revision: 3 });
    await switchNativeCliReasoning({ model: opus, effort: "max", runtimeId: "cli:droid", read, write,
      assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["\t"], ["\t"]]);
  });

  it("moves to the requested row of Droid's filtered selector, whose matches keep the catalog's order", async () => {
    const opus5 = { ...model, id: "claude-opus-5", displayName: "Opus 5" };
    const selector = (rows: string[]) => ["│ Select Model For This Session          │", "│ ◉ Main | ○ Spec                        │", "│ Opus 5                                 │",
      "│                                        │", ...rows.map((row) => `│ ${row.padEnd(39)}│`), "│ Multipliers represent cost in Standard │", "╰─is US-based────────────────────────────╯"].join("\n");
    const run = async (rows: string[]) => {
      const write = vi.fn(async () => undefined);
      const read = vi.fn().mockResolvedValueOnce({ text: droidIdle(" Auto… Claude Opus 5.5 API credits (High)"), revision: 1 })
        .mockResolvedValueOnce({ text: selector([]).replace("Opus 5    ", "Filter models..."), revision: 2 })
        .mockResolvedValueOnce({ text: selector(rows), revision: 3 })
        .mockResolvedValue({ text: droidIdle(" Auto… Opus 5"), revision: 4 });
      await switchNativeCliModel({ model: opus5, runtimeId: "cli:droid", read, write, assertCurrent: async () => undefined, wait: async () => undefined });
      return write.mock.calls.slice(3);
    };
    // The first ↓ focuses the current model's row, else the first match.
    expect(await run([" Opus 5.5", " Opus 5.5 Fast Mode", " Opus 5", "●Claude Opus 5.5 API credits   ★"])).toEqual([["\u001b[B\u001b[A\r"]]);
    expect(await run([" Opus 5.5", " Opus 5.5 Fast Mode", " Opus 5", " Opus 5 Fast Mode"])).toEqual([["\u001b[B\u001b[B\u001b[B\r"]]);
  });

  it("refuses a Droid model its selector does not draw in a short pane and closes the selector", async () => {
    const short = "│ Select Model For This Session          │\n│ ◉ Main | ○ Spec                        │\n│ Claude Opus 5.5 API credits            │\n│                                        │\n│ Multipliers represent cost in Standard │\n╰─is US-based────────────────────────────╯";
    const write = vi.fn(async () => undefined);
    let revision = 1;
    const read = vi.fn().mockResolvedValueOnce({ text: droidIdle(" A… Claude Fable 5.1 API credits (High)"), revision: 1 })
      .mockImplementation(async () => ({ text: short, revision: ++revision }));
    await expect(switchNativeCliModel({ model: opus, effort: "high", runtimeId: "cli:droid", read, write,
      assertCurrent: async () => undefined, wait: async () => undefined })).rejects.toThrow(/does not show this model/);
    expect(write.mock.calls.slice(2)).toEqual([["Claude Opus 5.5 API credits"], ["\u001b"], ["\u001b"], ["\u001b"]]);
  });

  it("reads Oh My Pi's right-aligned composer hint as an empty prompt but keeps a typed draft", async () => {
    const screen = (composer: string) => ({ text: ` Connected to MCP server:\n space_dispatcher.\n\n π > ◑ GPT-6 Sol > 📁 …r-repro ▶─1%─┃1.1M─\n${composer}`, revision: 1 });
    const control = (composer: string) => ({ runtimeId: "cli:omp", read: async () => screen(composer), write: vi.fn(async () => undefined),
      assertCurrent: async () => undefined, wait: async () => undefined });
    await expect(prepareNativeCliSettings(control("╰─            ⇧⇥ to change thinking effort"))).resolves.toBeTruthy();
    await expect(prepareNativeCliSettings(control("╰─      ← to see 2 running agents"))).resolves.toBeTruthy();
    await expect(prepareNativeCliSettings(control("╰─ hello"))).rejects.toThrow(/draft/);
  });

  it("does not open Droid's model menu while its turn runs", async () => {
    const screen = { text: " ⠋ Executing...  (Press ESC to stop)\n Auto… Claude Opus 5.5 API credits (High)\n│ > Enter to steer · Ctrl+Enter to queue │", revision: 1 };
    const write = vi.fn(async () => undefined);
    await expect(prepareNativeCliSettings({ runtimeId: "cli:droid", read: async () => screen, write,
      assertCurrent: async () => undefined, wait: async () => undefined })).rejects.toThrow(/Finish the current CLI turn/);
    expect(write).not.toHaveBeenCalled();
  });

  // Captured from qodercli 1.1.58 in tmux (2026-10-18): /model <id> persists the profile default, the menu's `s` does not.
  const qoderMenu = (field: string | null, rows: string[], warn = false) => [" > /model", " Model ·  Default (4)   New (13)   Custom (4)", "────", " Overview:",
    "  · Current Model     : Claude Haiku 5.5 (API credits)", "  [+] Add custom model...", "────", `  ${field ?? "Press / to search models"}`, "────", "  Local endpoints (4)",
    ...(rows.length ? rows : ["  No models in this group."]), ...(warn ? ["  ⚠ This model is currently unavailable and cannot be selected."] : []),
    " Tab switch · Enter select · s session only · ←→ effort · space context · n add · d delete · r refresh · / search · Esc back"].join("\n");
  const searching = (field: string) => qoderMenu(field, []).replace(/ Tab switch · Enter select[^\n]*$/, " Tab switch · Enter to list · Esc cancel search");
  const qoderIdle = (name: string) => `──────\n >   Type your message or @path/to/file\n──────\n ${name} (space-gateway-claude) Model · ctx ░░░░ 0% · /etc`;
  const fable = { ...model, id: "space-gateway-claude/claude-fable-5-1", displayName: "Claude Fable 5.1 (API credits)" };

  it("lists Qoder's custom models by their -m id and switches one for this session only through its menu's search", async () => {
    expect(nativeCliCatalogModels("/opt/spaceapp/bin/qoder-vscode-parity",
      "Qwen3.8-Flash\tQwen3.8-Flash\nClaude Fable 5.1 (API credits) (space-gateway-claude/claude-fable-5-1)\tClaude Fable 5.1 (API credits) (space-gateway-claude/claude-fable-5-1)\n")
      .map(({ id, displayName }) => [id, displayName])).toEqual([["Qwen3.8-Flash", "Qwen3.8-Flash"], [fable.id, fable.displayName]]);
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: qoderIdle("Claude Haiku 5.5 (API credits)"), revision: 1 })
      .mockResolvedValueOnce({ text: qoderMenu(null, ["  ❯ Claude Haiku 5.5 (API credits) ✓      ■□□□□ Low      Anthropic"]), revision: 2 })
      .mockResolvedValueOnce({ text: searching("Search models..."), revision: 3 })
      .mockResolvedValueOnce({ text: searching(fable.displayName), revision: 4 })
      // A 42-column pane cuts the row's name without "…".
      .mockResolvedValueOnce({ text: qoderMenu(fable.displayName, ["  ❯ Claude Fable 5.    ← Low    Anthropic"]), revision: 5 })
      .mockResolvedValue({ text: ` ● Model set to Claude Fable 5.1 (API credits) (this session only)\n${qoderIdle("Claude Fable 5.1 (API credits)")}`, revision: 6 });
    await switchNativeCliModel({ model: fable, runtimeId: "cli:qoder", read, write, assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/model"], ["\r"], ["/"], [fable.displayName], ["\r"], ["s"]]);
  });

  it("offers Qoder's effort levels for Space's Claude models and sets one for this session only", async () => {
    const [qwen, claude] = nativeCliCatalogModels("/opt/spaceapp/bin/qoder-vscode-parity",
      "Qwen3.8-Flash\tQwen3.8-Flash\nClaude Fable 5.1 (API credits) (space-gateway-claude/claude-fable-5-1)\tClaude Fable 5.1 (API credits) (space-gateway-claude/claude-fable-5-1)\n");
    expect(qwen!.reasoningOptions).toEqual([]);
    expect([claude!.defaultReasoningEffort, claude!.supportedReasoningEfforts]).toEqual(["auto", ["auto", "low", "medium", "high", "xhigh", "max"]]);
    // Screens captured from qodercli 1.1.58 in tmux (2026-10-18).
    const idle = (level: string) => qoderIdle("Claude Fable 5.1 (API credits)").replace("Model · ", `Model · ${level}`);
    expect(nativeCliConfirmedReasoning(idle(""), "cli:qoder", claude)).toBe("auto");
    expect(nativeCliConfirmedReasoning(idle("Extra High · "), "cli:qoder", claude)).toBe("xhigh");
    expect(nativeCliConfirmedReasoning(" ● Reasoning effort set to default for Claude Fable 5.1 (API credits) (this session only)\n Claude Fable 5.1 (API credits) (space-…",
      "cli:qoder", claude)).toBe("auto");
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: idle(""), revision: 1 })
      .mockResolvedValue({ text: ` > /effort xhigh --session-only\n ● Reasoning effort set to xhigh for Claude Fable 5.1 (API credits) (this session only)\n${idle("Extra High · ")}`, revision: 2 });
    await switchNativeCliReasoning({ model: claude!, effort: "xhigh", runtimeId: "cli:qoder", read, write, assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/effort xhigh --session-only"], ["\r"]]);
  });

  it("searches Qoder's next tab when the current one does not list the model", async () => {
    const qwen = { ...model, id: "Qwen3.8-Flash", displayName: "Qwen3.8-Flash" };
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: qoderIdle("Claude Haiku 5.5 (API credits)"), revision: 1 })
      .mockResolvedValueOnce({ text: qoderMenu(null, ["  ❯ Claude Haiku 5.5 (API credits) ✓      ■□□□□ Low      Anthropic"]), revision: 2 })
      .mockResolvedValueOnce({ text: searching("Search models..."), revision: 3 })
      .mockResolvedValueOnce({ text: searching("Qwen3.8-Flash"), revision: 4 })
      .mockResolvedValueOnce({ text: qoderMenu("Qwen3.8-Flash", []), revision: 5 })
      .mockResolvedValueOnce({ text: qoderMenu(null, ["  ❯ Auto                     0.50x Credit"]), revision: 6 })
      .mockResolvedValueOnce({ text: searching("Search models..."), revision: 7 })
      // A narrow redraw can leave a rule's "─" in front of the search text.
      .mockResolvedValueOnce({ text: searching("Qwen3.8-Flash").replace("  Qwen3.8-Flash", " ─Qwen3.8-Flash"), revision: 8 })
      .mockResolvedValueOnce({ text: qoderMenu("Qwen3.8-Flash", ["  ❯ Qwen3.8-    ←      0.10x 0.00x Credit", "    lash    Medium"]), revision: 9 })
      .mockResolvedValue({ text: ` ● Model set to Qwen3.8-Flash (this session only)\n──────\n >   Type your message or @path/to/file\n──────\n Qwen3.8-Flash Model · ctx ░░░░ 0% · /etc`, revision: 10 });
    await switchNativeCliModel({ model: qwen, runtimeId: "cli:qoder", read, write, assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write.mock.calls).toEqual([["/model"], ["\r"], ["/"], ["Qwen3.8-Flash"], ["\r"], ["\t"], ["/"], ["Qwen3.8-Flash"], ["\r"], ["s"]]);
  });

  it("reads Qoder's YOLO composer and does not take its session-only acknowledgement for the menu", async () => {
    const yolo = (composer: string) => ({ text: ` > /model\n\n ● Model set to Claude Fable 5.1 (API credits) (this session only)\n\n                           ? for shortcuts\n──────\n YOLO Shift+Tab to Auto Mode\n──────\n ${composer}\n──────\n Claude Fable 5.1 (API credits) (space-…`, revision: 1 });
    const control = (composer: string) => {
      const write = vi.fn(async () => undefined);
      return { write, input: { runtimeId: "cli:qoder", read: async () => yolo(composer), write, assertCurrent: async () => undefined, wait: async () => undefined } };
    };
    const empty = control("*   Type your message or @path/to/file");
    await expect(prepareNativeCliSettings(empty.input)).resolves.toEqual(yolo("*   Type your message or @path/to/file"));
    expect(empty.write).not.toHaveBeenCalled();
    const draft = control("* hello world");
    await expect(prepareNativeCliSettings(draft.input)).rejects.toThrow(/draft/);
    expect(draft.write).not.toHaveBeenCalled();
  });

  it("refuses a Qoder model the account cannot use and closes the menu", async () => {
    const write = vi.fn(async () => undefined);
    const read = vi.fn().mockResolvedValueOnce({ text: qoderIdle("Claude Haiku 5.5 (API credits)"), revision: 1 })
      .mockResolvedValueOnce({ text: qoderMenu(null, ["  ❯ Claude Haiku 5.5 (API credits) ✓      ■□□□□ Low      Anthropic"]), revision: 2 })
      .mockResolvedValueOnce({ text: searching("Search models..."), revision: 3 })
      .mockResolvedValueOnce({ text: searching(fable.displayName), revision: 4 })
      .mockResolvedValue({ text: qoderMenu(fable.displayName, ["  ❯ Claude Fable 5.1 (API credits)      ■□□□□ Low      Anthropic"], true), revision: 5 });
    await expect(switchNativeCliModel({ model: fable, runtimeId: "cli:qoder", read, write, assertCurrent: async () => undefined, wait: async () => undefined }))
      .rejects.toThrow(/cannot use/);
    expect(write.mock.calls).toEqual([["/model"], ["\r"], ["/"], [fable.displayName], ["\r"], ["\u001b"], ["\u001b"], ["\u001b"]]);
  });

  it("keeps the reasoning levels Droid's wrapper lists, so its picker can change them", () => {
    expect(nativeCliCatalogModels("/opt/spaceapp/bin/droid-vscode-parity", [
      "custom:Claude-Opus-5.5-API-credits-0\tClaude Opus 5.5 API credits\tlow,medium,high,xhigh,max\thigh",
      "claude-fable-5.1\tFable 5.1\tnone,low,medium,high,xhigh,max\thigh", "auto\tAuto Model\tnone\tnone"].join("\n"))
      .map(({ id, defaultReasoningEffort, reasoningOptions }) => [id, defaultReasoningEffort, reasoningOptions?.map((option) => option.reasoningEffort)]))
      .toEqual([["custom:Claude-Opus-5.5-API-credits-0", "high", ["low", "medium", "high", "xhigh", "max"]],
        ["claude-fable-5.1", "high", ["none", "low", "medium", "high", "xhigh", "max"]], ["auto", "none", []]]);
  });

  it("reads Droid's dim placeholder as an empty prompt but keeps a typed draft", async () => {
    const screen = { text: '│ > Try "Fix all lint warnings" │\n Auto (Off) · all actions      GPT-6.1 Sol (High)', revision: 1 };
    const control = (undimmed: string) => ({ runtimeId: "cli:droid", read: async () => screen, write: async () => undefined,
      readUndimmed: async () => undimmed, assertCurrent: async () => undefined, wait: async () => undefined });
    await expect(prepareNativeCliSettings(control("│ > T │"))).resolves.toEqual(screen);
    await expect(prepareNativeCliSettings(control('│ > Try "Fix all lint warnings" │'))).rejects.toThrow(/draft/);
  });

  it.each([
    ["cli:droid", "custom:Claude-Haiku-5.5-API-credits-0", "Claude Haiku 5.5 API credits", " Auto (Off) · all ac… Claude Haiku 5.5 API credits (Medium)"],
    ["cli:droid", "gpt-6-sol", "GPT-6.1 Sol", " Auto (High) · allow edits                    GPT-6.1 Sol (High)"],
    ["cli:qoder", "space-gateway-claude/claude-opus-5-5", "Claude Opus 5.5 (API credits)", " Claude Opus 5.5 (API credits) (space-gateway-claude) Model · Extra High · ctx ░░░░ 0% · /etc"],
    ["cli:qoder", "Qwen3.8-Flash", "Qwen3.8-Flash", " Qwen3.8-Flash Model · ctx ░░░░ 0% · /etc"],
    // A 42-column pane (observed 2026-10-17) clips the autonomy part to "Auto…".
    ["cli:droid", "custom:Claude-Opus-5.5-API-credits-0", "Claude Opus 5.5 API credits", " Auto… Claude Opus 5.5 API credits (High)\n╭──────╮\n│ >    │\n╰──────╯"],
    ["cli:gemini", "gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", "⎿ Model set to Gemini 3.8 Flash (High)"],
    ["cli:kimi", "kimi-code/k3", "K3", "│ Model: K3 │"],
    ["cli:deepseek", "deepseek-flash/deepseek-v4-flash", "DeepSeek Flash", "MODEL deepseek-v4-flash   EFFORT auto"],
    ["cli:cursor", "gpt-5.3-codex-low", "Codex 5.3 Low", "Codex 5.3 Low       Run Everything"],
    ["cli:copilot", "auto", "Auto", "● Switched model to: auto"],
    ["cli:hermes", "deepseek:deepseek-v4-flash", "deepseek / deepseek-v4-flash", "· model → deepseek-v4-flash"],
    ["cli:grok", "grok-4.6", "grok-4.6", "╰──────── Grok 4.6 (high) · always-approve ─╯"],
    ["cli:omp", "google-antigravity/gemini-3.8-flash", "Gemini 3.8 Flash", "Session-only model: google-antigravity/gemini-3.8-flash. Use Alt+M or /model for roles."],
    ["cli:omp", "google-antigravity/gemini-3.8-flash", "Gemini 3.8 Flash", "π > o Gemini 3.8 Flash > /etc > $0.03 — 2%"],
    ["cli:omp", "codex-lb/gpt-5.5", "GPT-5.5", "Model set to codex-lb/gpt-5.5."]
  ])("reads the observed %s native format", (runtimeId, id, displayName, text) => {
    expect(nativeCliConfirmedModel(text, [{ ...model, id, displayName }], runtimeId)).toBe(id);
  });

  it("does not mistake another Cursor effort or an older acknowledgement for the current model", () => {
    expect(nativeCliConfirmedModel("Codex 5.3 Low       Run Everything", [{ ...model, displayName: "Codex 5.3" }], "cli:cursor")).toBeNull();
    expect(nativeCliConfirmedModel("Model: Model Two\nModel: Model Three", [model])).toBeNull();
  });
});

describe("native CLI model lookup", () => {
  const claude = nativeCliCatalogModels("/opt/spaceapp/bin/claude-vscode-parity", "sonnet\tSonnet\nopus\tOpus\nfable\tFable\nhaiku\tHaiku\n");

  it("resolves the loose names a Room Agent uses to Claude's catalog families", () => {
    for (const name of ["claude:opus", "opus", "Opus", "Opus 5.5", "claude-opus-5-5"]) expect(findNativeCliModel(claude, name, "cli:claude")?.id).toBe("claude:opus");
    expect(findNativeCliModel(claude, "claude:opus", "cli:claude")?.supportedReasoningEfforts).toContain("max");
    expect(findNativeCliModel(claude, "gpt-5.5", "cli:claude")).toBeUndefined();
    expect(findNativeCliModel(claude, "claude-opus-5-5", "cli:codex")).toBeUndefined();
  });
});

describe("native CLI catalog size", () => {
  const reasonixRow = (index: number) =>
    `openrouter/vendor/model-${index}\tModel ${index}\tlow,medium,high,max\thigh`;

  it("advertises every model the CLI returned instead of truncating the catalog", () => {
    // Reasonix now returns 300+ models, so a fixed cap silently dropped models
    // the CLI had already advertised and desynchronised the picker from the API.
    const raw = Array.from({ length: 320 }, (_, index) => reasonixRow(index)).join("\n");
    const models = nativeCliCatalogModels("/bin/deepseek-vscode-parity", raw);
    expect(models).toHaveLength(320);
    expect(models.at(-1)!.id).toBe("openrouter/vendor/model-319");
  });

  it("keeps a large advertised catalog bounded only by its real size", () => {
    const models = nativeCliCatalogModels("/bin/deepseek-vscode-parity", "openrouter/vendor/only\tOnly\tlow\thigh");
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("openrouter/vendor/only");
  });
});


describe('native CLI reasoning', () => {
  it.each([
    ['cli:deepseek', 'MODEL deepseek-v4-flash EFFORT low', 'low'],
    ['cli:kimi', 'Ask When Needed K3 thinking: high /etc', 'high'],
    ['cli:grok', 'Grok 4.6 (xhigh) · always-approve', 'xhigh'],
    ['cli:hermes', '· reasoning: medium', 'medium'],
    ['cli:cursor', 'GPT-5.5 272K Extra High       Run Everything', 'xhigh'],
    ['cli:claude', 'Set effort level to high (this session only)', 'high'],
    ['cli:claude', 'Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation', 'low'],
    ['cli:claude', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents          ○ low · /effort', 'low'],
    ['cli:claude', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to …\n                                         ◉ xhigh · /effort', 'xhigh'],
    ['cli:omp', 'π > o Gemini 3.8 Flash > /etc > $0.03 — 2%', 'minimal'],
    ['cli:omp', 'π > ◒ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'high'],
    ['cli:omp', 'π > [min] Gemini 3.8 Flash > /etc > $0.03 — 2%', 'minimal'],
    ['cli:omp', 'π > ◔ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'low'],
    ['cli:omp', 'π > ◑ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'medium'],
    ['cli:omp', 'π > ◕ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'xhigh'],
    ['cli:omp', 'π > ◉ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'max'],
    ['cli:omp', 'π > ⟳ Gemini 3.8 Flash > /etc > $0.03 — 2%', 'auto'],
  ])('reads %s acknowledgements', (runtime, screen, effort) => {
    expect(nativeCliConfirmedReasoning(screen, runtime)).toBe(effort);
    expect(nativeCliConfirmedReasoning('> /reasoning high', runtime)).toBeNull();
  });

  it('reads the Claude Code model family from its acknowledgement and startup banner', () => {
    const models = nativeCliCatalogModels('/opt/spaceapp/bin/claude-vscode-parity', 'sonnet\tSonnet\nopus\tOpus\nfable\tFable\nhaiku\tHaiku\n');
    const banner = ' ▐▛███▛█   Claude Code v2.1.296\n▝▜██████▀  Opus 5.5 with xhigh effort · API Usage Billing\n────\n❯ \n────';
    expect(nativeCliConfirmedModel(banner, models, 'cli:claude')).toBe('claude:opus');
    expect(nativeCliConfirmedModel(`${banner}\n❯ /model haiku\n  ⎿  Set model to Haiku 5.5 and saved as your default for new sessions\n❯ `, models, 'cli:claude')).toBe('claude:haiku');
    expect(nativeCliConfirmedModel('❯ /model haiku\n❯ ', models, 'cli:claude')).toBeNull();
    // Captured from Claude Code 2.1.296: the default family is Fable, and Esc on the menu keeps it.
    expect(nativeCliConfirmedModel('▝▜██████▀  Fable 5.1 with xhigh effort · Claude Team\n❯ ', models, 'cli:claude')).toBe('claude:fable');
    expect(nativeCliConfirmedModel(`${banner}\n❯ /model\n  ⎿  Kept model as Fable 5.1\n❯ `, models, 'cli:claude')).toBe('claude:fable');
    expect(nativeCliConfirmedModel(`${banner}\n❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only with medium effort\n❯ `, models, 'cli:claude')).toBe('claude:sonnet');
    // The newest family line decides, even when the catalog lacks it.
    expect(nativeCliConfirmedModel(`${banner}\n  ⎿  Set model to Fable 5.1 for this session only`, models.filter(entry => entry.id !== 'claude:fable'), 'cli:claude')).toBeNull();
  });

  it('advertises Claude pane picks under their own ids with every effort of the native menu', () => {
    const models = nativeCliCatalogModels('/opt/spaceapp/bin/claude-vscode-parity', 'sonnet\tSonnet\nopus\tOpus\nfable\tFable\nhaiku\tHaiku\n');
    expect(models.map(entry => entry.id)).toEqual(['claude:sonnet', 'claude:opus', 'claude:fable', 'claude:haiku']);
    for (const entry of models) {
      expect(entry.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(entry.defaultReasoningEffort).toBe('xhigh');
    }
  });

  it.each([
    ['  ⎿  Set model to Sonnet 5.5 for this session only with medium effort', 'medium'],
    ['▝▜██████▀  Opus 5.5 with high effort · Claude Team', 'high'],
    ['  ⏵⏵ bypass permissions on (shift+tab to cycle)                       ◈ max · /effort', 'max'],
    // The live footer outranks an older banner above it.
    ['▝▜██████▀  Opus 5.5 with high effort · Claude Team\n❯ \n  ⏵⏵ bypass permissions on        ◐ medium · /effort', 'medium'],
    // A newer /effort acknowledgement outranks an older banner when no footer is drawn.
    ['▝▜██████▀  Opus 5.5 with high effort · Claude Team\n  ⎿  Set effort level to low (this session only)\n❯ ', 'low'],
  ])('reads the Claude effort from %s', (screen, effort) => {
    expect(nativeCliConfirmedReasoning(screen, 'cli:claude')).toBe(effort);
  });

  it('does not confirm a Claude effort change that the CLI did not apply to this session', () => {
    expect(nativeCliConfirmedReasoning('Set effort level to low (not applied: CLAUDE_CODE_EFFORT still controls this session)', 'cli:claude')).toBeNull();
    expect(nativeCliConfirmedReasoning('❯ /effort low', 'cli:claude')).toBeNull();
  });

  it.each([
    ['MODEL gpt-6-astra EFFORT xhigh', 'xhigh'],
    ['effort for gpt-6-astra set to xhigh', 'xhigh'],
    ['MODEL gpt-6-astra EFFORT medium', 'medium'],
    ['MODEL gpt-6-astra EFFORT max', 'max'],
  ])('reads the Reasonix %s acknowledgement', (screen, effort) => {
    // codex-lb advertises low/medium/high/xhigh/max; xhigh is Codex's plan-mode
    // default and was previously unreadable, so the switch never confirmed.
    expect(nativeCliConfirmedReasoning(screen, 'cli:deepseek')).toBe(effort);
  });

  it('does not report an unrelated or truncated DeepSeek effort token', () => {
    expect(nativeCliConfirmedReasoning('MODEL gpt-6-astra EFFORT xhig', 'cli:deepseek')).toBeNull();
    expect(nativeCliConfirmedReasoning('MODEL gpt-6-astra EFFORT ultra', 'cli:deepseek')).toBeNull();
  });
  it('retains Gemini variant levels and Cursor implicit medium variants', () => {
    const gemini = nativeCliCatalogModels('/bin/gemini-vscode-parity', 'gemini-3.8-flash-low\tGemini Low\ngemini-3.8-flash-high\tGemini High');
    expect(gemini).toHaveLength(1);
    expect(gemini[0]).toMatchObject({defaultReasoningEffort:'high',supportedReasoningEfforts:['low','high']});
    const cursor = nativeCliCatalogModels('/bin/cursor-vscode-parity', 'gpt-5.5-none\tGPT-5.5 1M None\ngpt-5.5-medium\tGPT-5.5 1M\ngpt-5.5-high\tGPT-5.5 High');
    expect(cursor).toHaveLength(1);
    expect(cursor[0]).toMatchObject({defaultReasoningEffort:'medium',supportedReasoningEfforts:['none','medium','high']});
  });
  it('does not acknowledge reasoning from a command echo or unchanged screen', async () => {
    await expect(switchNativeCliReasoning({runtimeId:'cli:hermes',effort:'low',model:{...model,supportedReasoningEfforts:['low','high']},
      read:async()=>({text:'· reasoning: high\n> /reasoning low',revision:1}),write:async()=>{},assertCurrent:async()=>{},wait:async()=>{}})).rejects.toThrow('has not confirmed');
  });
  it('stops reasoning input when terminal control is lost', async () => {
    const write=vi.fn(async()=>{});
    const assertCurrent=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('control lost'));
    await expect(switchNativeCliReasoning({runtimeId:'cli:grok',effort:'low',model:{...model,supportedReasoningEfforts:['low','high']},
      read:async()=>({text:'Grok 4.6 (high)',revision:1}),write,assertCurrent,wait:async()=>{}})).rejects.toThrow('control lost');
    expect(write.mock.calls).toEqual([['/effort low']]);
  });
});


describe('narrow native model controls', () => {
  const control = (read: () => Promise<{text:string;revision:number}>, write = vi.fn(async (_data: string) => {})) =>
    ({runtimeId:'cli:kimi', read, write, assertCurrent:async()=>{}, wait:async()=>{}});
  it('closes an open Kimi menu and clears only its restored settings command', async () => {
    const read=vi.fn().mockResolvedValueOnce({text:'Select a model\nSearch: /model kimi-code/k3\nNo matches',revision:1})
      .mockResolvedValueOnce({text:'│ > /model kimi-code/k3 │',revision:2})
      .mockResolvedValue({text:'│ >                    │',revision:3});
    const input=control(read);
    await prepareNativeCliSettings(input);
    expect(input.write.mock.calls).toEqual([['\u001b'],['\u0015']]);
  });
  it.each(['│ > Write the report │','│ ❯ keep my draft │','→ Ask about the model','❯ keep my draft','Select a model\nAllow once'])('protects user input and approvals: %s', async text => {
    const input=control(async()=>({text,revision:1}));
    await expect(prepareNativeCliSettings(input)).rejects.toThrow();
    expect(input.write).not.toHaveBeenCalled();
  });
  it('does not dismiss an approval during failure cleanup', async()=>{
    const input=control(async()=>({text:'Select a model\nAllow once',revision:1}));
    await expect(switchNativeCliModel({...input,model})).rejects.toThrow();
    expect(input.write).not.toHaveBeenCalled();
  });
  it('dismisses a failed settings menu so the next selection can start cleanly', async()=>{
    const write=vi.fn(async(_s:string)=>{});
    let screen={text:'>',revision:1};
    write.mockImplementation(async data=>{if(data==='\r')screen={text:'Select a model\nNo matches',revision:2};if(data==='\u001b')screen={text:'>',revision:3};});
    await expect(switchNativeCliModel({...control(async()=>screen,write),model})).rejects.toThrow('has not confirmed');
    expect(write.mock.calls.at(-1)).toEqual(['\u001b']);
    expect(screen.text).toBe('>');
  });
  it('ignores an obsolete Cursor menu above its current composer', async()=>{
    const input={...control(async()=>({text:'Available models\nType to filter • Enter to select • Tab to edit\n→ Plan, search, build\n anything\nAuto    Run Everything\n/etc',revision:1})),runtimeId:'cli:cursor'};
    await prepareNativeCliSettings(input);
    expect(input.write).not.toHaveBeenCalled();
  });
  it('reads hard-wrapped Gemini acknowledgements and changing only their second line', async()=>{
    const gemini={...model,id:'gemini-3.8-flash-low',displayName:'Gemini 3.8 Flash (Low)'};
    const read=vi.fn().mockResolvedValueOnce({text:'  ⎿ Model set to Gemini\n    3.8 Flash (High)\n>',revision:1})
      .mockResolvedValue({text:'  ⎿ Model set to Gemini\n    3.8 Flash (Low)\n>',revision:2});
    await switchNativeCliModel({...control(read),runtimeId:'cli:gemini',model:gemini});
    expect(nativeCliConfirmedModel((await read()).text,[gemini],'cli:gemini')).toBe(gemini.id);
  });
  it('uses a complete acknowledgement when DeepSeek truncates its footer',()=>{
    const deepseek={...model,id:'deepseek-flash/deepseek-v4-flash',displayName:'DeepSeek Flash'};
    expect(nativeCliConfirmedModel('Model changed to deepseek-v4-flash\nMODEL deep…flash EFFORT auto',[deepseek],'cli:deepseek')).toBe(deepseek.id);
  });
  it('reads Cursor model and effort when its footer wraps across blank lines',()=>{
    const cursor={...model,id:'cursor-family:gpt-5-5',displayName:'GPT-5.5'};
    const text='GPT-5.  Run Everything\n  5 272K\n\n  Medium\n  /etc';
    expect(nativeCliConfirmedModel(text,[cursor],'cli:cursor')).toBe(cursor.id);
    expect(nativeCliConfirmedReasoning(text,'cli:cursor',cursor)).toBe('medium');
  });
  it('confirms Kimi reasoning from its acknowledgement when the footer is truncated',()=>{
    expect(nativeCliConfirmedReasoning('Thinking set to max\n for this session only.\n Ask When Needed K3 thi…','cli:kimi')).toBe('max');
  });
});


it('reads the exact narrow Kimi and DeepSeek acknowledgements',()=>{
  expect(nativeCliConfirmedModel('Switched to K3 with\n thinking high for this\n session only.',[{...model,id:'kimi-code/k3',displayName:'K3'}],'cli:kimi')).toBe('kimi-code/k3');
  expect(nativeCliConfirmedModel('· switched to deepseek-\nv4-flash (conversation\ncarried over; prompt\ncache resets)\nMODEL d…sh EFFORT auto',[{...model,id:'deepseek-flash/deepseek-v4-flash'}],'cli:deepseek')).toBe('deepseek-flash/deepseek-v4-flash');
});


it('does not advertise Kimi Code effort controls on the separate Legacy K3 model',()=>{
  const catalog=nativeCliCatalogModels('/bin/kimi-vscode-parity','kimi-code/k3\tK3\nlegacy/kimi-k3\tLegacy Kimi K3');
  expect(catalog[0]!.supportedReasoningEfforts).toEqual(['low','high','max']);
  expect(catalog[1]!.reasoningOptions).toEqual([]);
});


it('switches a model without effort options without opening its unsupported thinking menu', async()=>{
  const write=vi.fn();
  await switchNativeCliReasoning({runtimeId:'cli:kimi',model:{...model,reasoningOptions:[]},effort:'none',read:async()=>({text:'>',revision:1}),write,assertCurrent:async()=>{}});
  expect(write).not.toHaveBeenCalled();
});


it('reads Gemini startup settings beside the working directory without treating a menu option as current',()=>{
  const gemini={...model,id:'gemini-3.8-flash-high',displayName:'Gemini 3.8 Flash (High)'};
  expect(nativeCliConfirmedModel('Antigravity CLI 1.1.26\nGemini 3.8 Flash (High)\n/etc',[gemini],'cli:gemini')).toBe(gemini.id);
  expect(nativeCliConfirmedModel('Select model\nGemini 3.8 Flash (High)\nEnter to select',[gemini],'cli:gemini')).toBeNull();
});


it('reads the Gemini 1.1.27 footer and DeepSeek identifiers wrapped inside a word',()=>{
  expect(nativeCliConfirmedModel('accept-edits · Gemini 3.8 Flash · high',[{...model,id:'gemini-3.8-flash-high',displayName:'Gemini 3.8 Flash (High)'}],'cli:gemini')).toBe('gemini-3.8-flash-high');
  expect(nativeCliConfirmedModel('· switched to deepsee\nk-v4-flash (conversation\ncarried over; prompt\ncache resets)',[{...model,id:'deepseek-flash/deepseek-v4-flash'}],'cli:deepseek')).toBe('deepseek-flash/deepseek-v4-flash');
});
it('accepts the narrow Cursor placeholder across both lines',async()=>{
  await prepareNativeCliSettings({runtimeId:'cli:cursor',read:async()=>({text:'→ Plan, search,\n  build anything\n\nAuto  Run Everything\n/etc',revision:1}),write:async()=>{},assertCurrent:async()=>{}});
});


it('ignores Reasonix scrollbars beside narrow model and effort acknowledgements',()=>{
 const text='  · switched to    █\ndeepseek-v4-flash- █\nvision-exp         █\n(conversation      █\ncarried over;      █\nprompt cache       █\nresets)            █';
 expect(nativeCliConfirmedModel(text,[{...model,id:'deepseek-flash/deepseek-v4-flash-vision-exp'}],'cli:deepseek')).toBe('deepseek-flash/deepseek-v4-flash-vision-exp');
 expect(nativeCliConfirmedReasoning('· effort for deepse█\nek-flash set to max█\nMODEL de…FORT max','cli:deepseek')).toBe('max');
});


it('reads Hermes startup model when its banner has no space after the separator',()=>{
 expect(nativeCliConfirmedModel('│ big-pickle ·Nous Research │',[{...model,id:'opencode-zen:big-pickle',displayName:'opencode-zen / big-pickle'}],'cli:hermes')).toBe('opencode-zen:big-pickle');
});


it('reconstructs Cursor model and effort from a one-character footer column',()=>{
 const text='Run Everything\n G\n P\n T\n -\n 5\n .\n 5\n [\n 2m\n\n 2\n 7\n 2\n K\n\n M\n e\n d\n i\n u\n m\n [\n 2\n 2m\n /etc';
 expect(nativeCliConfirmedModel(text,[{...model,id:'cursor-family:gpt-5-5',displayName:'GPT-5.5'}],'cli:cursor')).toBe('cursor-family:gpt-5-5');
 expect(nativeCliConfirmedReasoning(text,'cli:cursor')).toBe('medium');
});

it('reads Cursor family, context and reasoning when every token splits at twenty-four columns',()=>{
 const cursor={...model,id:'cursor-family:gpt-5-5',displayName:'GPT-5.5'};
 const text='  GPT   Run Everything\n  -5.\n  5 2\n  72K\n\n  Med\n  ium\n  /etc';
 expect(nativeCliConfirmedModel(text,[cursor],'cli:cursor')).toBe(cursor.id);
 expect(nativeCliConfirmedReasoning(text,'cli:cursor')).toBe('medium');
 expect(nativeCliConfirmedModel(text.replace('72K','72X'),[cursor],'cli:cursor')).toBeNull();
 expect(nativeCliConfirmedModel(text.replace('5 2','6 2'),[cursor],'cli:cursor')).toBeNull();
});

it('joins Hermes model acknowledgements split beside the native scrollbar',()=>{
 const hermes={...model,id:'deepseek:deepseek-v4-pro',displayName:'deepseek / deepseek-v4-pro'};
 expect(nativeCliConfirmedModel(' · model →        ┃\n   deepseek-v4-pro ┃\n\n❯',[hermes],'cli:hermes')).toBe(hermes.id);
});

it('reads the complete Grok model and uniquely clipped effort in a twenty-column footer',()=>{
 const grok={...model,id:'grok-4.6',displayName:'grok-4.6'};
 expect(nativeCliConfirmedModel('  ╰─ Grok 4.6 (h─╯  ',[grok],'cli:grok')).toBe(grok.id);
 for(const [prefix,effort] of [['l','low'],['m','medium'],['h','high'],['xh','xhigh']]) {
  expect(nativeCliConfirmedReasoning(`  ╰─ Grok 4.6 (${prefix}─╯  `,'cli:grok')).toBe(effort);
 }
 expect(nativeCliConfirmedReasoning('╰─ Grok 4.6 (─╯','cli:grok')).toBeNull();
 expect(nativeCliConfirmedReasoning('╰─ Grok 4.6 (invalid─╯','cli:grok')).toBeNull();
 expect(nativeCliConfirmedModel('╰─ Grok 4.─╯',[grok],'cli:grok')).toBeNull();
});

it('changes Cursor reasoning when the native parameter heading wraps inside a word',async()=>{
 const cursor={...model,id:'cursor-family:gpt-5-5',displayName:'GPT-5.5',supportedReasoningEfforts:['low','medium'],reasoningOptions:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]};
 const prompt='→ Plan, search,\n  build anything\n\n';
 const menu='Type to filter •\nTab to\nedit';
 const parameters=(active:boolean)=>'GPT-5Max mode: OFF\n.5 —\nEdit\nParam\neters\n\nContext\n'+(active?'  ':'→ ')+'● 272K ✓\n  ○ 1M\n\nReasoning\n'+(active?'→ ':'  ')+'○ Low\n  ● Medium ✓\n\nEsc to go back';
 const read=vi.fn().mockResolvedValueOnce({text:prompt+'GPT-5.5 Medium  Run Everything',revision:1})
  .mockResolvedValueOnce({text:menu,revision:2})
  .mockResolvedValueOnce({text:parameters(false),revision:3})
  .mockResolvedValueOnce({text:parameters(true),revision:4})
  .mockResolvedValueOnce({text:parameters(true),revision:5})
  .mockResolvedValueOnce({text:menu,revision:6})
  .mockResolvedValue({text:prompt+'GPT-5.5 Low  Run Everything',revision:7});
 const write=vi.fn(async(_data:string)=>{});
 await switchNativeCliReasoning({runtimeId:'cli:cursor',model:cursor,effort:'low',read,write,assertCurrent:async()=>{},wait:async()=>{}});
 expect(write.mock.calls).toEqual([['/model'],['\r'],['\t'],['\u001b[B'],['\r'],['\u001b'],['\r']]);
 const recover=vi.fn().mockResolvedValueOnce({text:parameters(false),revision:1}).mockResolvedValue({text:prompt+'GPT-5.5 Low  Run Everything',revision:2});
 write.mockClear();
 await prepareNativeCliSettings({runtimeId:'cli:cursor',read:recover,write,assertCurrent:async()=>{},wait:async()=>{}});
 expect(write.mock.calls).toEqual([['\u001b']]);
});

it('switches OMP model and reasoning together via /switch', async () => {
  const ompModel = {
    ...model,
    id: 'google-antigravity/gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    defaultReasoningEffort: 'minimal',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high']
  };
  const promptBefore = 'π > /etc > $0.00\n';
  const promptAfter = 'π > /switch google-antigravity/gemini-3.8-flash:minimal\nSession-only model: google-antigravity/gemini-3.8-flash. Use Alt+M or /model for roles.\nπ > o Gemini 3.8 Flash > /etc > $0.03 — 2%\n';
  const read = vi.fn()
    .mockResolvedValueOnce({ text: promptBefore, revision: 1 })
    .mockResolvedValue({ text: promptAfter, revision: 2 });
  const write = vi.fn(async (_data: string) => {});
  await switchNativeCliModel({
    runtimeId: 'cli:omp',
    model: ompModel,
    effort: 'minimal',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  });
  expect(write.mock.calls).toEqual([
    ['/switch google-antigravity/gemini-3.8-flash:minimal'],
    ['\r']
  ]);
});

it('switches OMP reasoning when model is already active', async () => {
  const ompModel = {
    ...model,
    id: 'google-antigravity/gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    defaultReasoningEffort: 'minimal',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high']
  };
  const promptBefore = 'π > o Gemini 3.8 Flash > /etc > $0.03 — 2%\n';
  const promptAfter = 'π > /switch google-antigravity/gemini-3.8-flash:high\nSession-only model: google-antigravity/gemini-3.8-flash. Use Alt+M or /model for roles.\nπ > ◒ Gemini 3.8 Flash > /etc > $0.03 — 2%\n';
  const read = vi.fn()
    .mockResolvedValueOnce({ text: promptBefore, revision: 1 })
    .mockResolvedValue({ text: promptAfter, revision: 2 });
  const write = vi.fn(async (_data: string) => {});
  await switchNativeCliModel({
    runtimeId: 'cli:omp',
    model: ompModel,
    effort: 'high',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  });
  expect(write.mock.calls).toEqual([
    ['/switch google-antigravity/gemini-3.8-flash:high'],
    ['\r']
  ]);
});

it('clears previous /switch draft in OMP with \\u0015', async () => {
  const write = vi.fn(async (_data: string) => {});
  const read = vi.fn()
    .mockResolvedValueOnce({ text: 'π > 📁 /etc\n╰─ /switch codex-lb/gpt-6-astra:low\n', revision: 1 })
    .mockResolvedValue({ text: 'π > 📁 /etc\n╰─ \n', revision: 2 });
  await prepareNativeCliSettings({
    runtimeId: 'cli:omp',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  });
  expect(write).toHaveBeenCalledWith('\u0015');
});

it('protects user prompt drafts in OMP from being overwritten', async () => {
  const write = vi.fn(async (_data: string) => {});
  const read = vi.fn().mockResolvedValue({ text: 'π > 📁 /etc\n╰─ please explain this codebase\n', revision: 1 });
  await expect(prepareNativeCliSettings({
    runtimeId: 'cli:omp',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  })).rejects.toThrow('Send or clear the current CLI draft');
  expect(write).not.toHaveBeenCalled();
});

it('reads multiline wrapped Session-only model acknowledgement in narrow terminal', () => {
  const ompModel = {
    ...model,
    id: 'google-antigravity/gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash'
  };
  const narrowText = `
 Update Available                       
 New version 18.2.1 is available. Run:  
 omp update                             
────────────────────────────────────────

 Session-only model:                    
 google-antigravity/gemini-3.8-flash.   
 Use alt+m or /model for roles.         

 π > 📁 /etc ▶─2%─────────────────┃──1M─
╰─                                      
`;
  expect(nativeCliConfirmedModel(narrowText, [ompModel], 'cli:omp')).toBe(ompModel.id);
});

it('submits OMP /switch with second enter when autocomplete dropdown intercepts first enter', async () => {
  const ompModel = {
    ...model,
    id: 'google-antigravity/gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    defaultReasoningEffort: 'minimal',
    supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high']
  };
  const beforeText = 'π > ⟳ GPT-5.5 > 📁 /etc\n╰─ \n';
  const interceptedText = 'π > ⟳ GPT-5.5 > 📁 /etc\n╰─ /switch google-antigravity/gemini-3.8-flash:minimal\n❯ google-antigravity/gemini-3.8-flash\n';
  const confirmedNarrowText = 'Session-only model:\ngoogle-antigravity/gemini-3.8-flash.\nUse alt+m or /model for roles.\nπ > 📁 /etc ▶─2%─────┃1M─\n╰─ \n';
  const read = vi.fn()
    .mockResolvedValueOnce({ text: beforeText, revision: 1 })
    .mockResolvedValueOnce({ text: interceptedText, revision: 2 })
    .mockResolvedValue({ text: confirmedNarrowText, revision: 3 });
  const write = vi.fn(async (_data: string) => {});
  await switchNativeCliModel({
    runtimeId: 'cli:omp',
    model: ompModel,
    effort: 'minimal',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  });
  expect(write.mock.calls).toEqual([
    ['/switch google-antigravity/gemini-3.8-flash:minimal'],
    ['\r'],
    ['\r']
  ]);
});

it('switches Gemini base model appending selected effort variant to /model', async () => {
  const geminiBase = {
    ...model,
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high']
  };
  const beforeText = 'Antigravity CLI 1.1.26\nGemini 3.8 Flash (Low)\n/etc';
  const confirmedText = '⎿ Model set to Gemini 3.8 Flash (Medium)\n>';
  const read = vi.fn()
    .mockResolvedValueOnce({ text: beforeText, revision: 1 })
    .mockResolvedValue({ text: confirmedText, revision: 2 });
  const write = vi.fn(async (_data: string) => {});
  await switchNativeCliModel({
    runtimeId: 'cli:gemini',
    model: geminiBase,
    effort: 'medium',
    read,
    write,
    assertCurrent: async () => {},
    wait: async () => {}
  });
  expect(write.mock.calls).toEqual([
    ['/model gemini-3.8-flash-medium'],
    ['\r']
  ]);
  expect(nativeCliConfirmedModel(confirmedText, [geminiBase], 'cli:gemini')).toBe('gemini-3.8-flash');
  expect(nativeCliConfirmedReasoning(confirmedText, 'cli:gemini', geminiBase)).toBe('medium');
});


describe('Claude Code per-pane model selection', () => {
  const models = nativeCliCatalogModels('/opt/spaceapp/bin/claude-vscode-parity', 'sonnet\tSonnet\nopus\tOpus\nfable\tFable\nhaiku\tHaiku\n');
  const sonnet = models.find(entry => entry.id === 'claude:sonnet')!;
  const banner = ' ▐▛███▛█   Claude Code v2.1.296\n▝▜██████▀  Fable 5.1 with xhigh effort · Claude Team\n ▝▝   ▝▝   /etc\n';
  const idle = `${banner}────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)            ◉ xhigh · /effort`;
  // Captured from Claude Code 2.1.296 (/model, 120 columns).
  const menu = (highlighted: number, effort: string) => `${banner}❯ /model\n────\n  Select model\n` +
    '  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,\n  specify with --model.\n' +
    [['Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks'], ['Opus', 'Opus 5.5 · Best for everyday, complex tasks'],
      ['Fable ✔', 'Fable 5.1 · Most capable for your hardest and longest-running tasks'], ['Sonnet', 'Sonnet 5.5 · Efficient for routine tasks'],
      ['Haiku', 'Haiku 5.5 · Fastest for quick answers']]
      .map(([label, detail], index) => `  ${index + 1 === highlighted ? '❯' : ' '} ${index + 1}. ${label!.padEnd(22)} ${detail}`).join('\n') +
    `\n  ${effort} ←/→ to adjust\n  Enter to set as default · s to use this session only · Esc to cancel`;

  it('reads the rows, highlight and effort of the native model menu', () => {
    expect(claudeModelMenu(idle)).toBeNull();
    expect(claudeModelMenu(menu(3, '◉ xHigh effort'))).toEqual({
      rows: [
        { number: 1, label: 'Default (recommended)', highlighted: false }, { number: 2, label: 'Opus', highlighted: false },
        { number: 3, label: 'Fable', highlighted: true }, { number: 4, label: 'Sonnet', highlighted: false },
        { number: 5, label: 'Haiku', highlighted: false }],
      effort: 'xhigh', effortSupported: true, sessionOnly: true, searching: false, moreAbove: false, moreBelow: false, hintsVisible: true });
    expect(claudeModelMenu(menu(4, '◐ Medium effort (default)'))?.effort).toBe('medium');
    expect(claudeModelMenu(menu(4, '◈ Max effort'))?.effort).toBe('max');
  });

  it('picks the model and effort for this session only, never with Enter (which saves a shared default)', async () => {
    const screens = [
      { text: idle, revision: 1 },
      { text: menu(3, '◉ xHigh effort'), revision: 2 },
      { text: menu(4, '◉ xHigh effort'), revision: 3 },
      { text: menu(4, '● High effort'), revision: 4 },
      { text: menu(4, '◐ Medium effort (default)'), revision: 5 },
      { text: `${banner.replace('Fable 5.1 with xhigh', 'Sonnet 5.5 with medium')}❯ /model\n  ⎿  Set model to Sonnet 5.5 for this session only with medium effort\n────\n❯ \n────\n  ⏵⏵ bypass permissions on      ◐ medium · /effort`, revision: 6 }
    ];
    let index = 0;
    const writes: string[] = [];
    const write = vi.fn(async (data: string) => {
      writes.push(data);
      // The menu redraws once per key; the command text itself does not change the screen.
      if (data !== '/model') index = Math.min(index + 1, screens.length - 1);
    });
    await switchNativeCliModel({ model: sonnet, effort: 'medium', runtimeId: 'cli:claude', write,
      read: async () => screens[index]!, assertCurrent: async () => undefined, wait: async () => undefined });
    expect(writes).toEqual(['/model', '\r', '\u001b[B', '\u001b[D', '\u001b[D', 's']);
    expect(writes).not.toContain('\r\r');
  });

  it('does nothing when the pane already runs the requested model and effort', async () => {
    const write = vi.fn(async () => undefined);
    const fable = models.find(entry => entry.id === 'claude:fable')!;
    await switchNativeCliModel({ model: fable, effort: 'xhigh', runtimeId: 'cli:claude', write,
      read: async () => ({ text: idle, revision: 1 }), assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a family the account menu does not offer and closes the menu', async () => {
    const writes: string[] = [];
    let opened = false;
    const missing = { ...sonnet, id: 'claude:mythos', displayName: 'Mythos' };
    await expect(switchNativeCliModel({ model: missing, effort: 'high', runtimeId: 'cli:claude',
      write: async (data: string) => { writes.push(data); if (data === '\r') opened = true; if (data === '\u001b') opened = false; },
      read: async () => opened ? { text: menu(3, '◉ xHigh effort'), revision: 2 } : { text: idle, revision: 1 },
      assertCurrent: async () => undefined, wait: async () => undefined })).rejects.toThrow("not available in this Claude account's model menu");
    expect(writes.slice(0, 2)).toEqual(['/model', '\r']);
    expect(writes).toContain('\u001b');
    expect(writes).not.toContain('s');
  });

  // Claude Code 2.1.296 PTY captures of /model in short panes: a 63×20 pane lists a two-row window
  // ("↓" on its last row, "… +3 models" below it); after PgDn a 52×20 pane has scrolled the title away.
  const border = '▔'.repeat(32) + ' ◉ xhigh · /effort ▔';
  const window63x20 = [`${banner}`, border, '   Select model', '   Switch between Claude models. Your pick becomes the',
    '   default for new sessions. For other/previous model names,', '   specify with --model.', '',
    '   ❯ 1. Default (recommended) ✔  Use the default model', '                                 (currently Opus 5.5) ·',
    '                                 $4/$20 per Mtok', '   ↓ 2. Opus                     Opus 5.5 · Best for',
    '                                 everyday, complex tasks ·', '                                 $4/$20 per Mtok',
    '      … +3 models', '', '   ◉ xHigh effort ←/→ to adjust', '', '   Enter to set as default · s to use this session only ·',
    '   Esc to cancel'].join('\n');
  const paged52x20 = ['', '  ⎿  Kept model as Opus 5.5 (default)', border, '   other/previous model names, specify with       ↑', '   --model.', '',
    '   ❯ 1. Default (recommended) ✔  Use the default', '                                 model (currently', '                                 Opus 5.5) ·',
    '                                 $4/$20 per Mtok', '   ↓ 2. Opus                     Opus 5.5 · Best', '                                 for everyday,',
    '                                 complex tasks ·', '                                 $4/$20 per Mtok', '      … +3 models', '',
    '   ◉ xHigh effort ←/→ to adjust', '', '   Enter to set as default · s to use this', '   session only · Esc to cancel'].join('\n');

  it('reads the window of rows a short pane shows, also after PgDn scrolled the title away', () => {
    expect(claudeModelMenu(window63x20)).toEqual({
      rows: [{ number: 1, label: 'Default (recommended)', highlighted: true }, { number: 2, label: 'Opus', highlighted: false }],
      effort: 'xhigh', effortSupported: true, sessionOnly: true, searching: false, moreAbove: false, moreBelow: true, hintsVisible: true });
    expect(claudeModelMenu(paged52x20)).toMatchObject({ rows: [{ number: 1 }, { number: 2, label: 'Opus' }], effort: 'xhigh',
      sessionOnly: true, moreBelow: true, hintsVisible: true });
    const scrolled = window63x20.replace('❯ 1. Default (recommended) ✔', '↑ 2. Opus                 ').replace('↓ 2. Opus    ', '❯ 3. Fable   ').replace('+3 models', '+2 models');
    expect(claudeModelMenu(scrolled)).toMatchObject({ rows: [{ number: 2, label: 'Opus' }, { number: 3, label: 'Fable', highlighted: true }],
      moreAbove: true, moreBelow: true });
    expect(claudeModelMenu(window63x20.replace(/\n   Esc to cancel$/, '                   ↓'))?.hintsVisible).toBe(false);
  });

  // Replays Claude Code's windowed menu: two visible rows, the highlight scrolling the window, PgDn
  // revealing the clipped effort line and key hints, and "s" confirming for this session only.
  const families = [['Default (recommended) ✔', 'Use the default model'], ['Opus', 'Opus 5.5 · Best for'], ['Fable', 'Fable 5.1 · Most capable'],
    ['Sonnet', 'Sonnet 5.5 · Efficient'], ['Haiku', 'Haiku 5.5 · Fastest for']] as const;
  const effortLines: Record<string, string> = { low: '○ Low effort', medium: '◐ Medium effort', high: '● High effort', xhigh: '◉ xHigh effort', max: '◈ Max effort' };
  const shortPane = (state: { highlighted: number; top: number; effort: string; clipped: boolean }) => {
    let open = false;
    let paged = false;
    let revision = 1;
    let done = '';
    const writes: string[] = [];
    const menuText = () => {
      const rows = families.slice(state.top - 1, state.top + 1).map(([label, detail], index) => {
        const number = state.top + index;
        const marker = number === state.highlighted ? '❯' : index === 0 && number > 1 ? '↑' : index === 1 && number < families.length ? '↓' : ' ';
        return `   ${marker} ${number}. ${label.padEnd(25)} ${detail}\n                                 $4/$20 per Mtok`;
      });
      const below = families.length - state.top - 1;
      return `${banner}❯ /model\n${border}\n` + (paged ? '' : '   Select model\n   Switch between Claude models. Your pick becomes the\n') +
        `   default for new sessions.\n\n${rows.join('\n')}\n` + (below > 0 ? `      … +${below} model${below === 1 ? '' : 's'}\n` : '') +
        `\n   ${effortLines[state.effort]} ←/→ to adjust` +
        (state.clipped && !paged ? '                   ↓' : '\n\n   Enter to set as default · s to use this\n   session only · Esc to cancel');
    };
    return {
      writes,
      write: async (data: string) => {
        writes.push(data);
        if (data === '/model') return;
        revision++;
        if (!open) { open = data === '\r'; return; }
        const levels = Object.keys(effortLines);
        if (data === '\u001b[B') state.highlighted = Math.min(families.length, state.highlighted + 1);
        if (data === '\u001b[A') state.highlighted = Math.max(1, state.highlighted - 1);
        state.top = Math.min(state.highlighted, Math.max(state.top, state.highlighted - 1));
        if (data === '\u001b[C' || data === '\u001b[D') state.effort = levels[levels.indexOf(state.effort) + (data === '\u001b[C' ? 1 : -1)]!;
        if (data === '\u001b[6~') paged = true;
        if (data === 's') done = `Set model to ${families[state.highlighted - 1]![1].split(' · ')[0]} for this session only with ${state.effort} effort`;
        if (data === '\u001b') done = 'Kept model as Fable 5.1';
        if (data === 's' || data === '\u001b') open = false;
      },
      read: async () => ({ revision, text: open ? menuText() : done ? `${banner}❯ /model\n  ⎿  ${done}\n────\n❯ \n────` : idle }),
      assertCurrent: async () => undefined, wait: async () => undefined
    };
  };
  const [down, up, left, pageDown] = ['\u001b[B', '\u001b[A', '\u001b[D', '\u001b[6~'];

  it('selects a family on the edge of a short pane\'s window (the "↓ 2. Opus" row)', async () => {
    const pane = shortPane({ highlighted: 1, top: 1, effort: 'xhigh', clipped: false });
    await switchNativeCliModel({ ...pane, model: models.find(entry => entry.id === 'claude:opus')!, effort: 'xhigh', runtimeId: 'cli:claude' });
    expect(pane.writes).toEqual(['/model', '\r', down, 's']);
  });

  it('scrolls to a family hidden below the window and pages to the clipped effort line and key hints', async () => {
    const pane = shortPane({ highlighted: 1, top: 1, effort: 'xhigh', clipped: true });
    await switchNativeCliModel({ ...pane, model: models.find(entry => entry.id === 'claude:haiku')!, effort: 'high', runtimeId: 'cli:claude' });
    expect(pane.writes).toEqual(['/model', '\r', down, down, down, down, pageDown, left, 's']);
  });

  it('looks above the window once nothing is hidden below it', async () => {
    const pane = shortPane({ highlighted: 5, top: 4, effort: 'xhigh', clipped: false });
    await switchNativeCliModel({ ...pane, model: models.find(entry => entry.id === 'claude:opus')!, effort: 'xhigh', runtimeId: 'cli:claude' });
    expect(pane.writes).toEqual(['/model', '\r', up, up, up, 's']);
  });

  it('refuses a family missing from every row of a windowed menu and closes it', async () => {
    const pane = shortPane({ highlighted: 1, top: 1, effort: 'xhigh', clipped: false });
    await expect(switchNativeCliModel({ ...pane, model: { ...sonnet, id: 'claude:mythos', displayName: 'Mythos' }, effort: 'high', runtimeId: 'cli:claude' }))
      .rejects.toThrow("not available in this Claude account's model menu");
    expect(pane.writes).toEqual(['/model', '\r', down, down, down, down, up, up, up, up, '\u001b']);
  });

  it('reports a pane too small for the menu instead of a family the account lacks', async () => {
    // 44×15: the box shows a single partial row and clips the highlight, the row count and the key hints.
    const clipped = [banner, border, '   Select model', '   Switch between Claude models. Your', '',
      '     1. Default (recommend…  Use the', '                             default   ↓'].join('\n');
    const writes: string[] = [];
    await expect(switchNativeCliModel({ model: sonnet, effort: 'low', runtimeId: 'cli:claude', write: async (data: string) => { writes.push(data); },
      read: async () => writes.length < 2 ? { text: idle, revision: 1 } : { text: clipped, revision: 1 + writes.length },
      assertCurrent: async () => undefined, wait: async () => undefined })).rejects.toThrow('does not fit this pane');
    expect(writes).not.toContain('s');
  });

  it('closes a model menu whose title PgDn scrolled away before changing settings', async () => {
    let screen = paged52x20;
    const write = vi.fn(async (data: string) => { if (data === '\u001b') screen = idle; });
    await prepareNativeCliSettings({ runtimeId: 'cli:claude', read: async () => ({ text: screen, revision: 1 }), write,
      assertCurrent: async () => undefined, wait: async () => undefined });
    expect(write).toHaveBeenCalledWith('\u001b');
  });

  it('treats a faint prompt suggestion as an empty composer but keeps a typed draft', async () => {
    const suggestion = { text: `${banner}────\n❯ run the tests\n────`, revision: 1 };
    const control = (undimmed: string) => ({ runtimeId: 'cli:claude', read: async () => suggestion, write: vi.fn(async () => undefined),
      assertCurrent: async () => undefined, wait: async () => undefined, readUndimmed: async () => undimmed });
    await expect(prepareNativeCliSettings(control(`${banner}────\n❯\n────`))).resolves.toEqual(suggestion);
    await expect(prepareNativeCliSettings(control(suggestion.text))).rejects.toThrow('Send or clear the current CLI draft');
    await expect(prepareNativeCliSettings({ ...control(''), readUndimmed: undefined })).rejects.toThrow('Send or clear the current CLI draft');
  });
});
