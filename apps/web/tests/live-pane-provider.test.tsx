// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { api } from "../src/api.js";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { LivePane } from "../src/features/live-pane/LivePane.js";
import * as liveSessionModule from "../src/features/live-pane/live-session.js";
import type { Pane } from "@space/contracts";

vi.mock("../src/api.js", () => ({ api: { getLivePersonalMemory: vi.fn(), updatePane: vi.fn().mockResolvedValue({}) } }));

const mockPane: Pane = {
  id: "pane:live-provider-test",
  roomId: "room:test-provider",
  title: "Live Provider Test",
  titleSource: "auto",
  mode: "LIVE",
  status: "IDLE",
  order: 0,
  isMaximized: false,
  isMinimized: false,
  providerId: null,
  modelId: null,
  reasoningEffort: "medium",
  categoryColor: null,
  columnSpan: 1,
  split: { parentId: null, direction: null, size: null },
  isClosed: false,
  cwd: null,
  vncTarget: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

describe("LivePane Provider Selection & Dynamic Config", () => {
  beforeEach(() => vi.spyOn(api, "getLivePersonalMemory").mockResolvedValue({ items: [], revision: 0 }));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  });

  it("keeps an active session alive when the pane title changes", async () => {
    const close = vi.fn();
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(async (_opts, cb) => {
      cb?.onStatusChange?.("listening");
      return { close, setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn() };
    });
    const view = render(<LivePane pane={mockPane} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start session" })); });
    view.rerender(<LivePane pane={{ ...mockPane, title: "Updated Live title" }} />);
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("starts only the specifically targeted pane even when roomId also matches", async () => {
    const start = vi.spyOn(liveSessionModule, "openLiveConversationSession").mockResolvedValue({
      close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn()
    });
    render(<><LivePane pane={mockPane} /><LivePane pane={{ ...mockPane, id: "pane:other" }} /></>);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("space-live-pane-toggle", { detail: { paneId: mockPane.id, roomId: mockPane.roomId } }));
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0].paneId).toBe(mockPane.id);
  });

  it("ignores repeated starts before the first React status update", async () => {
    const start = vi.spyOn(liveSessionModule, "openLiveConversationSession").mockResolvedValue({
      close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn()
    });
    render(<LivePane pane={mockPane} />);
    await act(async () => {
      for (let i = 0; i < 2; i++) window.dispatchEvent(new CustomEvent("space-live-pane-toggle", { detail: { paneId: mockPane.id } }));
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("closes a pending start resolved after unmount", async () => {
    let resolve!: (handle: liveSessionModule.LiveSessionHandle) => void;
    const close = vi.fn();
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(<LivePane pane={mockPane} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start session" })); });
    view.unmount();
    await act(async () => { resolve({ close, setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn() }); });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("renders with OpenAI as default provider, gpt-live-1 model, and Talk to GPT-Live title", () => {
    const { container } = render(<LivePane pane={mockPane} />);

    expect(screen.getByText("Talk to GPT-Live")).toBeDefined();

    const providerSelect = container.querySelector("#live-voice-provider-select") as HTMLSelectElement;
    expect(providerSelect).not.toBeNull();
    expect(providerSelect.value).toBe("openai");

    const modelSelect = container.querySelector("#live-voice-model-select") as HTMLSelectElement;
    expect(modelSelect).not.toBeNull();
    expect(modelSelect.value).toBe("gpt-live-1");

    const options = Array.from(providerSelect.options).map((o) => o.value);
    expect(options).toContain("openai");
    expect(options).toContain("google");
    expect(options).toContain("amazon");
    expect(options).toContain("local");
    expect(options).toContain("vercel");
  });

  it("switches to Google Gemini Live and dynamically updates model, voice, and title", async () => {
    const { container } = render(<LivePane pane={mockPane} />);

    const providerSelect = container.querySelector("#live-voice-provider-select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(providerSelect, { target: { value: "google" } });
    });

    expect(screen.getByText("Talk to Gemini Live")).toBeDefined();

    const modelSelect = container.querySelector("#live-voice-model-select") as HTMLSelectElement;
    expect(modelSelect.value).toBe("gemini-3.8-live");

    const modelOptions = Array.from(modelSelect.options).map((o) => o.value);
    expect(modelOptions).toContain("gemini-3.8-live");
    expect(modelOptions).toContain("gemini-3.8-live-extended-thinking");
    expect(modelOptions).toContain("gemini-3.1-flash-live-preview");
    expect(modelOptions).toContain("gemini-2.5-flash-native-audio-latest");
    expect(modelOptions).toContain("gemini-2.0-flash-exp");

    const voiceSelect = container.querySelector("#live-voice-select") as HTMLSelectElement;
    expect(voiceSelect.value).toBe("Aoede");

    const voiceOptions = Array.from(voiceSelect.options).map((o) => o.value);
    expect(voiceOptions).toContain("Aoede");
    expect(voiceOptions).toContain("Fenrir");
  });

  it("switches to Amazon Nova 2 Sonic and dynamically updates model and voice", async () => {
    const { container } = render(<LivePane pane={mockPane} />);

    const providerSelect = container.querySelector("#live-voice-provider-select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(providerSelect, { target: { value: "amazon" } });
    });

    expect(screen.getByText("Talk to Nova Sonic")).toBeDefined();

    const modelSelect = container.querySelector("#live-voice-model-select") as HTMLSelectElement;
    expect(modelSelect.value).toBe("amazon.nova-2-sonic-v1:0");

    const voiceSelect = container.querySelector("#live-voice-select") as HTMLSelectElement;
    expect(voiceSelect.value).toBe("en-US-Jenny");

    const voiceOptions = Array.from(voiceSelect.options).map((o) => o.value);
    expect(voiceOptions).toContain("Matthew");
    expect(voiceOptions).toContain("Ruth");
  });

  it("switches to Vercel AI Gateway and dynamically updates model, voice, and title", async () => {
    const { container } = render(<LivePane pane={mockPane} />);

    const providerSelect = container.querySelector("#live-voice-provider-select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(providerSelect, { target: { value: "vercel" } });
    });

    expect(screen.getByText("Talk to GPT-Live (Vercel)")).toBeDefined();

    const modelSelect = container.querySelector("#live-voice-model-select") as HTMLSelectElement;
    expect(modelSelect.value).toBe("openai/gpt-live-1");

    const modelOptions = Array.from(modelSelect.options).map((o) => o.value);
    expect(modelOptions).toContain("openai/gpt-live-1");
    expect(modelOptions).toContain("openai/gpt-realtime-2.1");

    const voiceSelect = container.querySelector("#live-voice-select") as HTMLSelectElement;
    expect(voiceSelect.value).toBe("gleam");

    const voiceOptions = Array.from(voiceSelect.options).map((o) => o.value);
    expect(voiceOptions).toContain("gleam");
    expect(voiceOptions).toContain("alloy");
  });

  it("passes provider, model, and voice to openLiveConversationSession when starting session", async () => {
    let capturedOptions: liveSessionModule.LiveSessionOptions | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (opts) => {
        capturedOptions = opts;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    const { container } = render(<LivePane pane={mockPane} />);

    const providerSelect = container.querySelector("#live-voice-provider-select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(providerSelect, { target: { value: "google" } });
    });

    const startButton = screen.getByRole("button", { name: "Start session" });
    await act(async () => {
      fireEvent.click(startButton);
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.provider).toBe("google");
    expect(capturedOptions?.model).toBe("gemini-3.8-live");
    expect(capturedOptions?.voice).toBe("Aoede");
  });
});
