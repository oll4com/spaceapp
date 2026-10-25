import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CodexThreadItem } from "@space/contracts";
import { CodexTranscript, CodexNotification, copyableCodexTranscript } from "../src/features/agent-pane/CodexTranscript.js";
import { CodexComposer } from "../src/features/agent-pane/CodexComposer.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";

describe("Codex Windows chat UI", () => {
  it("renders a ChatGPT-style dialogue with reasoning and tool work hidden", () => {
    const items: CodexThreadItem[] = [
      { id: "user", kind: "message", role: "user", content: "Please inspect", toolName: null, rawType: null, createdAt: null },
      { id: "metadata", kind: "metadata", role: "system", content: "Internal session metadata", toolName: null, rawType: null, createdAt: null },
      { id: "event", kind: "event", role: "assistant", content: "Internal queue event", toolName: null, rawType: null, createdAt: null },
      { id: "reason", kind: "reasoning", role: null, content: "Private summary", toolName: null, rawType: null, createdAt: null },
      { id: "tool", kind: "tool_call", role: null, content: "Ran shell", toolName: "shell", rawType: null, createdAt: null },
      { id: "assistant", kind: "message", role: "assistant", content: "Inspection complete", toolName: null, rawType: null, createdAt: null }
    ];
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(
      <>
        <CodexTranscript items={items} messages={[]} isRunning={false} loading={false} elapsedSeconds={0} providerName="Codex" />
        <CodexNotification tone="error" message="Turn failed" onDismiss={onDismiss} onRetry={onRetry} />
      </>
    );

    expect(screen.getByText("Please inspect").closest("article")?.classList.contains("user")).toBe(true);
    expect(screen.getByText("Inspection complete").closest("article")?.classList.contains("assistant")).toBe(true);
    expect(screen.queryByText("Internal session metadata")).toBeNull();
    expect(screen.queryByText("Internal queue event")).toBeNull();
    expect(screen.queryByText("Private summary")).toBeNull();
    expect(screen.queryByText("Ran shell")).toBeNull();
    expect(screen.queryByText("Thought for a moment")).toBeNull();
    expect(screen.queryByText("Worked with shell")).toBeNull();
    expect(screen.queryByText("Turn failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Turn failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("moves a failed technical reply into the recovery details", () => {
    const message = "Codex App Server turn timed out before completion.";
    render(<CodexTranscript items={[{ id: "failed", kind: "message", role: "assistant", content: message,
      toolName: null, rawType: null, createdAt: null }]} messages={[]} isRunning={false}
      loading={false} elapsedSeconds={0} providerName="Codex" failureMessage={message} />);
    expect(screen.queryByText(message)).toBeNull();
  });

  it("shows the empty state when a transcript contains only hidden item kinds", () => {
    render(
      <CodexTranscript
        items={[
          { id: "metadata", kind: "metadata", role: "system", content: "Hidden metadata", toolName: null, rawType: null, createdAt: null },
          { id: "event", kind: "event", role: "assistant", content: "Hidden event", toolName: null, rawType: null, createdAt: null }
        ]}
        messages={[]}
        isRunning={false}
        loading={false}
        elapsedSeconds={0}
        providerName="Codex"
      />
    );

    expect(screen.getByText("What would you like to get done?")).toBeTruthy();
    expect(screen.queryByText("Hidden metadata")).toBeNull();
    expect(screen.queryByText("Hidden event")).toBeNull();
  });

  it("sends the exact English prompt without silently applying a spelling proposal", () => {
    const onSend = vi.fn();
    const prompt = "Use a heading. Do not mention internal attachment preparation.";
    render(<CodexComposer paneTitle="Exact prompt" prompt={prompt}
      onPromptChange={vi.fn()} attachments={[]} onRemoveAttachment={vi.fn()}
      onClearAttachments={vi.fn()} onVoice={vi.fn()} voiceActive={false}
      voiceDisabled={false} isRunning={false} canSend canInterrupt={false}
      canSelectModel={false} pending={false} onSend={onSend} onStop={vi.fn()}
      modelOptions={[]} modelCatalog={[]} modelProviders={[]} selectedModelConfigId={null}
      onModelConfigChange={vi.fn(async () => null)} />);
    fireEvent.click(screen.getByRole("button", { name: "Send Exact prompt" }));
    expect(onSend).toHaveBeenCalledWith(prompt);
  });

  it("clears an immediate send before draft debounce and restores a failed send", () => {
    vi.useFakeTimers();
    let restoreFailedDraft = () => {};
    const onSend = vi.fn();
    function Harness() {
      const [prompt, setPrompt] = useState("");
      const [pending, setPending] = useState(false);
      return <CodexComposer paneTitle="Immediate" prompt={prompt}
        onPromptChange={setPrompt} attachments={[]} onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()} onVoice={vi.fn()} voiceActive={false}
        voiceDisabled={false} isRunning={false} canSend={false} canInterrupt={false}
        canSelectModel={false} pending={pending} onSend={(message) => {
          onSend(message);
          setPrompt("");
          setPending(true);
          restoreFailedDraft = () => { setPrompt(message ?? ""); setPending(false); };
        }} onStop={vi.fn()} modelOptions={[]} modelCatalog={[]} modelProviders={[]}
        selectedModelConfigId={null} onModelConfigChange={vi.fn(async () => null)} />;
    }
    try {
      render(<Harness />);
      const textarea = screen.getByRole("textbox", { name: "Message Immediate" });
      fireEvent.change(textarea, { target: { value: "Quick message" } });
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Quick message");
      expect(textarea).toHaveProperty("value", "");
      act(() => vi.advanceTimersByTime(1500));
      expect(textarea).toHaveProperty("value", "");
      act(() => restoreFailedDraft());
      expect(textarea).toHaveProperty("value", "Quick message");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts from real Goal and message actions without sending a turn", () => {
    const onSetGoal = vi.fn();
    const onSend = vi.fn();
    function Harness({ isRunning = false }: { isRunning?: boolean }) {
      const [focusRequestKey, setFocusRequestKey] = useState(0);
      return <>
        <CodexTranscript items={[]} messages={[]} isRunning={isRunning} loading={false}
          elapsedSeconds={12} providerName="Codex" onSetGoal={onSetGoal}
          onAsk={() => setFocusRequestKey((current) => current + 1)} />
        <CodexComposer paneTitle="Room Agent" prompt="" focusRequestKey={focusRequestKey}
          onPromptChange={vi.fn()} attachments={[]} onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()} onVoice={vi.fn()} voiceActive={false}
          voiceDisabled={false} isRunning={isRunning} canSend={false}
          canInterrupt={false} canSelectModel={false} pending={false}
          onSend={onSend} onStop={vi.fn()} modelOptions={[]} modelCatalog={[]}
          modelProviders={[]} selectedModelConfigId={null}
          onModelConfigChange={vi.fn(async () => null)} />
      </>;
    }
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Set a goal/i }));
    expect(onSetGoal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Ask anything/i }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message Room Agent" }));
    expect(onSend).not.toHaveBeenCalled();
    rerender(<Harness isRunning />);
    expect(screen.queryByRole("region", { name: "Start a conversation" })).toBeNull();
    expect(screen.getByText("Working on your request")).toBeTruthy();
  });

  it("keeps the existing transcript visible during a background refresh", () => {
    render(
      <CodexTranscript
        items={[
          {
            id: "assistant",
            kind: "message",
            role: "assistant",
            content: "The existing answer stays visible.",
            toolName: null,
            rawType: null,
            createdAt: null
          }
        ]}
        messages={[]}
        isRunning
        loading
        elapsedSeconds={75}
        providerName="Codex"
      />
    );

    expect(screen.getByText("The existing answer stays visible.")).toBeTruthy();
    expect(screen.queryByText("Loading task")).toBeNull();
    expect(screen.getByText("Codex is working")).toBeTruthy();
    expect(screen.getByText("1:15")).toBeTruthy();
  });

  it("renders native Codex agent_message events as assistant answers", () => {
    render(
      <CodexTranscript
        items={[
          {
            id: "assistant-event",
            kind: "event",
            role: "assistant",
            content: "The streamed answer is visible.",
            toolName: null,
            rawType: "agent_message",
            createdAt: null
          }
        ]}
        messages={[]}
        isRunning={false}
        loading={false}
        elapsedSeconds={0}
        providerName="Codex"
      />
    );

    expect(screen.getByText("The streamed answer is visible.").closest("article")?.classList.contains("assistant")).toBe(true);
  });

  it("never renders or copies internal Space action payloads", () => {
    const items: CodexThreadItem[] = [
      { id: "user", kind: "message", role: "user", content: "test", toolName: null, rawType: null, createdAt: null },
      {
        id: "assistant",
        kind: "event",
        role: "assistant",
        content: [
          "The test completed successfully.",
          "",
          "```space-chat-actions",
          '{"version":1,"actions":[{"toolId":"chat:send","action":{"type":"send","content":"Status is green."}}]}'
        ].join("\n"),
        toolName: null,
        rawType: "agent_message",
        createdAt: null
      }
    ];

    render(
      <CodexTranscript
        items={items}
        messages={[]}
        isRunning={false}
        loading={false}
        elapsedSeconds={0}
        providerName="Codex"
      />
    );

    expect(screen.getByText("The test completed successfully.")).toBeTruthy();
    expect(screen.queryByText(/space-chat-actions/)).toBeNull();
    expect(screen.queryByText(/\"toolId\":\"chat:send\"/)).toBeNull();
    expect(copyableCodexTranscript(items)).toBe("User:\ntest\n\nAssistant:\nThe test completed successfully.");
  });

  it("falls back to persisted Chat messages when no native Codex transcript exists", () => {
    render(
      <CodexTranscript
        items={[]}
        messages={[
          { id: "stored-user", role: "user", content: "Stored request", status: "COMPLETED", createdAt: null },
          { id: "stored-assistant", role: "assistant", content: "Stored OpenCode answer", status: "COMPLETED", createdAt: null }
        ]}
        isRunning={false}
        loading={false}
        elapsedSeconds={0}
        providerName="OpenCode"
      />
    );

    expect(screen.getByText("Stored request").closest("article")?.classList.contains("user")).toBe(true);
    expect(screen.getByText("Stored OpenCode answer").closest("article")?.classList.contains("assistant")).toBe(true);
  });

  it("labels running work with the selected provider", () => {
    render(
      <CodexTranscript
        items={[]}
        messages={[]}
        isRunning
        loading={false}
        elapsedSeconds={8}
        providerName="OpenCode"
      />
    );

    expect(screen.getByText("OpenCode is working")).toBeTruthy();
    expect(screen.queryByText("Codex is working")).toBeNull();
  });

  it("matches CLI typography and the shared 36px voice, model, and turn-control geometry", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toMatch(/\.codex-chat-shell \{[\s\S]*?--codex-copy-size: var\(--codex-workspace-text-size, 12px\);[\s\S]*?--codex-control-size: var\(--codex-workspace-text-size, 12px\);[\s\S]*?font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;[\s\S]*?\}/);
    expect(css).toMatch(/\.voice-input-control \{[^}]*width: 36px;[^}]*height: 36px;[^}]*border-radius: 7px;/s);
    expect(css).toMatch(/\.terminal-model-chip \{[^}]*width: 36px;[^}]*height: 36px;[^}]*border-radius: 7px;/s);
    expect(css).toMatch(/\.terminal-turn-control \{[^}]*width: 36px;[^}]*height: 36px;[^}]*border-radius: 7px;/s);
    expect(css).toMatch(/\.terminal-floating-controls > \.voice-input-control,[\s\S]*?\.terminal-floating-controls > \.terminal-model-picker > \.terminal-model-chip \{[^}]*height: 36px;[^}]*min-height: 36px;[^}]*max-height: 36px;[^}]*align-self: center;/s);
    expect(css).toMatch(/\.voice-input-control:disabled \{[^}]*opacity: 1;/s);
    expect(css).toMatch(/\.codex-chat-shell \.codex-send svg \{[^}]*width: 16px;[^}]*height: 16px;[^}]*stroke-width: 2\.25;[^}]*\}/);
  });

  it("keeps reasoning effort cards readable without horizontal popover overflow", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(css).toMatch(/\.terminal-model-popover \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
    expect(css).toMatch(/\.terminal-reasoning-options \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(8rem, 100%\), 1fr\)\);/s);
    expect(css).toMatch(/\.terminal-reasoning-options button \{[^}]*display: grid;[^}]*grid-template-areas:[^}]*"label check"[^}]*"description check";/s);
    expect(css).toMatch(/\.terminal-reasoning-options button > small \{[^}]*overflow-wrap: anywhere;[^}]*white-space: normal;/s);
  });

  it("gives the footer model picker the CLI shortcuts popover surface in every theme", () => {
    const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    expect(css).toMatch(/\.terminal-model-popover-quick \{[^}]*border-radius: var\(--shortcuts-popover-radius, 16px\);[^}]*background: var\(--room-surface-soft, var\(--room-surface, #181b1d\)\);[^}]*padding: 12px;/s);
    const themes = [["modern-theme.css", '[data-ui-theme="modern"]'], ["codex-theme.css", ':root[data-interface-theme="codex"]'], ["motion-theme.css", ':root[data-interface-theme="motion"]']] as const;
    for (const [file, theme] of themes) {
      const themeCss = readFileSync(resolve(__dirname, "../src/features/ui-theme", file), "utf8");
      const rule = themeCss.split("}").find((block) => block.includes(`${theme} .terminal-shortcuts-popover,`));
      expect(rule, file).toContain(`${theme} .terminal-model-popover-quick`);
    }
  });

  it("copies only the visible dialogue with stable role labels", () => {
    expect(copyableCodexTranscript([
      { id: "u", kind: "message", role: "user", content: "Request", toolName: null, rawType: null, createdAt: null },
      { id: "m", kind: "metadata", role: "system", content: "Secret metadata", toolName: null, rawType: null, createdAt: null },
      { id: "r", kind: "reasoning", role: null, content: "Reasoned", toolName: null, rawType: null, createdAt: null },
      { id: "t", kind: "tool_result", role: null, content: "Done", toolName: "shell", rawType: null, createdAt: null },
      { id: "a", kind: "message", role: "assistant", content: "Answer", toolName: null, rawType: null, createdAt: null }
    ])).toBe("User:\nRequest\n\nAssistant:\nAnswer");
  });

  it("copies persisted Chat messages when no native transcript exists", () => {
    expect(copyableCodexTranscript([], [
      { id: "stored-user", role: "user", content: "Request", status: "COMPLETED", createdAt: null },
      { id: "stored-system", role: "system", content: "Hidden", status: "COMPLETED", createdAt: null },
      { id: "stored-assistant", role: "assistant", content: "Answer", status: "COMPLETED", createdAt: null }
    ])).toBe("User:\nRequest\n\nAssistant:\nAnswer");
  });

  it("uses the CLI model picker and removes the legacy composer controls", async () => {
    const onModelConfigChange = vi.fn(async (modelConfigId: string) => modelConfigId);
    const onSend = vi.fn();
    const onStop = vi.fn();
    const props = {
      paneTitle: "Planner",
      prompt: "Ship it",
      onPromptChange: vi.fn(),
      attachments: [],
      onRemoveAttachment: vi.fn(),
      onClearAttachments: vi.fn(),
      onVoice: vi.fn(),
      voiceActive: false,
      voiceDisabled: false,
      isRunning: false,
      canSend: true,
      canInterrupt: true,
      canSelectModel: true,
      pending: false,
      onSend,
      onStop,
      modelOptions: [
        { id: "gpt-5.4:medium", displayName: "GPT-5.4", model: "gpt-5.4", reasoningKey: "medium", reasoningLabel: "Medium", isDefault: false },
        { id: "gpt-5.5:minimal", displayName: "GPT-5.5", model: "gpt-5.5", reasoningKey: "minimal", reasoningLabel: "Minimal", isDefault: false },
        { id: "gpt-5.5:high", displayName: "GPT-5.5", model: "gpt-5.5", reasoningKey: "high", reasoningLabel: "High", isDefault: true }
      ],
      modelCatalog: [
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Frontier model",
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: ["minimal", "high"],
          reasoningOptions: [
            { reasoningEffort: "minimal", description: "Fast" },
            { reasoningEffort: "high", description: "Thorough" }
          ]
        },
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"]
        }
      ],
      selectedModelConfigId: "gpt-5.5:high",
      modelProviders: [],
      onModelConfigChange
    };
    const { rerender } = render(<CodexComposer {...props} />);

    const modelTrigger = await screen.findByRole("button", { name: /Change model and reasoning\. Current GPT-5\.5 · High/i });
    expect(screen.getByRole("textbox", { name: "Message Planner" }).getAttribute("name")).toBe("agent-message");

    const controls = screen.getByLabelText("Agent composer controls Planner");
    expect(Array.from(controls.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "Fix keyboard layout (Alt+G) Planner",
      // Prompt variables joined the composer controls in 1e96cb29b9.
      "Prompt Variables (#) · Planner",
      "Start voice input Planner",
      expect.stringMatching(/model and reasoning/i),
      "Send Planner"
    ]);

    expect(screen.queryByRole("button", { name: "Add context" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Permission:/ })).toBeNull();
    expect(screen.queryByText("Plan", { selector: ".codex-plan-chip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Reasoning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Search" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Reasoning" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Search" })).toBeNull();

    expect(modelTrigger.classList.contains("terminal-model-chip")).toBe(true);
    fireEvent.click(modelTrigger);
    expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeTruthy();
    expect(screen.getAllByRole("option", { name: /GPT-5\.[45]/ }).map((button) => button.textContent)).toEqual(["GPT-5.5", "GPT-5.4"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt-5.4" } });
    expect(onModelConfigChange).toHaveBeenLastCalledWith("gpt-5.4:medium");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", false));

    fireEvent.click(screen.getByRole("button", { name: "Send Planner" }));
    expect(onSend).toHaveBeenCalledOnce();
    rerender(<CodexComposer {...props} pending />);
    rerender(<CodexComposer {...props} />);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message Planner" }));
    rerender(<CodexComposer {...props} isRunning />);
    fireEvent.click(screen.getByRole("button", { name: "Stop Planner" }));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(<CodexComposer {...props} />);
    expect(screen.getByRole("button", { name: "Start voice input Planner" }).getAttribute("aria-pressed")).toBe("false");
    rerender(<CodexComposer {...props} voiceActive />);
    expect(screen.getByRole("button", { name: "Stop voice input Planner" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the simple add menu and routes supported context actions", () => {
    const onAddFiles = vi.fn();
    const onSetGoal = vi.fn();
    const onVisualContext = vi.fn();
    render(<CodexComposer
      paneTitle="Room Agent" prompt="" onPromptChange={vi.fn()} attachments={[]}
      onRemoveAttachment={vi.fn()} onClearAttachments={vi.fn()}
      onVoice={vi.fn()} voiceActive={false} voiceDisabled={false}
      isRunning={false} canSend={false} canInterrupt={false} canSelectModel={false}
      pending={false} onSend={vi.fn()} onStop={vi.fn()}
      modelOptions={[]} modelCatalog={[]} modelProviders={[]} selectedModelConfigId={null}
      onModelConfigChange={vi.fn(async () => null)}
      onAddFiles={onAddFiles} onSetGoal={onSetGoal} onVisualContext={onVisualContext}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Add files or set a goal" }));
    expect(screen.getByRole("group", { name: "Add to conversation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Set a goal/ }));
    expect(onSetGoal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Add files or set a goal" }));
    fireEvent.click(screen.getByRole("button", { name: /Screen/ }));
    expect(onVisualContext).toHaveBeenCalledWith("screen");
    fireEvent.click(screen.getByRole("button", { name: "Add files or set a goal" }));
    fireEvent.click(screen.getByRole("button", { name: /Camera/ }));
    expect(onVisualContext).toHaveBeenCalledWith("camera");
    fireEvent.click(screen.getByRole("button", { name: "Add files or set a goal" }));
    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    expect(onAddFiles).toHaveBeenCalledOnce();
  });

  it("shows actual goal status without inventing milestone progress", () => {
    render(<CodexTranscript items={[]} messages={[]} isRunning={false} loading={false}
      elapsedSeconds={0} providerName="Codex" goal={{ objective: "Find three suppliers", status: "active" }} />);
    expect(screen.getByText("Find three suppliers")).toBeTruthy();
    expect(screen.getByText("Goal · active")).toBeTruthy();
    expect(screen.queryByText(/2\/4/)).toBeNull();
  });

  it("renders image thumbnails and video/file cards with independent removal and bulk clear", () => {
    const onRemoveAttachment = vi.fn();
    const onClearAttachments = vi.fn();
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <CodexComposer
          paneTitle="Media"
          prompt=""
          onPromptChange={vi.fn()}
          attachments={[
            { id: "artifact:image", kind: "IMAGE", mimeType: "image/png", byteSize: 2048, metadata: { originalFilename: "screen.png" } },
            { id: "artifact:video", kind: "VIDEO", mimeType: "video/mp4", byteSize: 4096, metadata: { originalFilename: "clip.mp4" } },
            { id: "artifact:file", kind: "EXPORT", mimeType: "text/plain", byteSize: 128, metadata: { originalFilename: "notes.txt" } }
          ]}
          onRemoveAttachment={onRemoveAttachment}
          onClearAttachments={onClearAttachments}
          onVoice={vi.fn()}
          voiceActive={false}
          voiceDisabled={false}
          isRunning={false}
          canSend
          canInterrupt={false}
          canSelectModel={false}
          pending={false}
          onSend={vi.fn()}
          onStop={vi.fn()}
          modelOptions={[]}
          modelCatalog={[]}
          modelProviders={[]}
          selectedModelConfigId={null}
          onModelConfigChange={vi.fn(async () => null)}
        />
      </SpaceRuntimeProvider>
    );

    expect(screen.getByRole("img", { name: "screen.png" }).getAttribute("src")).toBe("/api/artifacts/artifact%3Aimage/file");
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(screen.getByText("MP4 · 4,096 bytes")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Codex model unavailable Media" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment clip.mp4" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all attachments" }));
    expect(onRemoveAttachment).toHaveBeenCalledWith("artifact:video");
    expect(onClearAttachments).toHaveBeenCalledOnce();
  });

  it("disables the shared model picker when the session cannot select models", async () => {
    const props = {
      paneTitle: "Planner", prompt: "", onPromptChange: vi.fn(), attachments: [], onRemoveAttachment: vi.fn(), onClearAttachments: vi.fn(),
      onVoice: vi.fn(), voiceActive: false, voiceDisabled: false, isRunning: false,
      canSend: false, canInterrupt: false, canSelectModel: false, pending: false, onSend: vi.fn(), onStop: vi.fn(),
      modelOptions: [{ id: "model:low", displayName: "Model", model: "model", reasoningKey: "low", reasoningLabel: "Low", isDefault: true }],
      modelCatalog: [{
        id: "model", displayName: "Model", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: ["low"]
      }],
      selectedModelConfigId: "model:low", modelProviders: [], onModelConfigChange: vi.fn(async (modelConfigId: string) => modelConfigId)
    };
    const { rerender } = render(<CodexComposer {...props} />);
    const modelPicker = await screen.findByRole("button", { name: /Change model and reasoning/ });
    expect((modelPicker as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Send Planner" }).querySelector(".lucide-arrow-up")).toBeTruthy();

    rerender(<CodexComposer {...props} canSelectModel pending />);
    expect((screen.getByRole("button", { name: /Change model and reasoning/ }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<CodexComposer {...props} canSelectModel pending={false} isRunning />);
    expect((screen.getByRole("button", { name: /Change model and reasoning/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a blocked Chat session recover when its saved model is no longer in the catalog", async () => {
    const onModelConfigChange = vi.fn(async (modelConfigId: string) => modelConfigId);
    render(
      <CodexComposer
        paneTitle="Planner"
        prompt=""
        onPromptChange={vi.fn()}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onVoice={vi.fn()}
        voiceActive={false}
        voiceDisabled={false}
        isRunning={false}
        canSend={false}
        canInterrupt={false}
        canSelectModel
        pending={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        modelOptions={[
          { id: "fresh:low", displayName: "Fresh model", model: "fresh", reasoningKey: "low", reasoningLabel: "Low", isDefault: true }
        ]}
        modelCatalog={[{
          id: "fresh",
          displayName: "Fresh model",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low"]
        }]}
        modelProviders={[]}
        selectedModelConfigId={null}
        onModelConfigChange={onModelConfigChange}
      />
    );

    const picker = await screen.findByRole("button", { name: "Select model and reasoning" });
    expect((picker as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(picker);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fresh" } });

    expect(onModelConfigChange).toHaveBeenCalledWith("fresh:low");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", false));
  });

  it("maps composite model config ids through the flattened options without parsing future reasoning ids", async () => {
    const onModelConfigChange = vi.fn(async (modelConfigId: string) => modelConfigId);
    render(
      <CodexComposer
        paneTitle="Planner"
        prompt=""
        onPromptChange={vi.fn()}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onVoice={vi.fn()}
        voiceActive={false}
        voiceDisabled={false}
        isRunning={false}
        canSend={false}
        canInterrupt={false}
        canSelectModel
        pending={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        modelOptions={[
          { id: "config::vendor:model/v1::low", displayName: "Model V1", model: "vendor:model/v1", reasoningKey: "low", reasoningLabel: "Low", isDefault: true },
          { id: "config::vendor:model/v1::research", displayName: "Model V1", model: "vendor:model/v1", reasoningKey: "research", reasoningLabel: "Research", isDefault: false }
        ]}
        modelCatalog={[{
          id: "vendor:model/v1",
          displayName: "Model V1",
          isDefault: true,
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "research"]
        }]}
        modelProviders={[]}
        selectedModelConfigId="config::vendor:model/v1::low"
        onModelConfigChange={onModelConfigChange}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Change model and reasoning/ }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "1" } });
    fireEvent.pointerUp(screen.getByRole("slider"));

    expect(onModelConfigChange).toHaveBeenCalledWith("config::vendor:model/v1::research");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", false));
  });

  it("keeps an in-flight model switch open while pending and applies the server-normalized selection", async () => {
    let resolveModel!: (modelConfigId: string) => void;
    const serverSelection = new Promise<string>((resolve) => { resolveModel = resolve; });

    function Harness() {
      const [pending, setPending] = useState(false);
      const [selectedModelConfigId, setSelectedModelConfigId] = useState("model:low");
      return (
        <CodexComposer
          paneTitle="Planner"
          prompt=""
          onPromptChange={vi.fn()}
          attachments={[]}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onVoice={vi.fn()}
          voiceActive={false}
          voiceDisabled={false}
          isRunning={false}
          canSend={false}
          canInterrupt={false}
          canSelectModel
          pending={pending}
          onSend={vi.fn()}
          onStop={vi.fn()}
          modelOptions={[
            { id: "model:low", displayName: "Model", model: "model", reasoningKey: "low", reasoningLabel: "Low", isDefault: true },
            { id: "model:medium", displayName: "Model", model: "model", reasoningKey: "medium", reasoningLabel: "Medium", isDefault: false },
            { id: "model:high", displayName: "Model", model: "model", reasoningKey: "high", reasoningLabel: "High", isDefault: false }
          ]}
          modelCatalog={[{
            id: "model",
            displayName: "Model",
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: ["low", "medium", "high"]
          }]}
          modelProviders={[]}
          selectedModelConfigId={selectedModelConfigId}
          onModelConfigChange={async () => {
            setPending(true);
            const normalizedModelConfigId = await serverSelection;
            setSelectedModelConfigId(normalizedModelConfigId);
            setPending(false);
            return normalizedModelConfigId;
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: /Change model and reasoning/ }));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "2" } });
    fireEvent.pointerUp(screen.getByRole("slider"));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Model and reasoning" })).toBeTruthy());

    await act(async () => { resolveModel("model:medium"); });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveProperty("disabled", false));
    expect(screen.getByRole("button", { name: /Current Model · Medium/ })).toBeTruthy();
  });

  it("keeps the model picker usable when the selected provider has no catalog but another provider works", async () => {
    const onModelConfigChange = vi.fn(async (modelConfigId: string) => modelConfigId);
    render(
      <CodexComposer
        paneTitle="Chat 6"
        prompt=""
        onPromptChange={vi.fn()}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onVoice={vi.fn()}
        voiceActive={false}
        voiceDisabled={false}
        isRunning={false}
        canSend={false}
        canInterrupt={false}
        canSelectModel
        pending={false}
        onSend={vi.fn()}
        onStop={vi.fn()}
        modelOptions={[]}
        modelCatalog={[]}
        selectedModelConfigId={null}
        modelProviders={[{
          providerId: "cli:deepseek",
          providerName: "DeepSeek",
          configIdPrefix: "cli:deepseek-v1|",
          isCurrent: false,
          isInactive: false,
          statusReason: null,
          models: [{
            id: "deepseek-pro/deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: ["high"],
            reasoningOptions: [{ reasoningEffort: "high" }]
          }]
        }]}
        onModelConfigChange={onModelConfigChange}
      />
    );

    const picker = await screen.findByRole("button", { name: /model and reasoning/i });
    expect((picker as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Codex model unavailable Chat 6" })).toBeNull();

    fireEvent.click(picker);
    const modelSelect = await screen.findByLabelText("Model");
    // The working provider's models are offered (with the placeholder, since the pane
    // is not on a selectable model yet).
    expect(Array.from(modelSelect.querySelectorAll("option")).map((option) => option.textContent))
      .toEqual(["Select model", "DeepSeek V4 Pro"]);
  });

  it("detects wrong keyboard layout ('l;auow' -> 'λάθος'), allows Alt+G / click fix, and auto-corrects on submit", () => {
    const onPromptChange = vi.fn();
    const onSend = vi.fn();
    const { rerender } = render(
      <CodexComposer
        paneTitle="Test Pane"
        prompt=""
        onPromptChange={onPromptChange}
        attachments={[]}
        onRemoveAttachment={vi.fn()}
        onClearAttachments={vi.fn()}
        onVoice={vi.fn()}
        voiceActive={false}
        voiceDisabled={false}
        isRunning={false}
        canSend
        canInterrupt={false}
        canSelectModel={false}
        pending={false}
        onSend={onSend}
        onStop={vi.fn()}
        modelOptions={[]}
        modelCatalog={[]}
        selectedModelConfigId={null}
        modelProviders={[]}
        onModelConfigChange={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText("Message Test Pane") as HTMLTextAreaElement;

    // 1. User types mistyped Greek "l;auow"
    fireEvent.change(textarea, { target: { value: "l;auow" } });
    expect(screen.getByText(/Wrong layout\? Convert to:/i)).toBeTruthy();
    expect(screen.getByText("λάθος")).toBeTruthy();

    // 2. Click "Fix (Alt+G)" button
    const fixBtn = screen.getByRole("button", { name: "Fix (Alt+G)" });
    fireEvent.click(fixBtn);
    expect(textarea.value).toBe("λάθος");
    expect(onPromptChange).toHaveBeenCalledWith("λάθος");
    expect(screen.queryByText(/Wrong layout\? Convert to:/i)).toBeNull();

    // 3. User types "l;auow" again and uses Alt+G keyboard shortcut
    fireEvent.change(textarea, { target: { value: "l;auow" } });
    fireEvent.keyDown(textarea, { key: "g", altKey: true });
    expect(textarea.value).toBe("λάθος");

    // 4. If user types "l;auow" and submits directly, pre-send auto-correction converts it to "λάθος"
    fireEvent.change(textarea, { target: { value: "l;auow" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("λάθος");
  });
});
