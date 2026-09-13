import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Pane } from "@space/contracts";
import {
  openLiveConversationSession,
  getGreetingForThailandTime,
  type LiveInputPart,
  type LiveSessionHandle,
  type LiveTranscriptItem
} from "./live-session.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { api, type LivePersonalMemoryItem } from "../../live-api.js";
import "./live-pane.css";

interface LivePaneProps {
  pane: Pane;
  workspaceTextSize?: number;
}

const VOICE_OPTIONS = [
  { value: "gleam", label: "Gleam" },
  { value: "alloy", label: "Alloy" },
  { value: "ash", label: "Ash" },
  { value: "ballad", label: "Ballad" },
  { value: "coral", label: "Coral" },
  { value: "echo", label: "Echo" },
  { value: "sage", label: "Sage" },
  { value: "shimmer", label: "Shimmer" },
  { value: "bossa", label: "Bossa" },
  { value: "tempo", label: "Tempo" },
  { value: "marin", label: "Marin" },
  { value: "cedar", label: "Cedar" }
];

const TIME_ZONE_OPTIONS = [
  { value: "Asia/Bangkok", label: "Thailand — Bangkok (UTC+7)" },
  { value: "Europe/Athens", label: "Greece — Athens" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "United Kingdom — London" },
  { value: "Europe/Berlin", label: "Germany — Berlin" },
  { value: "America/New_York", label: "United States — New York" },
  { value: "America/Los_Angeles", label: "United States — Los Angeles" },
  { value: "Asia/Tokyo", label: "Japan — Tokyo" },
  { value: "Australia/Sydney", label: "Australia — Sydney" }
];

const VOICE_MODELS = [
  { value: "gpt-live-1", label: "gpt-live-1" },
  { value: "local-qwen3-greek", label: "Local Qwen3 Greek (PC)" }
];

const INITIAL_DELEGATED_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-nano",
  "o3",
  "o4-mini",
  "chat-latest",
  "gpt-3.5-turbo",
  "gpt-5.5-pro",
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-chat-latest",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.1",
  "gpt-5.1-chat-latest",
  "gpt-5.1-codex",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "o3-mini",
  "o3-pro",
  "o1",
  "o1-mini",
  "o1-pro",
  "gpt-4-turbo",
  "gpt-4"
];

const REASONING_EFFORTS = [
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" }
];

export interface LivePaneStoredConfig {
  prompt?: string;
  voiceModel?: string;
  voice?: string;
  language?: "auto" | "el" | "en";
  timeZone?: string;
  opening?: string;
  voicePrompt?: string;
  delegatedModel?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  webSearch?: boolean;
  delegatedPrompt?: string;
  geminiMemoryEnabled?: boolean;
  selectedDeviceId?: string;
  voiceOnly?: boolean;
  personalMemoryCollapsed?: boolean;
  personalMemories?: LivePersonalMemoryItem[];
}

const DEFAULT_PERSONAL_MEMORIES: LivePersonalMemoryItem[] = [{
  id: "mem_user_name",
  key: "userName",
  value: "Νικόλας",
  category: "profile",
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z"
}];

function loadStoredPersonalMemories(): LivePersonalMemoryItem[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("space_live_personal_memory") : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return [...DEFAULT_PERSONAL_MEMORIES];
}

function saveStoredPersonalMemories(items: LivePersonalMemoryItem[]) {
  try { localStorage.setItem("space_live_personal_memory", JSON.stringify(items)); } catch {}
}

