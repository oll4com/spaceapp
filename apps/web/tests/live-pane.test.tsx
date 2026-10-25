// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { api } from "../src/live-api.js";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { LivePane } from "../src/features/live-pane/LivePane.js";
import * as liveSessionModule from "../src/features/live-pane/live-session.js";
import * as liveSessionProviderModule from "../src/features/live-pane/LiveSessionProvider.js";
import type { Pane } from "@space/contracts";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";

const mockPane: Pane = {
  id: "pane:live-test-1",
  roomId: "room:test",
  title: "Live 1",
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

describe("LivePane component", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    vi.spyOn(api, "getLivePersonalMemory").mockResolvedValue({ items: [], revision: 0 });
    vi.spyOn(api, "inspectRoomMission").mockImplementation(async roomId => ({ roomId, snapshot: null }));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    installSpaceRuntime(liveRuntime);
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {}
  });

  it("serializes response events without the unsupported nested response parameter", () => {
    expect(JSON.parse(liveSessionModule.createLiveClientEvent("response.create"))).toEqual({ type: "response.create" });
    expect(JSON.parse(liveSessionModule.createLiveClientEvent("session.input_audio.mute"))).toEqual({
      type: "session.input_audio.mute"
    });
    expect(JSON.parse(liveSessionModule.createLiveInstructionsAppend("Say hello once"))).toEqual({
      type: "session.instructions.append",
      event_id: "live_opening_greeting",
      delegation_id: null,
      content: "Say hello once"
    });
    expect(JSON.parse(liveSessionModule.createLiveCommentaryAppend("Hello"))).toMatchObject({
      type: "session.commentary.append",
      event_id: "live_commentary",
      delegation_id: null,
      content: "Hello"
    });
  });

  it("renders with exact configuration options from OpenAI Live reference", () => {
    render(<LivePane pane={mockPane} />);

    // Section headers
    expect(screen.getByText("Start from a prompt")).toBeDefined();
    expect(screen.getByText("Voice model")).toBeDefined();
    expect(screen.getByText("Delegated model")).toBeDefined();

    // Voice options
    expect(screen.getByLabelText("Voice")).toBeDefined();
    expect(screen.getByLabelText("Opening")).toBeDefined();

    // Delegated options
    expect(screen.getByText("Web search")).toBeDefined();
    expect(screen.getByText("Space Memory Access")).toBeDefined();
    expect(screen.getByText("space_recall_memory")).toBeDefined();
    expect(screen.getByText("Space Memory")).toBeDefined();

    // Main interaction area
    expect(screen.getByText("Talk to GPT-Live")).toBeDefined();
    expect(screen.getByRole("button", { name: "Start session" })).toBeDefined();
  });

  it("opens Real View controls from the pane header and keeps them off until Live runs", () => {
    render(<LivePane pane={mockPane} />);
    expect(screen.queryByRole("group", { name: "Real View" })).toBeNull();
    act(() => { window.dispatchEvent(new CustomEvent("space-live-pane-action", { detail: { paneId: mockPane.id, action: "real-view" } })); });
    const bar = screen.getByRole("group", { name: "Real View" });
    expect(bar.textContent).toContain("Start the Live conversation to share a view.");
    expect((screen.getByRole("button", { name: "Screen" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Camera" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens as the Live surface with settings collapsed", () => {
    const { container } = render(<LivePane pane={mockPane} />);

    expect(container.querySelector("aside[aria-label=\"Live settings\"]")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Open live settings" })).toBeDefined();
  });

  it("toggles Space Memory tool visibility when access switch is toggled", () => {
    render(<LivePane pane={mockPane} />);
    fireEvent.click(screen.getByRole("button", { name: "Open live settings" }));

    expect(screen.getByText("space_recall_memory")).toBeDefined();

    const memoryToggle = screen.getByRole("switch", { name: "Space Memory Access" });
    fireEvent.click(memoryToggle);

    expect(screen.queryByText("space_recall_memory")).toBeNull();

    fireEvent.click(memoryToggle);
    expect(screen.getByText("space_recall_memory")).toBeDefined();
  });

  it("opens searchable model picker, filters by query, and selects a new model", () => {
    const { container } = render(<LivePane pane={mockPane} />);

    // Trigger initially shows gpt-5.6-terra
    const trigger = container.querySelector("#live-delegated-model") as HTMLButtonElement;
    expect(trigger).toBeDefined();
    expect(trigger.textContent).toContain("gpt-5.6-terra");


    // Click trigger to open menu
    fireEvent.click(trigger);

    // Search input should be visible
    const searchInput = screen.getByPlaceholderText("Select a model...");
    expect(searchInput).toBeDefined();

    // List includes reference models
    expect(screen.getByText("gpt-4o")).toBeDefined();
    expect(screen.getByText("gpt-5.6-sol")).toBeDefined();
    expect(screen.getByText("o3")).toBeDefined();

    // Type query into search
    fireEvent.change(searchInput, { target: { value: "sol" } });
    expect(screen.getByText("gpt-5.6-sol")).toBeDefined();
    expect(screen.queryByText("gpt-4o")).toBeNull();

    // Select gpt-5.6-sol
    fireEvent.click(screen.getByText("gpt-5.6-sol"));

    // Menu closes and trigger now shows gpt-5.6-sol
    expect(screen.queryByPlaceholderText("Select a model...")).toBeNull();
    expect(container.querySelector("#live-delegated-model")?.textContent).toContain("gpt-5.6-sol");
  });

  it("accumulates live streaming deltas into a single unified assistant message bubble", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    const { container } = render(<LivePane pane={mockPane} />);

    // Click Start session
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });

    expect(capturedCallbacks).toBeDefined();

    // Simulate incoming deltas for the same assistant response item
    const msgId = "item_assistant_greek_1";
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: msgId,
        role: "assistant",
        text: "Ναι",
        isDelta: true,
        timestamp: "09:32:38 AM"
      });
      capturedCallbacks?.onTranscriptUpdate?.({
        id: msgId,
        role: "assistant",
        text: ", σε",
        isDelta: true,
        timestamp: "09:32:38 AM"
      });
      capturedCallbacks?.onTranscriptUpdate?.({
        id: msgId,
        role: "assistant",
        text: " ακούω.",
        isDelta: true,
        timestamp: "09:32:38 AM"
      });
    });

    // Check DOM: only ONE assistant bubble exists with the accumulated text
    const bubbles = container.querySelectorAll(".live-transcript-bubble");
    expect(bubbles.length).toBe(1);
    expect(bubbles[0]?.textContent).toContain("Ναι, σε ακούω.");
  });

  it("renders language selector with Greek and Auto options", () => {
    render(<LivePane pane={mockPane} />);
    const langSelect = screen.getByLabelText("Language") as HTMLSelectElement;
    expect(langSelect).toBeDefined();
    expect(langSelect.value).toBe("auto");
    fireEvent.change(langSelect, { target: { value: "el" } });
    expect(langSelect.value).toBe("el");
  });

  it("creates separate message bubbles for subsequent speech turns instead of appending into previous box", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    const { container } = render(<LivePane pane={mockPane} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });

    expect(capturedCallbacks).toBeDefined();

    // Turn 1: User speaks first utterance
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "user_turn_1",
        role: "user",
        text: "Γειά σου, μιλάς ελληνικά;",
        isDelta: false,
        timestamp: "09:43:37 AM"
      });
    });

    // Turn 2: Assistant replies
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "assistant_turn_1",
        role: "assistant",
        text: "Ναι, μιλάω άπταιστα ελληνικά! Πώς μπορώ να σε βοηθήσω σήμερα;",
        isDelta: false,
        timestamp: "09:43:44 AM"
      });
    });

    // Turn 3: User speaks a subsequent utterance in a new turn
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "user_turn_2",
        role: "user",
        text: "Τέλεια, θέλω να ελέγξουμε το backup του Proxmox.",
        isDelta: false,
        timestamp: "09:44:52 AM"
      });
    });

    const bubbles = container.querySelectorAll(".live-transcript-bubble");
    expect(bubbles.length).toBe(3);

    // Verify bubbles appear in order: User -> Assistant -> New User bubble below
    expect(bubbles[0]?.classList.contains("user")).toBe(true);
    expect(bubbles[0]?.textContent).toContain("Γειά σου, μιλάς ελληνικά;");

    expect(bubbles[1]?.classList.contains("assistant")).toBe(true);
    expect(bubbles[1]?.textContent).toContain("Ναι, μιλάω άπταιστα ελληνικά!");

    expect(bubbles[2]?.classList.contains("user")).toBe(true);
    expect(bubbles[2]?.textContent).toContain("Τέλεια, θέλω να ελέγξουμε το backup του Proxmox.");
  });

  it("persists configuration changes to localStorage and restores them on remount", async () => {
    localStorage.clear();

    const testPane: Pane = {
      ...mockPane,
      id: "pane:persistent-test-1"
    };

    const { unmount } = render(<LivePane pane={testPane} />);

    // Change prompt
    const promptInput = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    fireEvent.change(promptInput, { target: { value: "My persistent instructions" } });

    // Change reasoning effort
    const reasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    fireEvent.change(reasoningSelect, { target: { value: "xhigh" } });

    // Verify localStorage was updated
    const rawStored = localStorage.getItem(`space_live_pane_${testPane.id}`);
    expect(rawStored).toBeDefined();
    const stored = JSON.parse(rawStored!);
    expect(stored.prompt).toBe("My persistent instructions");
    expect(stored.reasoningEffort).toBe("xhigh");

    // Unmount and remount a new instance
    unmount();
    const remount = render(<LivePane pane={testPane} />);
    // Check that restored values match on original pane
    const newPromptInput = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    expect(newPromptInput.value).toBe("My persistent instructions");

    const newReasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    expect(newReasoningSelect.value).toBe("xhigh");

    // Check that a brand new pane with a different ID also inherits the saved defaults
    remount.unmount();
    const brandNewPane: Pane = {
      ...mockPane,
      id: "pane:brand-new-pane-999"
    };
    render(<LivePane pane={brandNewPane} />);
    const brandNewPromptInput = screen.getByLabelText("Agent prompt") as HTMLTextAreaElement;
    expect(brandNewPromptInput.value).toBe("My persistent instructions");
    const brandNewReasoningSelect = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
    expect(brandNewReasoningSelect.value).toBe("xhigh");
  });

  it("renders the audio settings and closes the settings bar without closing the Live surface", () => {
    const { container } = render(<LivePane pane={mockPane} />);
    fireEvent.click(screen.getByRole("button", { name: "Open live settings" }));

    // Microphone selector has System Default option
    const micSelect = screen.getByLabelText("Microphone input device") as HTMLSelectElement;
    expect(micSelect).toBeDefined();
    expect(micSelect.options[0]?.text).toBe("System Default Microphone");
    expect(micSelect.options[0]?.value).toBe("");
    expect(screen.getByLabelText("Region time")).toBeDefined();
    expect((screen.getByLabelText("Region time") as HTMLSelectElement).value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    fireEvent.change(screen.getByLabelText("Region time"), { target: { value: "Europe/Athens" } });
    expect((screen.getByLabelText("Region time") as HTMLSelectElement).value).toBe("Europe/Athens");

    fireEvent.click(screen.getByRole("switch", { name: "Voice-only mode" }));
    expect(screen.getAllByText("Voice-only mode").length).toBeGreaterThan(1);
    expect(screen.queryByRole("log", { name: "Chat transcript" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Docs" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close live settings" }));
    expect(container.querySelector("aside[aria-label=\"Live settings\"]")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Open live settings" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Docs" })).toBeNull();
  });

  it.each(["gpt-live-1", "gpt-realtime-mini"])("waits for the %s session acknowledgement and uses its own command protocol", async (model) => {
    let openHandler: (() => void) | undefined;
    let messageHandler: ((event: { data: string }) => void) | undefined;
    const sentData: string[] = [];
    const mockChannel = {
      readyState: "open",
      addEventListener: vi.fn((event: string, cb: any) => {
        if (event === "open") openHandler = cb;
        if (event === "message") messageHandler = cb;
      }),
      send: vi.fn((data: string) => {
        sentData.push(data);
      }),
      close: vi.fn()
    };
    const mockConnection = {
      createDataChannel: vi.fn(() => mockChannel),
      addEventListener: vi.fn(),
      addTrack: vi.fn(),
      getTransceivers: vi.fn(() => []),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=test" })),
      setLocalDescription: vi.fn(async () => {}),
      setRemoteDescription: vi.fn(async () => {}),
      iceGatheringState: "complete",
      localDescription: { sdp: "v=0\r\no=test" },
      getSenders: vi.fn(() => []),
      close: vi.fn()
    };
    const mockTrack = { enabled: true, stop: vi.fn(), kind: "audio" };
    const mockStream = {
      getAudioTracks: vi.fn(() => [mockTrack]),
      getTracks: vi.fn(() => [mockTrack]),
      clone: vi.fn(() => ({
        getAudioTracks: vi.fn(() => [mockTrack]),
        getTracks: vi.fn(() => [mockTrack])
      }))
    };

    const mockPlatform = {
      userMediaSupported: true,
      peerConnectionSupported: true,
      getUserMedia: vi.fn(async () => mockStream as any),
      createPeerConnection: vi.fn(() => mockConnection as any)
    };

    const runtimeModule = await import("../src/runtime/SpaceRuntime.js");
    runtimeModule.installSpaceRuntime({
      kind: "live",
      platform: mockPlatform as any,
      api: {
        createVoiceRealtimeCall: vi.fn().mockResolvedValue({
          callId: "call_123",
          answerSdp: "v=0\r\no=answer"
        })
      } as any,
      events: { supported: false, open: vi.fn() as any },
      terminal: { supported: false, connect: vi.fn() as any },
      browser: { supported: false, connect: vi.fn() as any }
    } as any);

    const session = await liveSessionModule.openLiveConversationSession({
      model, enableMcpTools: false
    });

    expect(mockConnection.createDataChannel).toHaveBeenCalledWith("oai-events");
    expect(openHandler).toBeDefined();

    // Trigger open
    openHandler!();

    expect(mockTrack.enabled).toBe(false);
    expect(sentData).toEqual([]);
    session.setMuted(false);
    expect(mockTrack.enabled).toBe(false);
    messageHandler!({ data: JSON.stringify({ type: model === "gpt-live-1" ? "session.started" : "session.created" }) });
    expect(mockTrack.enabled).toBe(true);

    session.setMuted(true);
    expect(mockTrack.enabled).toBe(false);
    session.setMuted(false);
    expect(mockTrack.enabled).toBe(true);
    await session.sendInput!([{ type: "text", text: "hello" }]);
    const events = sentData.map(data => JSON.parse(data));
    expect(events).toContainEqual(expect.objectContaining({ type: model === "gpt-live-1" ? "response.item.create" : "conversation.item.create" }));
    if (model === "gpt-live-1") {
      expect(events).toContainEqual({ type: "session.input_audio.unmute" });
      expect(events).toContainEqual({ type: "session.input_audio.mute" });
    } else {
      expect(events.some(event => event.type.startsWith("session.input_audio"))).toBe(false);
    }

    session.close();
  });

  it("shows a no-audio warning when the mic goes silent and clears it when audio resumes", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    render(<LivePane pane={mockPane} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });
    expect(capturedCallbacks).toBeDefined();

    await act(async () => {
      capturedCallbacks?.onStatusChange?.("active");
    });
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      capturedCallbacks?.onMicSilence?.(true);
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No audio detected");
    expect(alert.textContent).toContain("System Default Microphone");

    await act(async () => {
      capturedCallbacks?.onAudioLevel?.(0.4, "user");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a live mic level meter that follows the user audio level", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    render(<LivePane pane={mockPane} />);

    expect(screen.queryByRole("meter", { name: "Microphone level" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });
    await act(async () => {
      capturedCallbacks?.onStatusChange?.("active");
    });

    const meter = screen.getByRole("meter", { name: "Microphone level" });
    expect(meter).toBeDefined();
    expect(meter.getAttribute("aria-valuenow")).toBe("0");

    await act(async () => {
      capturedCallbacks?.onAudioLevel?.(0.52, "user");
    });
    expect(meter.getAttribute("aria-valuenow")).toBe("52");
  });

  it("updates the mic meter and clock without re-rendering the whole pane", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-10T08:15:30.000Z"));
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return { close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn() };
      }
    );
    // LivePane reads the shared live session state once per render.
    const paneRenders = vi.spyOn(liveSessionProviderModule, "useLiveSessionState");

    const { container } = render(<LivePane pane={mockPane} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });
    await act(async () => {
      capturedCallbacks?.onStatusChange?.("active");
    });
    const meter = screen.getByRole("meter", { name: "Microphone level" });
    const subtitle = container.querySelector(".live-session-card-subtitle")!;
    const clockBefore = subtitle.textContent;
    const rendersBefore = paneRenders.mock.calls.length;

    // Levels at or below 0.05 do not touch the mic-silence state.
    for (const level of [0.01, 0.02, 0.03, 0.04, 0.05]) {
      await act(async () => {
        capturedCallbacks?.onAudioLevel?.(level, "user");
      });
      expect(meter.getAttribute("aria-valuenow")).toBe(String(Math.round(level * 100)));
    }
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    expect(subtitle.textContent).not.toBe(clockBefore);
    expect(subtitle.textContent).toContain(":33");
    expect(paneRenders.mock.calls.length).toBe(rendersBefore);
  });

  it("emits onMicSilence after sustained silence and clears it when audio returns", async () => {
    vi.useFakeTimers();
    let analyserValue = 0;
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
      frames.push(cb);
      return frames.length;
    });

    const analyser = {
      fftSize: 256,
      smoothingTimeConstant: 0.3,
      get frequencyBinCount() {
        return 128;
      },
      getByteFrequencyData: vi.fn((arr: Uint8Array) => {
        arr.fill(analyserValue);
      })
    };
    class FakeAudioContext {
      state = "running";
      resume = vi.fn();
      close = vi.fn();
      createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
      createAnalyser = vi.fn(() => analyser);
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);

    const mockChannel = {
      readyState: "open",
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn()
    };
    const mockConnection = {
      createDataChannel: vi.fn(() => mockChannel),
      addEventListener: vi.fn(),
      addTrack: vi.fn(),
      getTransceivers: vi.fn(() => []),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=test" })),
      setLocalDescription: vi.fn(async () => {}),
      setRemoteDescription: vi.fn(async () => {}),
      iceGatheringState: "complete",
      localDescription: { sdp: "v=0\r\no=test" },
      getSenders: vi.fn(() => []),
      close: vi.fn()
    };
    const mockTrack = { enabled: true, stop: vi.fn(), kind: "audio" };
    const mockStream = {
      getAudioTracks: vi.fn(() => [mockTrack]),
      getTracks: vi.fn(() => [mockTrack]),
      clone: vi.fn(() => ({
        getAudioTracks: vi.fn(() => [mockTrack]),
        getTracks: vi.fn(() => [mockTrack])
      }))
    };
    const mockPlatform = {
      userMediaSupported: true,
      peerConnectionSupported: true,
      getUserMedia: vi.fn(async () => mockStream as any),
      createPeerConnection: vi.fn(() => mockConnection as any)
    };

    const runtimeModule = await import("../src/runtime/SpaceRuntime.js");
    runtimeModule.installSpaceRuntime({
      kind: "live",
      platform: mockPlatform as any,
      api: {
        createVoiceRealtimeCall: vi.fn().mockResolvedValue({
          callId: "call_silence",
          answerSdp: "v=0\r\no=answer"
        })
      } as any,
      events: { supported: false, open: vi.fn() as any },
      terminal: { supported: false, connect: vi.fn() as any },
      browser: { supported: false, connect: vi.fn() as any }
    } as any);

    const silenceEvents: boolean[] = [];
    const session = await liveSessionModule.openLiveConversationSession(
      { model: "gpt-live-1", micSilenceWarnMs: 3000 },
      { onMicSilence: (silent) => silenceEvents.push(silent) }
    );

    const step = () => {
      const q = frames.splice(0);
      q.forEach((cb) => cb(performance.now()));
    };

    step();
    vi.advanceTimersByTime(1500);
    step();
    expect(silenceEvents).toEqual([]);

    vi.advanceTimersByTime(1600);
    step();
    expect(silenceEvents).toEqual([true]);

    analyserValue = 60;
    step();
    expect(silenceEvents).toEqual([true, false]);

    session.close();
  });

  it("renders the interactive Live Orb button and 4 top-right icon buttons including voice-only toggle", async () => {
    const { container } = render(<LivePane pane={mockPane} />);

    const orbButton = screen.getByRole("button", { name: "Start session" });
    expect(orbButton).toBeDefined();
    expect(orbButton.classList.contains("live-pane-orb-button")).toBe(true);
    expect(orbButton.querySelector(".live-orb")).not.toBeNull();

    const voiceOnlyBtn = screen.getByRole("button", { name: /enable voice-only mode/i });
    expect(voiceOnlyBtn).toBeDefined();
    expect(voiceOnlyBtn.classList.contains("is-active")).toBe(false);

    // Toggle voice-only mode
    fireEvent.click(voiceOnlyBtn);
    expect(voiceOnlyBtn.classList.contains("is-active")).toBe(true);
    expect(voiceOnlyBtn.getAttribute("aria-label")).toContain("Disable voice-only mode");

    expect(screen.getByRole("button", { name: /mute microphone/i })).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear conversation and logs" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Open live settings" })).toBeDefined();

    expect(container.textContent).not.toContain("Listening for your voice");
  });

  it("respects showToolCalls setting and toggles cleanly in settings", async () => {
    localStorage.setItem("space_live_pane_pane:live-test-1", JSON.stringify({ showToolCalls: false }));
    render(<LivePane pane={mockPane} />);

    // Open settings drawer
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open live settings" }));
    });

    const toggle = screen.getByRole("switch", { name: "Show tool calls in chat" }) as HTMLInputElement;
    expect(toggle).toBeDefined();
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle.checked).toBe(true);
  });

  it("renders the clean telemetry LiveStatsWindow without MCP debugger clutter", async () => {
    const { LiveStatsWindow } = await import("../src/features/live-pane/LiveStatsWindow.js");
    render(<LiveStatsWindow onClose={vi.fn()} />);

    expect(screen.getByText("Live Voice Telemetry")).toBeDefined();
    expect(screen.getByText("Voice & Upstream Models")).toBeDefined();
    expect(screen.getByText("Network & Audio Telemetry")).toBeDefined();
    expect(screen.getByText("DataChannel Traffic")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy Report" })).toBeDefined();

    expect(screen.queryByText("Inspect Room State")).toBeNull();
    expect(screen.queryByText("Run Space Debug")).toBeNull();
    expect(screen.queryByText("Test MCP Tools (Fast)")).toBeNull();
  });

  it("does not render 'Voice-only mode active.' subtitle when voice-only mode is enabled", async () => {
    localStorage.setItem("space_live_pane_pane:live-test-1", JSON.stringify({ voiceOnly: true }));
    const { container } = render(<LivePane pane={mockPane} />);

    expect(screen.queryByText("Voice-only mode active.")).toBeNull();
    expect(screen.getAllByText("Voice-only mode").length).toBeGreaterThan(0);
    expect(container.querySelector(".live-hero-subtitle")).toBeNull();
  });

  it("renders live-session-card before live-transcript-feed in the DOM so dialogue appears underneath", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    const { container } = render(<LivePane pane={mockPane} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });

    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "msg-1",
        role: "assistant",
        text: "Γεια σας!",
        timestamp: "10:00:00 AM"
      });
    });

    const card = container.querySelector(".live-session-card");
    const feed = container.querySelector(".live-transcript-feed");
    expect(card).not.toBeNull();
    expect(feed).not.toBeNull();
    expect(card!.compareDocumentPosition(feed!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("applies 'is-empty' class when transcripts are empty and 'has-transcripts' when transcripts exist", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementation(
      async (_opts, callbacks) => {
        capturedCallbacks = callbacks;
        return {
          close: vi.fn(),
          setMuted: vi.fn(),
          isMuted: () => false,
          sendTextMessage: vi.fn()
        };
      }
    );

    const { container } = render(<LivePane pane={mockPane} />);
    const mainBody = container.querySelector(".live-main-body");
    expect(mainBody?.classList.contains("is-empty")).toBe(true);
    expect(mainBody?.classList.contains("has-transcripts")).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });

    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "msg-test-2",
        role: "user",
        text: "Καλημέρα",
        timestamp: "10:05:00 AM"
      });
    });

    expect(mainBody?.classList.contains("has-transcripts")).toBe(true);
    expect(mainBody?.classList.contains("is-empty")).toBe(false);
    expect(mainBody?.classList.contains("is-compact-dialog")).toBe(true);
    expect(container.querySelector(".live-pane-mini-orb")).not.toBeNull();
  });

  it("does not render 'Tap the sphere to start talking to Gemini Live.' subtitle", () => {
    const { container } = render(<LivePane pane={mockPane} />);
    expect(container.textContent).not.toContain("Tap the sphere to start talking to Gemini Live.");
  });

  it("hides active tool banner when showToolCalls is false, and displays it when showToolCalls is true", async () => {
    localStorage.clear();
    const toolTranscripts = [
      {
        id: "tool-running-1",
        role: "tool",
        text: "Running tool",
        timestamp: "10:00:00 AM",
        toolCall: { name: "space_open_panes", status: "running" }
      }
    ];
    localStorage.setItem("space_live_room_transcripts_room:test", JSON.stringify(toolTranscripts));

    // Case 1: showToolCalls is false
    localStorage.setItem("space_live_pane_pane:live-test-1", JSON.stringify({ showToolCalls: false }));
    const { container, unmount } = render(<LivePane pane={mockPane} />);
    expect(container.querySelector(".live-active-tool-banner")).toBeNull();
    expect(container.textContent).not.toContain("Tool executing: space_open_panes");
    unmount();

    // Case 2: showToolCalls is true
    localStorage.setItem("space_live_room_transcripts_room:test", JSON.stringify(toolTranscripts));
    localStorage.setItem("space_live_pane_pane:live-test-1", JSON.stringify({ showToolCalls: true }));
    const remount = render(<LivePane pane={mockPane} />);
    expect(remount.container.querySelector(".live-active-tool-banner")).not.toBeNull();
    expect(remount.container.textContent).toContain("Tool executing: space_open_panes");
  });

  it("deduplicates identical user transcripts and updates partial user prompts in-place", async () => {
    let capturedCallbacks: liveSessionModule.LiveSessionCallbacks | undefined;
    vi.spyOn(liveSessionModule, "openLiveConversationSession").mockImplementationOnce(async (_opts, callbacks) => {
      capturedCallbacks = callbacks;
      return {
        close: vi.fn(),
        setMuted: vi.fn(),
        isMuted: () => false,
        sendTextMessage: vi.fn()
      };
    });

    const { container } = render(<LivePane pane={mockPane} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    });

    expect(capturedCallbacks).toBeDefined();

    // 1. Partial user prompt arrives
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "user_turn_1_partial",
        role: "user",
        text: "Άρα κλείσε",
        isDelta: false,
        timestamp: "10:00:00 AM"
      });
    });

    // 2. Full user prompt arrives under a different turn ID
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "user_turn_1_full",
        role: "user",
        text: "Άρα κλείσε μου όλα τα παράθυρα",
        isDelta: false,
        timestamp: "10:00:01 AM"
      });
    });

    // 3. Duplicate prompt arrives
    await act(async () => {
      capturedCallbacks?.onTranscriptUpdate?.({
        id: "user_turn_1_dup",
        role: "user",
        text: "Άρα κλείσε μου όλα τα παράθυρα",
        isDelta: false,
        timestamp: "10:00:02 AM"
      });
    });

    // Verify only ONE user bubble exists and contains the full prompt
    const userBubbles = container.querySelectorAll(".live-transcript-bubble.user");
    expect(userBubbles.length).toBe(1);
    expect(userBubbles[0]?.textContent).toContain("Άρα κλείσε μου όλα τα παράθυρα");
  });
});


