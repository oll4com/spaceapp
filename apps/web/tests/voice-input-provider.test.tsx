import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpaceRuntimeProvider } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { VoiceInputProvider, useVoiceInput } from "../src/features/voice-input/VoiceInputProvider.js";
import { noteVoiceRelayClose, resetVoiceProviderAvailability } from "../src/voice-relay-close.js";
import { browserSpeechLang } from "../src/features/voice-input/browser-speech.js";

const realtime = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../src/voice-realtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/voice-realtime.js")>(),
  openVoiceRealtimeSession: realtime.open
}));

type MockHandle = { startCapture: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const mockHandle = (): MockHandle => ({ startCapture: vi.fn(async () => {}), commit: vi.fn(), close: vi.fn() });

function useGoogleVoice() {
  window.localStorage.setItem("space.voiceTranscription.settings", JSON.stringify({
    enabled: true,
    engine: "relay",
    provider: "google",
    model: "gemini-3.8-live",
    voice: "Aoede",
    language: "auto"
  }));
}

function Harness({ onA, onB }: { onA: (text: string) => void; onB: (text: string) => void }) {
  const voice = useVoiceInput();
  return (
    <div>
      <button type="button" onClick={() => void voice.start({ id: "a", onTranscriptComplete: onA })}>Start A</button>
      <button type="button" onClick={() => void voice.start({ id: "b", onTranscriptComplete: onB })}>Start B</button>
      <button type="button" onClick={() => voice.stop("b")}>Stop B</button>
      <button type="button" onClick={() => void voice.ensureServerSettings()}>Ensure settings</button>
      <button type="button" onPointerEnter={() => voice.prewarm()}>Prewarm</button>
      <span data-testid="voice-state">{voice.ownerId ?? "none"}:{voice.status}</span>
      <span data-testid="settings-state">{voice.settingsLoading ? "loading" : voice.serverSettings?.enabled ? "enabled" : voice.settingsError ?? "disabled"}</span>
      <span data-testid="cancel-notice">{voice.cancelNotice ? `${voice.cancelNotice.ownerId}:${voice.cancelNotice.message}` : ""}</span>
      <span data-testid="recording-started">{voice.recordingStartedAt ? "started" : "none"}</span>
      <span data-testid="voice-preview">{voice.preview}</span>
      <span data-testid="voice-error">{voice.error ?? ""}</span>
    </div>
  );
}

describe("VoiceInputProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetVoiceProviderAvailability();
  });

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("space.voiceTranscription.settings", JSON.stringify({
      enabled: true,
      engine: "relay",
      provider: "openai",
      model: "gpt-transcribe",
      voice: "alloy",
      language: "auto"
    }));
    realtime.open.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      enabled: true,
      statusReason: "OpenAI Realtime transcription is configured.",
      defaultModel: "gpt-live-transcribe",
      modelOptions: ["gpt-live-transcribe"],
      defaultVoice: "alloy",
      voiceOptions: ["alloy", "ash"],
      defaultLanguage: "auto",
      languageOptions: ["auto", "el", "en"],
      defaultDelay: "low",
      delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
      maxBytes: 26214400,
      maxDurationMs: 300000,
      updatedAt: "2026-08-09T00:00:00.000Z"
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });

  it("allows one recorder globally, commits explicitly, and never completes an empty transcript", async () => {
    const callbacks: Array<{ onTranscriptComplete?: (text: string) => void | Promise<void> }> = [];
    const handles: MockHandle[] = [];
    realtime.open.mockImplementation(async (options, nextCallbacks) => {
      callbacks.push(nextCallbacks);
      const handle = mockHandle();
      handles.push(handle);
      expect(options).toMatchObject({ model: "gpt-transcribe", language: "auto", delay: "low" });
      return handle;
    });
    const onA = vi.fn();
    const onB = vi.fn();

    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={onA} onB={onB} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));

    fireEvent.click(screen.getByRole("button", { name: "Start B" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("b:recording"));
    expect(handles[0]?.close).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Stop B" }));
    expect(handles[1]?.commit).toHaveBeenCalledOnce();
    expect(screen.getByTestId("voice-state").textContent).toBe("b:transcribing");
    await act(async () => callbacks[1]?.onTranscriptComplete?.("  spoken prompt  "));
    expect(onB).toHaveBeenCalledWith("spoken prompt");
    expect(onA).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("none:idle"));

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    await act(async () => callbacks[2]?.onTranscriptComplete?.("   "));
    expect(onA).not.toHaveBeenCalled();
  });

  it("does not request protected settings until authentication asks to ensure them", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
        enabled: true,
        statusReason: "OpenAI Realtime transcription is configured.",
        defaultModel: "gpt-live-transcribe",
        modelOptions: ["gpt-live-transcribe"],
        defaultVoice: "alloy",
        voiceOptions: ["alloy", "ash"],
        defaultLanguage: "auto",
        languageOptions: ["auto", "el", "en"],
        defaultDelay: "low",
        delayOptions: ["minimal", "low", "medium", "high", "xhigh"],
        maxBytes: 26214400,
        maxDurationMs: 300000,
        updatedAt: "2026-08-09T00:00:00.000Z"
      }), { status: 200, headers: { "content-type": "application/json" } }));

    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={vi.fn()} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pre-warms a Google connection on hover without the microphone and opens it only on start", async () => {
    useGoogleVoice();
    const callbacks: Array<{ onTranscriptComplete?: (text: string) => void | Promise<void> }> = [];
    const handles: MockHandle[] = [];
    realtime.open.mockImplementation(async (options, nextCallbacks, openOptions) => {
      callbacks.push(nextCallbacks);
      const handle = mockHandle();
      handles.push(handle);
      expect(options).toMatchObject({ provider: "google", model: "gemini-3.8-live", language: "auto" });
      expect(openOptions).toEqual(handles.length === 1 ? { deferCapture: true } : undefined);
      return handle;
    });
    const onA = vi.fn();

    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={onA} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    const warmHandle = handles[0]!;
    expect(warmHandle.startCapture).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-state").textContent).toBe("none:idle");

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    expect(warmHandle.startCapture).toHaveBeenCalledOnce();
    expect(realtime.open).toHaveBeenCalledTimes(1);
    expect(warmHandle.commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start B" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("b:recording"));
    expect(warmHandle.close).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Stop B" }));
    expect(handles[1]?.commit).toHaveBeenCalledOnce();
    await act(async () => callbacks[1]?.onTranscriptComplete?.("prewarmed transcript"));
    expect(onA).not.toHaveBeenCalled();
  });

  it("never pre-warms OpenAI, whose WebRTC offer already carries the microphone", async () => {
    realtime.open.mockImplementation(async () => mockHandle());
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={vi.fn()} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    expect(realtime.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    expect(realtime.open).toHaveBeenCalledOnce();
    expect(realtime.open.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("drops a warm connection that fails before it is claimed and opens a fresh one on start", async () => {
    useGoogleVoice();
    const callbacks: Array<{ onError?: (message: string) => void }> = [];
    const handles: MockHandle[] = [];
    realtime.open.mockImplementation(async (_options, nextCallbacks) => {
      callbacks.push(nextCallbacks);
      const handle = mockHandle();
      handles.push(handle);
      return handle;
    });
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={vi.fn()} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    act(() => callbacks[0]?.onError?.("Google Gemini Live voice connection closed unexpectedly."));
    expect(handles[0]?.close).toHaveBeenCalledOnce();
    expect(screen.getByTestId("voice-state").textContent).toBe("none:idle");

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    expect(realtime.open).toHaveBeenCalledTimes(2);
    expect(handles[0]?.startCapture).not.toHaveBeenCalled();
  });

  it("switches a recording to OpenAI when Google reports that its voice credits are used up", async () => {
    useGoogleVoice();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      enabled: true, statusReason: "Google Gemini Live, OpenAI Realtime configured.", defaultProvider: "google", providerOptions: ["google", "openai"],
      defaultModel: "gemini-3.8-live", modelOptions: ["gemini-3.8-live", "gpt-live-1"], defaultVoice: "Aoede", voiceOptions: ["Aoede", "gleam"],
      defaultLanguage: "auto", languageOptions: ["auto", "el", "en"], defaultDelay: "low", delayOptions: ["minimal", "low"],
      maxBytes: 26214400, maxDurationMs: 300000, updatedAt: "2026-10-13T00:00:00.000Z"
    })));
    const callbacks: Array<{ onError?: (message: string) => void; onTranscriptComplete?: (text: string) => void | Promise<void> }> = [];
    const handles: MockHandle[] = [];
    realtime.open.mockImplementation(async (_options, nextCallbacks) => {
      callbacks.push(nextCallbacks);
      const handle = mockHandle();
      handles.push(handle);
      return handle;
    });
    const onA = vi.fn();
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={onA} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    expect(realtime.open.mock.calls[0]?.[0]).toMatchObject({ provider: "google", model: "gemini-3.8-live" });

    // The relay closes Google: credits used up. The same recording continues on OpenAI.
    act(() => {
      noteVoiceRelayClose("google", "provider_quota_exhausted");
      callbacks[0]?.onError?.("Google Gemini Live is unavailable: the credits of Space's voice key are used up.");
    });
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(2));
    expect(realtime.open.mock.calls[1]?.[0]).toMatchObject({ provider: "openai", model: "gpt-live-1", voice: "gleam" });
    expect(realtime.open.mock.calls[1]?.[2]).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    expect(screen.getByTestId("voice-preview").textContent).toBe("Google Gemini Live has no voice credits; using OpenAI.");
    expect(screen.getByTestId("voice-error").textContent).toBe("");
    expect(handles[0]?.close).toHaveBeenCalled();
    await act(async () => callbacks[1]?.onTranscriptComplete?.("set the layout to one column"));
    expect(onA).toHaveBeenCalledWith("set the layout to one column");

    // Later recordings go straight to OpenAI without pre-warming Google.
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(3));
    expect(realtime.open.mock.calls[2]?.[0]).toMatchObject({ provider: "openai" });
  });

  it("stays idle with the microphone error when a warm connection cannot open the microphone", async () => {
    useGoogleVoice();
    const handle = mockHandle();
    handle.startCapture.mockRejectedValue(new Error("Permission denied"));
    realtime.open.mockResolvedValue(handle);
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={vi.fn()} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(handle.startCapture).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:idle"));
    expect(handle.close).toHaveBeenCalled();
    expect(handle.commit).not.toHaveBeenCalled();
  });

  it("does not pre-warm when the prewarm preference is disabled", async () => {
    window.localStorage.setItem("space.voiceTranscription.settings", JSON.stringify({ engine: "relay", prewarm: false }));
    realtime.open.mockResolvedValue(mockHandle());

    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={vi.fn()} onB={vi.fn()} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Prewarm" }));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    expect(realtime.open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(realtime.open).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
  });

  it("cancels the active recorder without submitting when the browser becomes hidden", async () => {
    const handle = mockHandle();
    realtime.open.mockResolvedValue(handle);
    const onA = vi.fn();
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

    try {
      render(
        <SpaceRuntimeProvider runtime={liveRuntime}>
          <VoiceInputProvider><Harness onA={onA} onB={vi.fn()} /></VoiceInputProvider>
        </SpaceRuntimeProvider>
      );

      fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
      await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
      fireEvent.click(screen.getByRole("button", { name: "Start A" }));
      await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));

      act(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("none:idle"));
      expect(handle.close).toHaveBeenCalledOnce();
      expect(handle.commit).not.toHaveBeenCalled();
      expect(onA).not.toHaveBeenCalled();
      // The interrupted owner learns why its recording ended.
      expect(screen.getByTestId("cancel-notice").textContent).toBe("a:Voice input stopped because the tab was hidden.");
      expect(screen.getByTestId("recording-started").textContent).toBe("none");
    } finally {
      if (originalVisibilityState) Object.defineProperty(document, "visibilityState", originalVisibilityState);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

describe("VoiceInputProvider with the browser's free speech recognition (operator 31/10)", () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: { results: Array<Array<{ transcript: string }> & { isFinal: boolean }> }) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start = vi.fn();
    stop = vi.fn(() => this.onend?.());
    abort = vi.fn();
    constructor() { FakeRecognition.last = this; }
    hear(...parts: Array<[string, boolean]>) {
      this.onresult?.({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
    }
  }
  const renderHarness = (onA = vi.fn(), onB = vi.fn()) => {
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider><Harness onA={onA} onB={onB} /></VoiceInputProvider>
      </SpaceRuntimeProvider>
    );
    return onA;
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("space.voiceTranscription.settings", JSON.stringify({ enabled: true, language: "el" }));
    realtime.open.mockReset();
    FakeRecognition.last = null;
    // No provider key on this server: the free engine needs none.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      enabled: false, statusReason: "No voice transcription provider credentials configured on Space.", defaultModel: "gpt-live-1",
      modelOptions: ["gpt-live-1"], defaultLanguage: "auto", languageOptions: ["auto", "el", "en"], defaultDelay: "low",
      delayOptions: ["low"], maxBytes: 26214400, maxDurationMs: 300000, updatedAt: "2026-10-31T00:00:00.000Z"
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is the default: dictates Greek in the browser, sends on stop and never opens the paid relay", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const onA = renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).toBe("enabled"));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    const recognition = FakeRecognition.last!;
    expect(recognition).toMatchObject({ lang: "el-GR", continuous: true, interimResults: true });
    expect(recognition.start).toHaveBeenCalledOnce();

    act(() => recognition.hear(["Γεια σου", true], [" Nous", false]));
    expect(screen.getByTestId("voice-preview").textContent).toBe("Γεια σου Nous");
    // Starting again drops the first take (cancel) and listens afresh.
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(FakeRecognition.last).not.toBe(recognition));
    expect(recognition.abort).toHaveBeenCalledOnce();

    const second = FakeRecognition.last!;
    act(() => second.hear(["open the plan", true]));
    act(() => second.stop());
    await waitFor(() => expect(onA).toHaveBeenCalledWith("open the plan"));
    expect(realtime.open).not.toHaveBeenCalled();
  });

  it("maps Auto to Greek when the browser lists Greek, else English", () => {
    expect(browserSpeechLang("auto", ["en-US", "el"])).toBe("el-GR");
    expect(browserSpeechLang("auto", ["en-GB"])).toBe("en-US");
    expect(browserSpeechLang("en", ["el-GR"])).toBe("en-US");
  });

  it("explains a browser without speech recognition instead of falling back to a paid provider", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Ensure settings" }));
    await waitFor(() => expect(screen.getByTestId("settings-state").textContent).not.toBe("loading"));
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-error").textContent).toContain("This browser has no speech recognition"));
    expect(screen.getByTestId("voice-state").textContent).toBe("a:idle");
    expect(realtime.open).not.toHaveBeenCalled();
  });

  describe("inside SpaceApp Desktop (Web Speech there always ends in network: Whisper runs on the PC)", () => {
    const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null }> = [];
    class FakeAudioContext {
      sampleRate = 16000;
      destination = {};
      close = vi.fn(async () => undefined);
      createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
      createScriptProcessor() {
        const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
        processors.push(processor);
        return processor;
      }
    }
    const stopTrack = vi.fn();
    const desktop = (speech?: object) => Object.defineProperty(window, "spaceDesktop", { configurable: true, value: { isDesktop: true, speech } });
    beforeEach(() => {
      processors.length = 0;
      vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
      vi.stubGlobal("AudioContext", FakeAudioContext);
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    });
    afterEach(() => {
      Reflect.deleteProperty(window, "spaceDesktop");
      Reflect.deleteProperty(navigator, "mediaDevices");
    });

    it("records, hands the take to the PC's recognizer and never opens Web Speech or the relay", async () => {
      const transcribe = vi.fn(async () => ({ text: " Γεια σου Nous " }));
      desktop({ prepare: vi.fn(async () => ({ ready: true, progress: 1 })), transcribe });
      const onA = vi.fn();
      const onB = vi.fn();
      renderHarness(onA, onB);
      fireEvent.click(screen.getByRole("button", { name: "Start A" }));
      await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
      act(() => processors[0]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.5, -0.5, 0]) } }));
      fireEvent.click(screen.getByRole("button", { name: "Start B" }));
      await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("b:recording"));
      expect(stopTrack).toHaveBeenCalled();
      act(() => processors[1]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.25, 0.25]) } }));
      fireEvent.click(screen.getByRole("button", { name: "Stop B" }));
      await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
      const [pcm, lang] = transcribe.mock.calls[0] as unknown as [Uint8Array, string];
      expect(lang).toBe("el");
      // Only B's take (two samples), at 16 kHz 16-bit: A's was dropped with its microphone.
      expect(pcm.byteLength).toBe(4);
      await waitFor(() => expect(onB).toHaveBeenCalledWith("Γεια σου Nous"));
      expect(onA).not.toHaveBeenCalled();
      expect(FakeRecognition.last).toBeNull();
      expect(realtime.open).not.toHaveBeenCalled();
    });

    it("leaves Auto to Whisper, whatever languages the PC lists", async () => {
      window.localStorage.setItem("space.voiceTranscription.settings", JSON.stringify({ enabled: true, language: "auto" }));
      const transcribe = vi.fn(async () => ({ text: "hello" }));
      desktop({ prepare: vi.fn(async () => ({ ready: true, progress: 1 })), transcribe });
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "Start B" }));
      await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("b:recording"));
      act(() => processors[0]!.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.5]) } }));
      fireEvent.click(screen.getByRole("button", { name: "Stop B" }));
      await waitFor(() => expect(transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), "auto"));
    });

    it("tells how far the one-time download is, and that an older desktop needs an update", async () => {
      desktop({ prepare: vi.fn(async () => ({ ready: false, progress: 0.426 })), transcribe: vi.fn() });
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "Start A" }));
      await waitFor(() => expect(screen.getByTestId("voice-error").textContent).toContain("downloading its free speech recognition for this PC, once (42% of 590 MB)"));

      desktop();
      fireEvent.click(screen.getByRole("button", { name: "Start A" }));
      await waitFor(() => expect(screen.getByTestId("voice-error").textContent).toContain("This SpaceApp Desktop version has no free speech recognition"));
      expect(FakeRecognition.last).toBeNull();
    });
  });

  it("names a denied microphone and ignores a take with no speech", async () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const onA = renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    act(() => { FakeRecognition.last!.onerror?.({ error: "no-speech" }); FakeRecognition.last!.onend?.(); });
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("none:idle"));
    expect(onA).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start A" }));
    await waitFor(() => expect(screen.getByTestId("voice-state").textContent).toBe("a:recording"));
    act(() => { FakeRecognition.last!.onerror?.({ error: "not-allowed" }); FakeRecognition.last!.onend?.(); });
    await waitFor(() => expect(screen.getByTestId("voice-error").textContent).toBe("Microphone permission was not granted."));
    expect(onA).not.toHaveBeenCalled();
  });
});