export function loadLivePaneConfig(paneId: string): LivePaneStoredConfig {
  try {
    const raw =
      (typeof localStorage !== "undefined" && localStorage.getItem(`space_live_pane_${paneId}`)) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("space_live_pane_default"));
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

export function saveLivePaneConfig(paneId: string, config: LivePaneStoredConfig) {
  try {
    if (typeof localStorage === "undefined") return;
    const serialized = JSON.stringify(config);
    localStorage.setItem(`space_live_pane_${paneId}`, serialized);
    localStorage.setItem("space_live_pane_default", serialized);
  } catch {}
}

export function LivePane({ pane, workspaceTextSize = 14 }: LivePaneProps) {
  const initialConfig = useRef<LivePaneStoredConfig | null>(null);
  if (!initialConfig.current) {
    initialConfig.current = loadLivePaneConfig(pane.id);
  }
  const cfg = initialConfig.current;

  const [personalMemories, setPersonalMemories] = useState<LivePersonalMemoryItem[]>(
    cfg.personalMemories?.length ? cfg.personalMemories : loadStoredPersonalMemories()
  );
  const [personalMemoryCollapsed, setPersonalMemoryCollapsed] = useState(cfg.personalMemoryCollapsed ?? false);
  const [newMemoryKey, setNewMemoryKey] = useState("");
  const [newMemoryValue, setNewMemoryValue] = useState("");

  const [prompt, setPrompt] = useState(cfg.prompt ?? "");
  const [voiceModel, setVoiceModel] = useState("gpt-live-1");
  const [voice, setVoice] = useState(cfg.voice ?? "gleam");
  const [language, setLanguage] = useState<"auto" | "el" | "en">(cfg.language ?? "auto");
  const userName = personalMemories.find((m) => m.key.toLowerCase() === "username")?.value || "Νικόλας";
  const [timeZone, setTimeZone] = useState(cfg.timeZone ?? "Asia/Bangkok");
  const [opening, setOpening] = useState(cfg.opening?.trim() || getGreetingForThailandTime(userName, timeZone));
  const [voicePrompt, setVoicePrompt] = useState(cfg.voicePrompt ?? "");

  const [delegatedType] = useState<"responses" | "client">("responses");
  const [delegatedModel, setDelegatedModel] = useState(cfg.delegatedModel ?? "gpt-5.6-terra");
  const [modelsList, setModelsList] = useState<string[]>(() => {
    const base = [...INITIAL_DELEGATED_MODELS];
    if (cfg.delegatedModel && !base.includes(cfg.delegatedModel)) {
      base.unshift(cfg.delegatedModel);
    }
    return base;
  });
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<"minimal" | "low" | "medium" | "high" | "xhigh">(
    cfg.reasoningEffort ?? "medium"
  );
  const [webSearch, setWebSearch] = useState(cfg.webSearch ?? true);
  const [delegatedPrompt, setDelegatedPrompt] = useState(cfg.delegatedPrompt ?? "");
  const [geminiMemoryEnabled, setGeminiMemoryEnabled] = useState(cfg.geminiMemoryEnabled ?? true);
  const [voiceOnly, setVoiceOnly] = useState(cfg.voiceOnly ?? false);

  const [voiceModelCollapsed, setVoiceModelCollapsed] = useState(false);
  const [delegatedModelCollapsed, setDelegatedModelCollapsed] = useState(false);

  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "listening" | "speaking" | "error">("idle");
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(cfg.selectedDeviceId ?? "");
  const [muted, setMuted] = useState(false);
  const [userAudioLevel, setUserAudioLevel] = useState(0);
  const [micSilent, setMicSilent] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<LiveInputPart[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [clockNow, setClockNow] = useState(() => new Date());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const sessionRef = useRef<LiveSessionHandle | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    saveLivePaneConfig(pane.id, {
      prompt,
      voiceModel,
      voice,
      language,
      timeZone,
      opening,
      voicePrompt,
      delegatedModel,
      reasoningEffort,
      webSearch,
      delegatedPrompt,
      geminiMemoryEnabled,
      selectedDeviceId,
      voiceOnly,
      personalMemoryCollapsed,
      personalMemories
    });
  }, [
    pane.id,
    prompt,
    voiceModel,
    voice,
    language,
    timeZone,
    opening,
    voicePrompt,
    delegatedModel,
    reasoningEffort,
    webSearch,
    delegatedPrompt,
    geminiMemoryEnabled,
    selectedDeviceId,
    voiceOnly,
    personalMemoryCollapsed,
    personalMemories
  ]);

  useEffect(() => {
    let active = true;
    void api.getLivePersonalMemory().then((response) => {
      if (active && response.items?.length) {
        setPersonalMemories(response.items);
        saveStoredPersonalMemories(response.items);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function savePersonalMemory() {
    const key = newMemoryKey.trim();
    const value = newMemoryValue.trim();
    if (!key || !value) return;
    try {
      const response = await api.saveLivePersonalMemory({ key, value, category: "profile" });
      setPersonalMemories((current) => {
        const next = [...current.filter((item) => item.key.toLowerCase() !== key.toLowerCase()), response.item];
        saveStoredPersonalMemories(next);
        return next;
      });
    } catch {}
    setNewMemoryKey("");
    setNewMemoryValue("");
  }

  async function deletePersonalMemory(item: LivePersonalMemoryItem) {
    await api.deleteLivePersonalMemory(item.id).catch(() => undefined);
    setPersonalMemories((current) => {
      const next = current.filter((candidate) => candidate.id !== item.id);
      saveStoredPersonalMemories(next);
      return next;
    });
  }

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "LivePane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "LivePane",
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
      sessionRef.current?.close();
    };
  }, [pane.id, pane.mode, pane.title]);

  useEffect(() => {
    async function getDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        setAudioDevices(audioInputs);
      } catch {}
    }
    void getDevices();
  }, []);

  useEffect(() => {
    transcriptBottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [transcripts]);

  useEffect(() => {
    let active = true;
    async function loadModels() {
      try {
        const res = await api.openAiModels();
        if (active && res.models && res.models.length > 0) {
          const priority = [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-5.5",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.4-nano",
            "o3",
            "o4-mini",
            "chat-latest",
            "gpt-3.5-turbo"
          ];
          const set = new Set(res.models);
          if (cfg.delegatedModel && !set.has(cfg.delegatedModel)) {
            set.add(cfg.delegatedModel);
          }
          const head = priority.filter((m) => set.has(m));
          const tail = Array.from(set).filter((m) => !priority.includes(m)).sort();
          setModelsList([...head, ...tail]);
        }
      } catch {
        // Keeps initial models
      }
    }
    void loadModels();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!modelPickerOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModelPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [modelPickerOpen]);

  const filteredModels = modelsList.filter((m) =>
    m.toLowerCase().includes(modelSearch.trim().toLowerCase())
  );

  function closeSettings() {
    setSettingsOpen(false);
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }

  async function handleToggleSession() {
    if (status !== "idle" && status !== "error") {
      sessionRef.current?.close();
      sessionRef.current = null;
      setStatus("idle");
      setUserAudioLevel(0);
      setMicSilent(false);
      return;
    }

    setError(null);
    setMicSilent(false);
    try {
      const combinedPrompt = [prompt.trim(), voicePrompt.trim()].filter(Boolean).join("\n\n");
      const handle = await openLiveConversationSession(
        {
          paneId: pane.id,
          model: voiceModel,
          language,
          voice: voice as any,
          opening: opening.trim() || undefined,
          prompt: combinedPrompt || undefined,
          delegatedModel,
          delegatedType,
          delegatedReasoningEffort: reasoningEffort,
          delegatedWebSearch: webSearch,
          delegatedPrompt: delegatedPrompt.trim() || undefined,
          audioDeviceId: selectedDeviceId || undefined,
          enableGeminiMemory: geminiMemoryEnabled,
          timeZone,
          personalMemories
        },
        {
          onStatusChange: (newStatus) => {
            setStatus(newStatus);
            if (newStatus === "idle" || newStatus === "error") {
              setUserAudioLevel(0);
              setMicSilent(false);
            }
          },
          onAudioLevel: (level, source) => {
            if (source === "user") {
              setUserAudioLevel(level);
              if (level > 0.05) {
                setMicSilent(false);
              }
            }
          },
          onMicSilence: (silent) => {
            setMicSilent(silent);
          },
          onPersonalMemoryUpdate: (item) => {
            setPersonalMemories((current) => {
              const next = [...current.filter((candidate) => candidate.key.toLowerCase() !== item.key.toLowerCase()), item];
              saveStoredPersonalMemories(next);
              return next;
            });
          },
          onRemoteStream: (stream) => {
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = stream;
              remoteAudioRef.current.play().catch((err) => console.warn("Mounted audio play error:", err));
            }
          },
          onTranscriptUpdate: (item) => {
            setTranscripts((prev) => {
              const normalized = item.text.trim().replace(/\s+/g, " ").toLowerCase();
              if (!item.isDelta && normalized && prev.slice(-4).some((candidate) =>
                candidate.role === item.role && candidate.text.trim().replace(/\s+/g, " ").toLowerCase() === normalized
              )) return prev;
              const existingIdx = prev.findIndex((i) => i.id === item.id);
              if (existingIdx >= 0) {
                const next = [...prev];
                const current = next[existingIdx]!;
                if (!item.isDelta && current.text.trim() === item.text.trim()) return prev;
                next[existingIdx] = {
                  ...item,
                  text: item.isDelta ? current.text + item.text : item.text
                };
                return next;
              }
              return [...prev, item];
            });
          },
          onError: (errMsg) => setError(errMsg)
        }
      );
      sessionRef.current = handle;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Live session.");
      setStatus("error");
    }
  }

  function handleMuteToggle() {
    if (!sessionRef.current) return;
    const next = !muted;
    sessionRef.current.setMuted(next);
    setMuted(next);
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(files: FileList | File[]) {
    const next: LiveInputPart[] = [];
    for (const file of Array.from(files).slice(0, 4)) {
      if (file.size > 10 * 1024 * 1024) continue;
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (file.type.startsWith("image/")) next.push({ type: "image", dataUrl, filename: file.name });
        else next.push({ type: "file", dataUrl, filename: file.name, mimeType: file.type || "application/octet-stream" });
      } catch {}
    }
    setPendingInputs((prev) => [...prev, ...next].slice(-4));
  }

  async function captureVisual(source: "camera" | "screen") {
    try {
      const stream = source === "camera"
        ? await navigator.mediaDevices.getUserMedia({ video: true })
        : await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1280, settings?.width || 1280);
      canvas.height = Math.min(720, settings?.height || 720);
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 120));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      track?.stop();
      const image: LiveInputPart = { type: "image", dataUrl: canvas.toDataURL("image/jpeg", 0.82), filename: `${source}-capture.jpg` };
      setPendingInputs((prev) => [...prev, image].slice(-4));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${source} capture was not available.`);
    }
  }

  const isLive = status === "active" || status === "listening" || status === "speaking" || status === "connecting";

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; action?: string }>).detail;
      if (detail?.paneId !== pane.id || !isLive) return;
      if (detail.action === "attach") fileInputRef.current?.click();
      if (detail.action === "camera") void captureVisual("camera");
      if (detail.action === "screen") void captureVisual("screen");
    };
    window.addEventListener("space-live-pane-action", onAction);
    return () => window.removeEventListener("space-live-pane-action", onAction);
  }, [pane.id, isLive]);

  function sendPendingInputs() {
    if (!sessionRef.current || pendingInputs.length === 0) return;
    sessionRef.current.sendInput?.(pendingInputs);
    setPendingInputs([]);
  }

  const selectedDeviceLabel =
    (selectedDeviceId && audioDevices.find((d) => d.deviceId === selectedDeviceId)?.label) ||
    "System Default Microphone";

  return (
    <section
      className="live-pane-root"
      aria-label={`Live audio pane ${pane.title}`}
      data-live-pane-id={pane.id}
      data-live-status={status}
      style={{ "--live-text-size": `${workspaceTextSize}px` } as CSSProperties}
    >
      <aside className={`live-pane-sidebar ${settingsOpen ? "is-open" : ""}`} aria-label="Live settings" aria-hidden={!settingsOpen}>
        <div className="live-settings-header">
          <span>Live settings</span>
          <button type="button" className="live-settings-close" aria-label="Close live settings" title="Close live settings" onClick={closeSettings}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="live-pane-sidebar-content">
          <div className="live-sidebar-section">
            <div className="live-section-header">
              <span>Start from a prompt</span>
              <a
                href="#prompt-guide"
                className="live-section-header-link"
                onClick={(e) => {
                  e.preventDefault();
                  alert("Live Prompt Guide:\nDefine personality, tone, language, and guidelines for tool usage.");
                }}
              >
                Prompting guide ^
              </a>
            </div>
            <textarea
              className="live-prompt-textarea"
              placeholder="Start with a single prompt to define your agent, how it should speak, and what it should do, or edit the model prompts separately..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isLive}
              aria-label="Agent prompt"
            />
            <div className="live-sidebar-buttons-row">
              <button
                type="button"
                className="live-btn-secondary"
                disabled={isLive}
                onClick={() =>
                  setPrompt(
                    "You are an expert Space system assistant with direct access to Gemini memory. Answer inquiries concisely and recall memory for historical facts."
                  )
                }
              >
                Templates
              </button>
              <button
                type="button"
                className="live-btn-secondary"
                disabled={isLive}
                onClick={() =>
                  setVoicePrompt("Speak naturally with a helpful, friendly cadence and pause for clarification.")
                }
              >
                Generate model prompts
              </button>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #30363d)", margin: "4px 0" }} />

          <div className="live-sidebar-section">
            <div className="live-section-header">
              <span>Audio &amp; time</span>
            </div>
            <div className="live-form-group">
              <label className="live-form-label" htmlFor="live-time-zone">Region time</label>
              <select
                id="live-time-zone"
                className="live-select"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                disabled={isLive}
              >
                {TIME_ZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="live-form-group">
              <label className="live-form-label" htmlFor="live-microphone-input">Microphone</label>
              <select
                id="live-microphone-input"
                className="live-select"
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                disabled={isLive}
                aria-label="Microphone input device"
              >
                <option value="">System Default Microphone</option>
                {audioDevices.map((d, i) => (
                  <option key={d.deviceId || String(i)} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
                ))}
              </select>
            </div>
            <div className="live-toggle-row">
              <span className="live-toggle-label">Voice-only mode</span>
              <label className="live-switch">
                <input
                  type="checkbox"
                  aria-label="Voice-only mode"
                  checked={voiceOnly}
                  onChange={(e) => setVoiceOnly(e.target.checked)}
                />
                <span className="live-slider" />
              </label>
            </div>
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #30363d)", margin: "4px 0" }} />

          <div className="live-sidebar-section">
            <div
              className="live-section-header"
              onClick={() => setVoiceModelCollapsed((prev) => !prev)}
              role="button"
              tabIndex={0}
            >
              <span>Voice model</span>
              <span>{voiceModelCollapsed ? "+" : "^"}</span>
            </div>

            {!voiceModelCollapsed && (
              <>
                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-voice-model-select">
                    Model
                  </label>
                  <select
                    id="live-voice-model-select"
                    className="live-select"
                    value={voiceModel}
                    onChange={(e) => setVoiceModel(e.target.value)}
                    disabled={isLive}
                  >
                    {VOICE_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-voice-select">
                    Voice
                  </label>
                  <select
                    id="live-voice-select"
                    className="live-select"
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    disabled={isLive}
                  >
                    {VOICE_OPTIONS.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-language-select">
                    Language
                  </label>
                  <select
                    id="live-language-select"
                    className="live-select"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as "auto" | "el" | "en")}
                    disabled={isLive}
                  >
                    <option value="auto">Auto (Bilingual Ελληνικά / English)</option>
                    <option value="el">Ελληνικά (Greek)</option>
                    <option value="en">English</option>
                  </select>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-opening-input">
                    Opening
                  </label>
                  <input
                    id="live-opening-input"
                    type="text"
                    className="live-input"
                    placeholder="Optional first words"
                    value={opening}
                    onChange={(e) => setOpening(e.target.value)}
                    disabled={isLive}
                  />
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-voice-prompt">
                    Prompt
                  </label>
                  <textarea
                    id="live-voice-prompt"
                    className="live-prompt-textarea"
                    style={{ minHeight: "60px" }}
                    placeholder="+ Add custom voice instructions"
                    value={voicePrompt}
                    onChange={(e) => setVoicePrompt(e.target.value)}
                    disabled={isLive}
                  />
                </div>
              </>
            )}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #30363d)", margin: "4px 0" }} />

          <div className="live-sidebar-section">
            <div
              className="live-section-header"
              onClick={() => setDelegatedModelCollapsed((prev) => !prev)}
              role="button"
              tabIndex={0}
            >
              <span>Delegated model</span>
              <span>{delegatedModelCollapsed ? "+" : "^"}</span>
            </div>

            {!delegatedModelCollapsed && (
              <>
                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-delegated-type">
                    Type
                  </label>
                  <input
                    id="live-delegated-type"
                    type="text"
                    className="live-input"
                    value={delegatedType === "responses" ? "Responses" : "Client"}
                    readOnly
                  />
                </div>

                <div className="live-form-group" ref={modelPickerRef}>
                  <label className="live-form-label" htmlFor="live-delegated-model">
                    Model
                  </label>
                  <div className="live-model-picker-container">
                    <button
                      type="button"
                      id="live-delegated-model"
                      aria-haspopup="listbox"
                      aria-expanded={modelPickerOpen}
                      className="live-select live-model-trigger"
                      onClick={() => !isLive && setModelPickerOpen((prev) => !prev)}
                      disabled={isLive}
                    >
                      <span className="live-model-trigger-text">{delegatedModel}</span>
                      <span className="live-model-trigger-icon">↕</span>
                    </button>

                    {modelPickerOpen && (
                      <div className="live-model-picker-menu">
                        <div className="live-model-search-box">
                          <svg className="live-model-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                          </svg>
                          <input
                            type="text"
                            className="live-model-search-input"
                            placeholder="Select a model..."
                            value={modelSearch}
                            onChange={(e) => setModelSearch(e.target.value)}
                            autoFocus
                          />
                        </div>
                        <div className="live-model-list" role="listbox">
                          {filteredModels.map((m) => {
                            const isSelected = m === delegatedModel;
                            return (
                              <div
                                key={m}
                                role="option"
                                aria-selected={isSelected}
                                className={`live-model-item ${isSelected ? "selected" : ""}`}
                                onClick={() => {
                                  setDelegatedModel(m);
                                  setModelPickerOpen(false);
                                  setModelSearch("");
                                }}
                              >
                                <span className="live-model-check">{isSelected ? "✓" : ""}</span>
                                <span className="live-model-name">{m}</span>
                              </div>
                            );
                          })}
                          {filteredModels.length === 0 && modelSearch.trim() && (
                            <div
                              role="option"
                              aria-selected={false}
                              className="live-model-item"
                              onClick={() => {
                                setDelegatedModel(modelSearch.trim());
                                setModelPickerOpen(false);
                                setModelSearch("");
                              }}
                            >
                              <span className="live-model-check"></span>
                              <span className="live-model-name">Use &quot;{modelSearch.trim()}&quot;</span>
                            </div>
                          )}
                          {filteredModels.length === 0 && !modelSearch.trim() && (
                            <div className="live-model-empty">No models available</div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-reasoning-effort">
                    Reasoning effort
                  </label>
                  <select
                    id="live-reasoning-effort"
                    className="live-select"
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value as any)}
                    disabled={isLive}
                  >
                    {REASONING_EFFORTS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="live-toggle-row">
                  <span className="live-toggle-label">Web search</span>
                  <label className="live-switch">
                    <input
                      type="checkbox"
                      aria-label="Web search"
                      checked={webSearch}
                      onChange={(e) => setWebSearch(e.target.checked)}
                      disabled={isLive}
                    />
                    <span className="live-slider" />
                  </label>
                </div>

                <div className="live-toggle-row">
                  <span className="live-toggle-label">Gemini Memory Access</span>
                  <label className="live-switch">
                    <input
                      type="checkbox"
                      aria-label="Gemini Memory Access"
                      checked={geminiMemoryEnabled}
                      onChange={(e) => setGeminiMemoryEnabled(e.target.checked)}
                      disabled={isLive}
                    />
                    <span className="live-slider" />
                  </label>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-delegated-prompt">
                    Prompt
                  </label>
                  <textarea
                    id="live-delegated-prompt"
                    className="live-prompt-textarea"
                    style={{ minHeight: "60px" }}
                    placeholder="+ Add delegated model prompt"
                    value={delegatedPrompt}
                    onChange={(e) => setDelegatedPrompt(e.target.value)}
                    disabled={isLive}
                  />
                </div>

                <div className="live-form-group">
                  <label className="live-form-label">Functions</label>
                  <div className="live-functions-box">
                    {geminiMemoryEnabled && (
                      <div className="live-function-item">
                        <span>recall_gemini_memory</span>
                        <span className="live-function-tag">Gemini Memory</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="live-btn-secondary"
                      style={{ marginTop: "4px" }}
                      disabled={isLive}
                      onClick={() => alert("Gemini memory tool is natively configured and active.")}
                    >
                      + Add function
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #30363d)", margin: "4px 0" }} />

          <div className="live-sidebar-section">
            <div
              className="live-section-header"
              onClick={() => setPersonalMemoryCollapsed((prev) => !prev)}
              role="button"
              tabIndex={0}
            >
              <span>Personal Memory</span>
              <span>{personalMemoryCollapsed ? "+" : "^"}</span>
            </div>
            {!personalMemoryCollapsed && (
              <>
                <div className="live-functions-box" aria-label="Personal memory entries">
                  {personalMemories.map((item) => (
                    <div className="live-function-item" key={item.id}>
                      <span title={item.value}>{item.key}: {item.value}</span>
                      <button
                        type="button"
                        className="live-btn-secondary"
                        aria-label={`Delete personal memory ${item.key}`}
                        onClick={() => void deletePersonalMemory(item)}
                        disabled={isLive}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-memory-key">Key</label>
                  <input
                    id="live-memory-key"
                    className="live-input"
                    value={newMemoryKey}
                    onChange={(e) => setNewMemoryKey(e.target.value)}
                    placeholder="e.g. favoriteLanguage"
                    disabled={isLive}
                  />
                </div>
                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-memory-value">Value</label>
                  <input
                    id="live-memory-value"
                    className="live-input"
                    value={newMemoryValue}
                    onChange={(e) => setNewMemoryValue(e.target.value)}
                    placeholder="e.g. Greek"
                    disabled={isLive}
                  />
                </div>
                <button type="button" className="live-btn-secondary" onClick={() => void savePersonalMemory()} disabled={isLive || !newMemoryKey.trim() || !newMemoryValue.trim()}>
                  Save memory
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="live-pane-main">
        <div className="live-main-body">
          {error && (
            <div className="live-error-banner" role="alert">
              <strong>Error:</strong> {error}
            </div>
          )}

          {isLive && micSilent && (
            <div className="live-mic-warning" role="alert">
              <strong>No audio detected</strong> from {selectedDeviceLabel}. Check the microphone permission or mute switch.
            </div>
          )}

          {!voiceOnly && transcripts.length > 0 && (
            <div className="live-transcript-feed" role="log" aria-label="Chat transcript">
              {transcripts.map((item) => (
                <div key={item.id} className={`live-transcript-bubble ${item.role}`}>
                  <div className="live-transcript-text">{item.text}</div>
                  <div className="live-transcript-meta">
                    {item.role === "user" ? "You" : item.role === "assistant" ? "GPT-Live" : "System"} • {item.timestamp}
                  </div>
                </div>
              ))}
              <div ref={transcriptBottomRef} />
            </div>
          )}

          <section className={`live-session-card ${isLive ? "is-live" : ""}`} aria-label="Live controls">
            <div className="live-session-card-header">
              <div>
                <div className="live-session-card-title">{voiceOnly ? "Voice-only mode" : "Talk to GPT-Live"}</div>
                <div className="live-session-card-subtitle">
                  {new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(clockNow)} · {TIME_ZONE_OPTIONS.find((option) => option.value === timeZone)?.label || timeZone}
                </div>
              </div>
              <div className="live-session-card-tools">
                <span className={`live-status-pill ${status}`}><span className={`live-status-dot ${status}`} />{status}</span>
                <button
                  ref={settingsButtonRef}
                  type="button"
                  className="live-settings-open"
                  aria-label="Open live settings"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen(true)}
                >
                  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4V19a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 3.4 11H3a2 2 0 0 1 0-4h.2a2 2 0 0 0 1.4-3.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 11 2.6V2a2 2 0 0 1 4 0v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 20.6 10h.2a2 2 0 0 1 0 4h-.2a2 2 0 0 0-1.2 1Z"/></svg>
                </button>
              </div>
            </div>

            {transcripts.length === 0 && (
              <>
                <div
                  className={`live-waveform-orb ${status === "listening" || userAudioLevel > 0.05 ? "is-listening" : status === "speaking" ? "is-speaking" : ""}`}
                  style={userAudioLevel > 0.05 ? { transform: `scale(${1 + Math.min(0.4, userAudioLevel * 0.4)})` } : undefined}
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                </div>
                <p className="live-hero-subtitle">
                  {voiceOnly ? "Chat transcript is disabled. Audio status and microphone controls remain active." : "Start a voice conversation using your microphone."}
                </p>
              </>
            )}

            <div className="live-session-actions">
              <button
                type="button"
                className={`live-btn-session ${isLive ? "is-stop" : "is-start"}`}
                onClick={() => void handleToggleSession()}
                aria-label={isLive ? "End session" : "Start session"}
                disabled={status === "connecting"}
              >
                {isLive ? "End session" : "Start session"}
              </button>
              {isLive && (
                <button type="button" className="live-btn-secondary" onClick={handleMuteToggle} aria-label={muted ? "Unmute microphone" : "Mute microphone"}>
                  {muted ? "Unmute" : "Mute"}
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                accept="image/*,.pdf,.txt,.md,.json,.csv"
                onChange={(event) => {
                  if (event.target.files) void handleFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              {pendingInputs.length > 0 && (
                <button type="button" className="live-btn-secondary live-send-inputs" onClick={sendPendingInputs} disabled={!isLive}>
                  Send {pendingInputs.length} input{pendingInputs.length === 1 ? "" : "s"}
                </button>
              )}
            </div>

            <div className="live-session-card-footer">
              {isLive && <span className="live-session-hint">Listening for your voice</span>}
              {isLive && (
                <div className="live-mic-level" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, userAudioLevel) * 100)}>
                  <div className="live-mic-level-fill" style={{ width: `${Math.min(100, Math.round(userAudioLevel * 100))}%` }} />
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />
    </section>
  );
}
