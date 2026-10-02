import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Pane, LiveAudioProviderId } from "@space/contracts";
import {
  getAllLiveAudioProviders,
  getModelsForProvider,
  getVoicesForProvider,
  getDefaultModelForProvider,
  getDefaultVoiceForProvider,
  inferProviderFromModel
} from "@space/contracts";
import {
  loadLiveConversationSession,
  getGreetingForThailandTime,
  mergeTranscriptText,
  type LiveInputPart,
  type LiveSessionHandle,
  type LiveTranscriptItem
} from "./live-session-loader.js";
import { useLiveCoordinator, useLiveSessionState } from "./LiveSessionProvider.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { api, type LivePersonalMemoryItem } from "../../api.js";
import "./live-pane.css";
import {
  updateLiveSessionStats,
  getLiveSessionStats,
  subscribeLiveSessionStats,
  type LiveSessionStats
} from "./live-stats.js";
import { captureLiveVisual } from "./live-visual-capture.js";
import { loadLivePaneConfig, saveLivePaneConfig, type LivePaneStoredConfig } from "./live-pane-config.js";

interface LivePaneProps {
  pane: Pane;
  workspaceTextSize?: number;
  mobile?: boolean;
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

function loadStoredPersonalMemories(): LivePersonalMemoryItem[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("space_live_personal_memory") : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {}
  return [];
}

function saveStoredPersonalMemories(items: LivePersonalMemoryItem[]) {
  try { localStorage.setItem("space_live_personal_memory", JSON.stringify(items)); } catch {}
}

export function LivePane({ pane, workspaceTextSize = 14, mobile = false }: LivePaneProps) {
  const initialConfig = useRef<LivePaneStoredConfig | null>(null);
  if (!initialConfig.current) {
    initialConfig.current = loadLivePaneConfig(pane.id);
  }
  const cfg = initialConfig.current;
  const [streamingMode, setStreamingMode] = useState(cfg.streamingMode ?? false);
  const coordinator = useLiveCoordinator();
  const sharedState = useLiveSessionState();
  const shared = !streamingMode && coordinator !== null;

  const [personalMemories, setPersonalMemories] = useState<LivePersonalMemoryItem[]>(() => loadStoredPersonalMemories());
  const memoryRevisionRef = useRef<number | undefined>(undefined);
  const [personalMemoryCollapsed, setPersonalMemoryCollapsed] = useState(cfg.personalMemoryCollapsed ?? false);
  const [newMemoryKey, setNewMemoryKey] = useState("");
  const [newMemoryValue, setNewMemoryValue] = useState("");

  const [prompt, setPrompt] = useState(cfg.prompt ?? "");
  const initialProvider: LiveAudioProviderId =
    cfg.provider ?? (cfg.voiceModel ? inferProviderFromModel(cfg.voiceModel) : "openai");
  const [provider, setProvider] = useState<LiveAudioProviderId>(initialProvider);
  const [voiceModel, setVoiceModel] = useState(
    cfg.voiceModel ?? getDefaultModelForProvider(initialProvider)
  );
  const [voice, setVoice] = useState(
    cfg.voice ?? getDefaultVoiceForProvider(initialProvider)
  );
  const [language, setLanguage] = useState<"auto" | "el" | "en">(cfg.language ?? "auto");
  const userName = personalMemories.find((m) => m.key.toLowerCase() === "username")?.value || "";
  const [timeZone, setTimeZone] = useState(cfg.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const [opening, setOpening] = useState(cfg.opening?.trim() || "");
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
    cfg.reasoningEffort && cfg.reasoningEffort !== "medium" ? cfg.reasoningEffort : "minimal"
  );
  const [webSearch, setWebSearch] = useState(cfg.webSearch ?? true);
  const [delegatedPrompt, setDelegatedPrompt] = useState(cfg.delegatedPrompt ?? "");
  const [geminiMemoryEnabled, setGeminiMemoryEnabled] = useState(cfg.geminiMemoryEnabled ?? true);
  const [enableMcpTools, setEnableMcpTools] = useState(cfg.enableMcpTools ?? true);
  const [enableProfileMemory, setEnableProfileMemory] = useState(cfg.enableProfileMemory ?? true);
  const [voiceOnly, setVoiceOnly] = useState(cfg.voiceOnly ?? false);
  const [showToolCalls, setShowToolCalls] = useState(cfg.showToolCalls ?? false);

  const [voiceModelCollapsed, setVoiceModelCollapsed] = useState(false);
  const [memoryControlCollapsed, setMemoryControlCollapsed] = useState(false);
  const [delegatedModelCollapsed, setDelegatedModelCollapsed] = useState(false);
  const [newMemoryCategory, setNewMemoryCategory] = useState<"core" | "profile" | "preference" | "fact" | "instruction" | "note">("profile");

  const availableModels = getModelsForProvider(provider);
  const availableVoices = getVoicesForProvider(provider);

  const handleProviderChange = (newProvider: LiveAudioProviderId) => {
    setProvider(newProvider);
    const newModel = getDefaultModelForProvider(newProvider);
    setVoiceModel(newModel);
    const models = getModelsForProvider(newProvider);
    const modelDef = models.find((m) => m.id === newModel);
    setVoice(modelDef?.defaultVoice ?? getDefaultVoiceForProvider(newProvider));
  };

  const handleModelChange = (newModelId: string) => {
    setVoiceModel(newModelId);
    const modelDef = availableModels.find((m) => m.id === newModelId);
    if (modelDef?.defaultVoice) {
      setVoice(modelDef.defaultVoice);
    }
  };

  useEffect(() => {
    if (availableVoices.length > 0 && !availableVoices.some((v) => v.id === voice)) {
      const modelDef = availableModels.find((m) => m.id === voiceModel);
      const fallbackVoice = (modelDef?.defaultVoice && availableVoices.some((v) => v.id === modelDef.defaultVoice))
        ? modelDef.defaultVoice
        : availableVoices[0]!.id;
      setVoice(fallbackVoice);
    }
  }, [availableVoices, voice, voiceModel, availableModels]);

  const [status, setStatus] = useState<"idle" | "connecting" | "active" | "listening" | "thinking" | "speaking" | "error">("idle");
  const [stats, setStats] = useState<LiveSessionStats>(() => getLiveSessionStats());
  useEffect(() => {
    return subscribeLiveSessionStats(setStats);
  }, []);
  const storageKey = streamingMode
    ? `space_streaming_live_pane_transcripts_${pane.id}`
    : pane.roomId ? `space_live_room_transcripts_${pane.roomId}` : `space_live_pane_transcripts_${pane.id}`;
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey) || (!streamingMode && sessionStorage.getItem(`space_live_pane_transcripts_${pane.id}`));
      return raw ? (JSON.parse(raw) as LiveTranscriptItem[]) : [];
    } catch {
      return [];
    }
  });

  const handleClearConversationAndLogs = useCallback(async () => {
    const now = Date.now();
    if (now - (clearGuardRef.current || 0) < 1500) return;
    clearGuardRef.current = now;
    if (shared) {
      if (pane.roomId) {
        await coordinator.clearRoom(pane.roomId);
      } else {
        await coordinator.clearAll();
      }
      setTranscripts([]);
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(storageKey);
        }
      } catch {}
      return;
    }
    setTranscripts([]);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(storageKey);
      }
    } catch {}
    if (pane.roomId && !streamingMode) {
      void api.clearVoiceRealtimeLogs(pane.roomId);
    }
    if (typeof window !== "undefined" && !streamingMode) {
      window.dispatchEvent(new CustomEvent("space-live-clear-transcripts", {
        detail: { roomId: pane.roomId || "global" }
      }));
    }
  }, [pane.roomId, storageKey, streamingMode, shared, coordinator]);

  useEffect(() => {
    if (shared) return;
    const onClear = () => {
      void handleClearConversationAndLogs();
    };
    window.addEventListener("space-live-rail-clear-conversation", onClear);
    window.addEventListener("space-live-clear-transcripts", onClear);
    return () => {
      window.removeEventListener("space-live-rail-clear-conversation", onClear);
      window.removeEventListener("space-live-clear-transcripts", onClear);
    };
  }, [handleClearConversationAndLogs, shared]);

  useEffect(() => {
    const handleSync = (event: Event) => {
      if (streamingMode || shared) return;
      if (sessionRef.current) return;
      const customEvent = event as CustomEvent<{ roomId?: string; item?: LiveTranscriptItem; sourcePaneId?: string }>;
      if (customEvent.detail?.sourcePaneId === pane.id) return;
      const item = customEvent.detail?.item;
      if (!item) return;
      const targetRoom = customEvent.detail?.roomId;
      if (targetRoom && pane.roomId && targetRoom !== pane.roomId && targetRoom !== "global") return;
      setTranscripts((prev) => {
        if (item.isDelta) {
          const last = prev[prev.length - 1];
          if (last && last.role === item.role && (last.id === item.id || !item.id)) {
            return [
              ...prev.slice(0, -1),
              { ...last, text: mergeTranscriptText(last.text, item.text) }
            ];
          }
          const existingIdx = prev.findIndex((candidate) => candidate.id === item.id);
          if (existingIdx !== -1) {
            const next = [...prev];
            next[existingIdx] = { ...next[existingIdx]!, text: mergeTranscriptText(next[existingIdx]!.text, item.text) };
            return next;
          }
          return [...prev, { ...item, isDelta: false }];
        }
        const existingIdx = prev.findIndex((candidate) => candidate.id === item.id);
        if (existingIdx !== -1) {
          const next = [...prev];
          next[existingIdx] = { ...next[existingIdx]!, ...item, text: item.text || next[existingIdx]!.text };
          return next;
        }
        const trimmedNewText = (item.text || "").trim();
        if (trimmedNewText) {
          const recentWindow = prev.slice(-5);
          if (recentWindow.some((cand) => cand.role === item.role && cand.text.trim() === trimmedNewText)) {
            return prev;
          }
          if (item.role === "user") {
            const prefixMatchIdx = prev.findLastIndex(
              (cand) => cand.role === "user" &&
                cand.text.trim().length > 0 &&
                trimmedNewText.startsWith(cand.text.trim()) &&
                trimmedNewText.length >= cand.text.trim().length
            );
            if (prefixMatchIdx !== -1 && prev.length - prefixMatchIdx <= 3) {
              const next = [...prev];
              next[prefixMatchIdx] = { ...next[prefixMatchIdx]!, ...item, text: item.text };
              return next;
            }
          }
        }
        return [...prev, item];
      });
    };
    window.addEventListener("space-live-transcript-sync", handleSync);
    return () => {
      window.removeEventListener("space-live-transcript-sync", handleSync);
    };
  }, [pane.roomId, streamingMode, shared]);

  useEffect(() => {
    if (shared) return;
    try {
      const trimmed = transcripts.length > 200 ? transcripts.slice(-200) : transcripts;
      localStorage.setItem(storageKey, JSON.stringify(trimmed));
      if (!streamingMode) sessionStorage.setItem(`space_live_pane_transcripts_${pane.id}`, JSON.stringify(trimmed));
    } catch {}
  }, [storageKey, pane.id, transcripts, streamingMode, shared]);

  useEffect(() => {
    if (!shared && !streamingMode && pane.roomId && transcripts.length === 0) {
      try {
        if (typeof api?.getVoiceRealtimeHistory === "function") {
          void api.getVoiceRealtimeHistory(pane.roomId, 30).then((res) => {
            if (res?.ok && res.items && res.items.length > 0) {
              const loaded: LiveTranscriptItem[] = res.items.map((item, idx) => ({
                id: item.id || `hist_${idx}_${Date.now()}`,
                role: item.role === "tool" ? "system" : item.role,
                text: item.text,
                timestamp: new Date(item.timestamp).toLocaleTimeString(),
                createdAtMs: item.createdAtMs
              }));
              setTranscripts(loaded);
            }
          }).catch(() => {});
        }
      } catch {
        // Runtime or api not available in some test environments
      }
    }
  }, [pane.roomId, streamingMode, shared]);
  const [error, setError] = useState<string | null>(null);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(cfg.selectedDeviceId ?? "");
  const [muted, setMuted] = useState(false);
  const [userAudioLevel, setUserAudioLevel] = useState(0);
  const [micSilent, setMicSilent] = useState(false);
  const [pendingInputs, setPendingInputs] = useState<LiveInputPart[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => new Date());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const visualCaptureRef = useRef<AbortController | null>(null);
  useEffect(() => () => { visualCaptureRef.current?.abort(); }, [pane.id, pane.roomId]);

  // This ref owns only the separate public streaming session.
  const sessionRef = useRef<LiveSessionHandle | null>(null);
  useEffect(() => {
    if (!shared || !sharedState) return;
    setStatus(sharedState.status);
    setMuted(sharedState.muted);
    setError(sharedState.error);
    setTranscripts(sharedState.transcripts.filter(item => item.roomId === pane.roomId));
  }, [shared, sharedState, pane.roomId]);
  const sessionGenerationRef = useRef(0);
  const startPendingRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const streamingOperatorIntentRef = useRef<{ text: string; at: number } | null>(null);
  const reconnectInFlightRef = useRef(false);
  const reconnectWindowRef = useRef<{ startedAt: number; attempts: number }>({ startedAt: 0, attempts: 0 });
  const clearGuardRef = useRef<number>(0);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const mainBodyRef = useRef<HTMLDivElement | null>(null);
  const [isCompactHeight, setIsCompactHeight] = useState(false);

  useEffect(() => {
    const el = mainBodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsCompactHeight(entry.contentRect.height < 560);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    saveLivePaneConfig(pane.id, {
      streamingMode,
      provider,
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
      enableMcpTools,
      enableProfileMemory,
      selectedDeviceId,
      voiceOnly,
      showToolCalls,
      personalMemoryCollapsed,
      personalMemories
    }, true);
    updateLiveSessionStats((prev) => {
      if (!prev.sessionActive) {
        return {
          model: voiceModel,
          delegatedModel,
          delegatedReasoningEffort: reasoningEffort,
          delegatedType,
          voice,
          language,
          webSearch
        };
      }
      return {};
    });
    if (pane.id && (pane.modelId !== voiceModel || pane.providerId !== provider || pane.reasoningEffort !== reasoningEffort)) {
      void api.updatePane(pane.id, {
        modelId: voiceModel,
        providerId: provider,
        reasoningEffort
      }).catch(() => {});
    }
  }, [
    pane.id,
    streamingMode,
    provider,
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
    enableMcpTools,
    enableProfileMemory,
    selectedDeviceId,
    voiceOnly,
    personalMemoryCollapsed,
    personalMemories
  ]);

  useEffect(() => {
    let active = true;
    try {
      if (typeof api?.getLivePersonalMemory === "function") {
        void api.getLivePersonalMemory().then((response) => {
          if (active && Array.isArray(response.items)) {
            memoryRevisionRef.current = response.revision;
            setPersonalMemories(response.items);
            saveStoredPersonalMemories(response.items);
          }
        }).catch(() => undefined);
      }
    } catch {
      // Runtime or api not available in some test environments
    }
    return () => { active = false; };
  }, []);

  async function savePersonalMemory() {
    const key = newMemoryKey.trim();
    const value = newMemoryValue.trim();
    if (!key || !value) return;
    try {
      const response = await api.saveLivePersonalMemory({ key, value, category: newMemoryCategory, expectedRevision: memoryRevisionRef.current });
      memoryRevisionRef.current = response.revision;
      setPersonalMemories((current) => {
        const next = [...current.filter((item) => item.key.toLowerCase() !== key.toLowerCase()), response.item];
        saveStoredPersonalMemories(next);
        return next;
      });
      setNewMemoryKey("");
      setNewMemoryValue("");
    } catch {
      setError("Personal memory could not be saved. Your input has been preserved.");
    }
  }

  async function deletePersonalMemory(item: LivePersonalMemoryItem) {
    try {
      const result = await api.deleteLivePersonalMemory(item.id, memoryRevisionRef.current);
      if (!result.ok) throw new Error("Delete was not confirmed.");
      memoryRevisionRef.current = result.revision;
    } catch {
      setError("Personal memory could not be deleted. Please try again.");
      return;
    }
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

  function changeStreamingMode(next: boolean) {
    if (status !== "idle" && status !== "error") return;
    if (next && provider !== "openai" && provider !== "google" && provider !== "vercel") {
      handleProviderChange("openai");
    }
    const nextKey = next
      ? `space_streaming_live_pane_transcripts_${pane.id}`
      : pane.roomId ? `space_live_room_transcripts_${pane.roomId}` : `space_live_pane_transcripts_${pane.id}`;
    try {
      const raw = localStorage.getItem(nextKey) || (!next && sessionStorage.getItem(`space_live_pane_transcripts_${pane.id}`));
      setTranscripts(raw ? JSON.parse(raw) as LiveTranscriptItem[] : []);
    } catch { setTranscripts([]); }
    setStreamingMode(next);
    setError(null);
  }

  async function handleToggleSession() {
    if (shared) {
      coordinator.configure({ provider, model: voiceModel, language, voice, opening, prompt: [prompt, voicePrompt].filter(Boolean).join("\n\n"),
        delegatedModel, delegatedType, delegatedReasoningEffort: reasoningEffort, delegatedWebSearch: webSearch, delegatedPrompt,
        audioDeviceId: selectedDeviceId || undefined, enableGeminiMemory: geminiMemoryEnabled, enableMcpTools, enableProfileMemory, timeZone });
      coordinator.toggle(); return;
    }
    if (startPendingRef.current || status === "connecting") return;
    const activeGlobal = !streamingMode && typeof window !== "undefined" ? (window as any).__SPACE_ACTIVE_LIVE_SESSION__ : null;
    if ((status !== "idle" && status !== "error") || activeGlobal) {
      cancelPendingSession();
      if (activeGlobal?.handle) {
        try { activeGlobal.handle.close(); } catch {}
      }
      if (sessionRef.current && sessionRef.current !== activeGlobal?.handle) {
        try { sessionRef.current.close(); } catch {}
      }
      if (!streamingMode && typeof window !== "undefined") {
        (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
      }
      sessionRef.current = null;
      streamingOperatorIntentRef.current = null;
      setStatus("idle");
      setUserAudioLevel(0);
      setMicSilent(false);
      window.dispatchEvent(new CustomEvent("space-live-pane-status", {
        detail: { paneId: pane.id, rail: true, status: "idle" }
      }));
      return;
    }

    setError(null);
    setMicSilent(false);
    const generation = ++sessionGenerationRef.current;
    const isCurrent = () => sessionGenerationRef.current === generation;
    let ended = false;
    startPendingRef.current = true;
    setStatus("connecting");
    try {
      const combinedPrompt = streamingMode ? "" : [prompt.trim(), voicePrompt.trim()].filter(Boolean).join("\n\n");
      const initialMemories = streamingMode ? [] : personalMemories.length > 0 ? personalMemories : loadStoredPersonalMemories();
      if (!streamingMode) void api.getLivePersonalMemory().then((res) => {
        if (res?.items) {
          setPersonalMemories(res.items);
          memoryRevisionRef.current = res.revision;
          saveStoredPersonalMemories(res.items);
        }
      }).catch(() => undefined);
      const openLiveConversationSession = await loadLiveConversationSession();
        if (!isCurrent()) return;
        const handle = await openLiveConversationSession(
        {
          streamingMode,
          streamingOperatorIntent: () => {
            const current = streamingOperatorIntentRef.current;
            streamingOperatorIntentRef.current = null;
            return current;
          },
          paneId: pane.id,
          roomId: pane.roomId,
          provider,
          model: voiceModel,
          language: streamingMode ? "en" : language,
          voice: voice as any,
          opening: streamingMode ? undefined : opening.trim() || undefined,
          prompt: combinedPrompt || undefined,
          delegatedModel,
          delegatedType,
          delegatedReasoningEffort: reasoningEffort,
          delegatedWebSearch: streamingMode ? false : webSearch,
          delegatedPrompt: streamingMode ? undefined : delegatedPrompt.trim() || undefined,
          audioDeviceId: (audioDevices.length === 0 || audioDevices.some((d) => d.deviceId === selectedDeviceId)) ? (selectedDeviceId || undefined) : undefined,
          enableGeminiMemory: streamingMode ? false : geminiMemoryEnabled,
          enableMcpTools: streamingMode ? false : enableMcpTools,
          enableProfileMemory: streamingMode ? false : enableProfileMemory,
          timeZone,
          personalMemories: initialMemories,
          transcripts: streamingMode ? [] : transcripts
        },
        {
          onStatusChange: (newStatus) => {
            if (!isCurrent()) return;
            setStatus(newStatus);
            if (newStatus === "idle" || newStatus === "error") {
              ended = true;
              setUserAudioLevel(0);
              setMicSilent(false);
              if (typeof window !== "undefined" && (window as any).__SPACE_ACTIVE_LIVE_SESSION__?.handle === sessionRef.current) {
                (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
              }
              sessionRef.current = null;
            }
          },
          onReconnect: (reconnect) => {
            if (!isCurrent()) return;
            const now = Date.now();
            const windowState = reconnectWindowRef.current;
            if (now - windowState.startedAt > 60_000) {
              windowState.startedAt = now;
              windowState.attempts = 0;
            }
            if (reconnectInFlightRef.current || windowState.attempts >= 3) {
              setError("Google Gemini Live could not reconnect automatically after the provider closed the session.");
              setStatus("error");
              return;
            }
            windowState.attempts += 1;
            reconnectInFlightRef.current = true;
            setStatus("connecting");
            reconnectTimerRef.current = window.setTimeout(() => {
              reconnectTimerRef.current = null;
              if (!isCurrent()) return;
              ended = false;
              void reconnect().then((nextHandle) => {
                if (!isCurrent() || ended) {
                  nextHandle.close();
                  return;
                }
                sessionRef.current = nextHandle;
                if (typeof window !== "undefined") {
                  (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = {
                    handle: nextHandle,
                    source: "pane",
                    paneId: pane.id,
                    roomId: pane.roomId
                  };
                }
                setError(null);
              }).catch((err) => {
                if (!isCurrent()) return;
                setError(err instanceof Error ? err.message : "Google Gemini Live reconnect failed.");
                setStatus("error");
              }).finally(() => {
                if (isCurrent()) reconnectInFlightRef.current = false;
              });
            }, Math.min(4000, 500 * windowState.attempts));
          },
          onTranscriptUpdate: (item) => {
            if (!isCurrent()) return;
            if (streamingMode && item.role === "user" && !item.isDelta && item.text.trim()) {
              streamingOperatorIntentRef.current = { text: item.text.trim(), at: Date.now() };
            }
            if (typeof window !== "undefined" && !streamingMode) {
              window.dispatchEvent(new CustomEvent("space-live-transcript-sync", {
                detail: { roomId: pane.roomId || "global", item, sourcePaneId: pane.id }
              }));
            }
            setTranscripts((prev) => {
              if (item.isDelta) {
                const last = prev[prev.length - 1];
                if (last && last.role === item.role && last.id === item.id) {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, text: mergeTranscriptText(last.text, item.text) }
                  ];
                }
                const existingIdx = prev.findIndex((candidate) => candidate.id === item.id);
                if (existingIdx !== -1) {
                  const existing = prev[existingIdx];
                  if (existing) {
                    const next = [...prev];
                    next[existingIdx] = { ...existing, text: mergeTranscriptText(existing.text, item.text) };
                    return next;
                  }
                }
                return [...prev, { ...item, isDelta: false }];
              }
              const existingIdx = prev.findIndex((candidate) => candidate.id === item.id);
              if (existingIdx !== -1) {
                const existing = prev[existingIdx];
                if (existing) {
                  const next = [...prev];
                  next[existingIdx] = { ...existing, ...item, text: item.text || existing.text };
                  return next;
                }
              }
              const trimmedNewText = (item.text || "").trim();
              if (trimmedNewText) {
                const recentWindow = prev.slice(-5);
                if (recentWindow.some((cand) => cand.role === item.role && cand.text.trim() === trimmedNewText)) {
                  return prev;
                }
                if (item.role === "user") {
                  const prefixMatchIdx = prev.findLastIndex(
                    (cand) => cand.role === "user" &&
                      cand.text.trim().length > 0 &&
                      trimmedNewText.startsWith(cand.text.trim()) &&
                      trimmedNewText.length >= cand.text.trim().length
                  );
                  if (prefixMatchIdx !== -1 && prev.length - prefixMatchIdx <= 3) {
                    const next = [...prev];
                    next[prefixMatchIdx] = { ...next[prefixMatchIdx]!, ...item, text: item.text };
                    return next;
                  }
                }
              }
              return [...prev, item];
            });
          },
          onRemoteStream: (stream) => {
            if (!isCurrent()) return;
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = stream;
              remoteAudioRef.current.play().catch((err) => console.warn("Mounted audio play error:", err));
            }
          },
          onAudioLevel: (level, src) => {
            if (!isCurrent()) return;
            if (src === "user") {
              setUserAudioLevel(level);
              if (level > 0.05) setMicSilent(false);
            }
          },
          onMicSilence: (isSilent) => setMicSilent(isSilent),
          onPersonalMemoryUpdate: (item) => {
            setPersonalMemories((prev) => {
              const idx = prev.findIndex((m) => m.key.toLowerCase() === item.key.toLowerCase());
              if (idx !== -1) {
                const next = [...prev];
                next[idx] = item;
                saveStoredPersonalMemories(next);
                return next;
              }
              const next = [...prev, item];
              saveStoredPersonalMemories(next);
              return next;
            });
          },
          onPersonalMemoryDeleted: (keyOrId) => {
            setPersonalMemories((prev) => {
              const target = keyOrId.trim().toLowerCase();
              const next = prev.filter((m) => m.id !== keyOrId && m.key.toLowerCase() !== target);
              saveStoredPersonalMemories(next);
              return next;
            });
          },
          onError: (errMsg) => {
            if (!isCurrent()) return;
            setError(errMsg);
            try {
              void fetch("/api/voice/client-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: errMsg, provider, model: voiceModel, event: "onError" })
              }).catch(() => {});
            } catch {}
          }
        }
      );
      if (!isCurrent() || ended) {
        handle.close();
        return;
      }
      sessionRef.current = handle;
      setPendingInputs((prev) => {
        if (prev.length > 0) {
          handle.sendInput?.(prev);
        }
        return [];
      });
      if (!streamingMode && typeof window !== "undefined") {
        (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = {
          handle,
          source: "pane",
          paneId: pane.id,
          roomId: pane.roomId
        };
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (typeof window !== "undefined" && (window as any).__SPACE_ACTIVE_LIVE_SESSION__?.paneId === pane.id) {
        (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
      }
      const msg = err instanceof Error ? err.message : "Failed to start Live session.";
      console.error("[LivePane] Session start failed:", msg, err);
      try {
        void fetch("/api/voice/client-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: msg,
            provider,
            model: voiceModel,
            name: err instanceof Error ? err.name : undefined,
            stack: err instanceof Error ? err.stack : undefined,
            event: "catch"
          })
        }).catch(() => {});
      } catch {}
      setError(msg);
      setStatus("error");
    } finally {
      if (isCurrent()) startPendingRef.current = false;
    }
  }

  function cancelPendingSession() {
    sessionGenerationRef.current += 1;
    startPendingRef.current = false;
    reconnectInFlightRef.current = false;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }

  function handleMuteToggle() {
    if (shared) { coordinator.setMuted(!coordinator.getSnapshot().muted); return; }
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
    if (visualCaptureRef.current) return;
    const controller = new AbortController();
    visualCaptureRef.current = controller;
    try {
      const image = await captureLiveVisual(source, controller.signal);
      if (!controller.signal.aborted) {
        if (shared && coordinator.getSnapshot().handle) {
          await coordinator.send([image]);
        } else if (sessionRef.current) {
          sessionRef.current.sendInput?.([image]);
        } else {
          setPendingInputs((prev) => [...prev, image].slice(-4));
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : `${source} capture was not available.`);
    } finally {
      if (visualCaptureRef.current === controller) visualCaptureRef.current = null;
    }
  }

  const isLive = status === "active" || status === "listening" || status === "thinking" || status === "speaking" || status === "connecting";

  useEffect(() => {
    if (!shared) window.dispatchEvent(new CustomEvent("space-live-pane-status", { detail: { paneId: pane.id, status } }));
  }, [pane.id, status, shared]);

  useEffect(() => {
    const onStart = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; roomId?: string }>).detail;
      const matches = detail?.paneId ? detail.paneId === pane.id
        : detail?.roomId ? detail.roomId === pane.roomId : true;
      if (shared) { if (matches) void coordinator.start(); return; }
      if (matches && (status === "idle" || status === "error" || !sessionRef.current)) {
        void handleToggleSession();
      }
    };
    const onToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; roomId?: string }>).detail;
      const matches = detail?.paneId ? detail.paneId === pane.id
        : detail?.roomId ? detail.roomId === pane.roomId : true;
      if (matches) {
        void handleToggleSession();
      }
    };
    const onStop = () => {
      if (shared) return;
      cancelPendingSession();
      if (sessionRef.current) {
        try { sessionRef.current.close(); } catch {}
        sessionRef.current = null;
      }
      if (typeof window !== "undefined" && (window as any).__SPACE_ACTIVE_LIVE_SESSION__?.paneId === pane.id) {
        (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
      }
      setStatus("idle");
      setUserAudioLevel(0);
      setMicSilent(false);
    };
    const onRailStatus = (event: Event) => {
      if (shared || streamingMode) return;
      const detail = (event as CustomEvent<{ paneId?: string; rail?: boolean; status?: string }>).detail;
      if (!detail) return;
      if (detail.rail && detail.status) {
        if (detail.status === "idle" || detail.status === "error") {
          if (!sessionRef.current) {
            setStatus(detail.status as any);
            setUserAudioLevel(0);
            setMicSilent(false);
          }
        } else if (["active", "listening", "thinking", "speaking", "connecting"].includes(detail.status)) {
          if (!sessionRef.current) {
            setStatus(detail.status as any);
          }
        }
      }
    };
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; action?: string }>).detail;
      if (detail?.paneId !== pane.id) return;
      if (detail.action === "attach") fileInputRef.current?.click();
      if (detail.action === "camera") void captureVisual("camera");
      if (detail.action === "screen") void captureVisual("screen");
    };
    window.addEventListener("space-live-pane-start", onStart);
    window.addEventListener("space-live-pane-toggle", onToggle);
    window.addEventListener("space-live-session-stop", onStop);
    window.addEventListener("space-live-pane-status", onRailStatus);
    window.addEventListener("space-live-pane-action", onAction);
    return () => {
      window.removeEventListener("space-live-pane-start", onStart);
      window.removeEventListener("space-live-pane-toggle", onToggle);
      window.removeEventListener("space-live-session-stop", onStop);
      window.removeEventListener("space-live-pane-status", onRailStatus);
      window.removeEventListener("space-live-pane-action", onAction);
    };
  }, [pane.id, pane.roomId, isLive, status, shared, streamingMode, coordinator]);

  useEffect(() => {
    return () => {
      cancelPendingSession();
      if (sessionRef.current) {
        try { sessionRef.current.close(); } catch {}
        sessionRef.current = null;
      }
      if (typeof window !== "undefined" && (window as any).__SPACE_ACTIVE_LIVE_SESSION__?.paneId === pane.id) {
        (window as any).__SPACE_ACTIVE_LIVE_SESSION__ = null;
      }
    };
  }, [pane.id]);

  function sendPendingInputs() {
    if (shared) {
      try { void Promise.resolve(coordinator.send(pendingInputs)).then(() => setPendingInputs([])).catch(error => setError(error.message)); }
      catch (error) { setError(error instanceof Error ? error.message : "Could not send input."); }
      return;
    }
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
      data-mobile={mobile || undefined}
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
            <div className="live-toggle-row">
              <span className="live-toggle-label">Streaming mode</span>
              <label className="live-switch">
                <input type="checkbox" aria-label="Streaming mode" checked={streamingMode}
                  onChange={(event) => changeStreamingMode(event.target.checked)} disabled={isLive} />
                <span className="live-slider" />
              </label>
            </div>
            {streamingMode && <p className="live-form-hint">Uses public stream metrics, chat activity and approved Streaming memory. Personal memory and private tools are unavailable.</p>}
          </div>
          {!streamingMode && (
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
          )}

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
            <div className="live-toggle-row">
              <span className="live-toggle-label">Show tool calls in chat</span>
              <label className="live-switch">
                <input
                  type="checkbox"
                  aria-label="Show tool calls in chat"
                  checked={showToolCalls}
                  onChange={(e) => setShowToolCalls(e.target.checked)}
                />
                <span className="live-slider" />
              </label>
            </div>
            <div className="live-toggle-row" style={{ marginTop: 6 }}>
              <span className="live-toggle-label">Live statistics</span>
              <button
                type="button"
                className="live-btn-secondary"
                style={{ padding: "3px 10px", fontSize: 11, width: "auto", flex: "none" }}
                onClick={() => {
                  updateLiveSessionStats((prev) => {
                    if (!prev.sessionActive) {
                      return {
                        model: voiceModel,
                        delegatedModel,
                        delegatedReasoningEffort: reasoningEffort,
                        delegatedType,
                        voice,
                        language,
                        webSearch
                      };
                    }
                    return {};
                  });
                  window.dispatchEvent(new Event("space-live-rail-stats-toggle"));
                }}
              >
                📊 Show live stats
              </button>
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
                  <label className="live-form-label" htmlFor="live-voice-provider-select">
                    Provider
                  </label>
                  <select
                    id="live-voice-provider-select"
                    className="live-select"
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value as LiveAudioProviderId)}
                    disabled={isLive}
                  >
                    {getAllLiveAudioProviders().filter((p) => !streamingMode || p.id === "openai" || p.id === "google" || p.id === "vercel").map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName} ({p.transport.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="live-form-group">
                  <label className="live-form-label" htmlFor="live-voice-model-select">
                    Model
                  </label>
                  <select
                    id="live-voice-model-select"
                    className="live-select"
                    value={voiceModel}
                    onChange={(e) => handleModelChange(e.target.value)}
                    disabled={isLive}
                  >
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>
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
                    {availableVoices.map((v) => (
                      <option key={v.id} value={v.id}>
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

          {!streamingMode && <div className="live-sidebar-section">
            <div
              className="live-section-header"
              onClick={() => setMemoryControlCollapsed((prev) => !prev)}
              role="button"
              tabIndex={0}
            >
              <span>Space Control & Memory</span>
              <span>{memoryControlCollapsed ? "+" : "^"}</span>
            </div>

            {!memoryControlCollapsed && (
              <>
                <div className="live-toggle-row">
                  <span className="live-toggle-label">Space Control MCP Tools</span>
                  <label className="live-switch">
                    <input
                      type="checkbox"
                      aria-label="Space Control MCP Tools"
                      checked={enableMcpTools}
                      onChange={(e) => setEnableMcpTools(e.target.checked)}
                      disabled={isLive}
                    />
                    <span className="live-slider" />
                  </label>
                </div>

                <div className="live-toggle-row">
                  <span className="live-toggle-label">Extended Profile Memory</span>
                  <label className="live-switch">
                    <input
                      type="checkbox"
                      aria-label="Extended Profile Memory"
                      checked={enableProfileMemory}
                      onChange={(e) => setEnableProfileMemory(e.target.checked)}
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
          </div>}

          {provider !== "google" && provider !== "local" && (
            <>
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
                  </>
                )}
              </div>
            </>
          )}

          <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #30363d)", margin: "4px 0" }} />

          {!streamingMode && <div className="live-sidebar-section">
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
                      <span title={item.value}>
                        <span className="live-function-tag" style={{ marginRight: 6, textTransform: "uppercase", fontSize: 9 }}>
                          {item.category || "profile"}
                        </span>
                        <strong>{item.key}</strong>: {item.value}
                      </span>
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
                  <label className="live-form-label" htmlFor="live-memory-category">Category</label>
                  <select
                    id="live-memory-category"
                    className="live-select"
                    value={newMemoryCategory}
                    onChange={(e) => setNewMemoryCategory(e.target.value as any)}
                    disabled={isLive}
                  >
                    <option value="core">Core (Tier 1 - Always loaded)</option>
                    <option value="profile">Profile (Tier 2 - Extended)</option>
                    <option value="preference">Preference</option>
                    <option value="fact">Fact</option>
                    <option value="instruction">Instruction</option>
                    <option value="note">Note</option>
                  </select>
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
          </div>}
        </div>
      </aside>

      <main className="live-pane-main">
        {(() => {
          const activeRunningTool = transcripts.slice().reverse().find((item) => item.toolCall && item.toolCall?.status === "running")?.toolCall;
          const visibleTranscripts = transcripts.filter((item) => {
            if (voiceOnly && !item.toolCall) return false;
            if (item.toolCall && !showToolCalls) return false;
            return true;
          });

          const isCompactLayout = visibleTranscripts.length > 0 && !mobile;

          return (
            <div
              ref={mainBodyRef}
              className={`live-main-body ${
                visibleTranscripts.length === 0 ? "is-empty" : "has-transcripts"
              } ${isCompactLayout ? "is-compact-dialog" : ""}`}
            >
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

              {showToolCalls && activeRunningTool && (
                <div className="live-active-tool-banner" role="status" aria-live="polite">
                  <span className="live-active-tool-icon">⚡</span>
                  <span className="live-active-tool-text">
                    <strong>Tool executing:</strong> {activeRunningTool.name}
                  </span>
                </div>
              )}

              <section className={`live-session-card ${isLive ? "is-live" : ""}`} aria-label="Live controls">
                <div className="live-session-card-header">
                  <div className="live-session-header-left">
                    {isCompactLayout && (
                      <button
                        type="button"
                        className={`room-toolbar-visibility-button room-live-rail-button live-pane-mini-orb ${
                          isLive ? "is-connected" : ""
                        } ${status === "listening" ? "is-listening is-user-speaking" : ""} ${
                          status === "speaking" ? "is-speaking is-agent-speaking" : ""
                        } ${status === "thinking" || status === "connecting" ? "is-thinking" : ""}`}
                        onClick={() => void handleToggleSession()}
                        aria-label={isLive ? "End session" : "Start session"}
                        disabled={status === "connecting"}
                        title={isLive ? "Click to end Live session" : "Click to start Live session"}
                      >
                        <span className="room-live-rail-glow" aria-hidden="true" />
                        <span className="room-live-rail-sphere" aria-hidden="true">
                          <span className="room-live-rail-line line-one" />
                          <span className="room-live-rail-line line-two" />
                          <span className="room-live-rail-line line-three" />
                          <span className="room-live-rail-line line-four" />
                          <span className="room-live-rail-core" />
                        </span>
                      </button>
                    )}
                    <div className="live-session-title-group">
                      <div className="live-session-card-title">
                        {streamingMode
                          ? "Streaming Live"
                          : voiceOnly
                          ? "Voice-only mode"
                          : provider === "google"
                          ? "Talk to Gemini Live"
                          : provider === "amazon"
                          ? "Talk to Nova Sonic"
                          : provider === "local"
                          ? "Talk to Local Qwen"
                          : provider === "vercel"
                          ? "Talk to GPT-Live (Vercel)"
                          : "Talk to GPT-Live"}
                      </div>
                      <div className="live-session-card-subtitle">
                        {new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(clockNow)} · {TIME_ZONE_OPTIONS.find((option) => option.value === timeZone)?.label || timeZone}
                      </div>
                    </div>
                  </div>
                  <div className="live-session-card-tools">
                      <button
                        type="button"
                        className={`live-icon-btn ${voiceOnly ? "is-voice-only-active is-active" : ""}`}
                        onClick={() => setVoiceOnly((prev) => !prev)}
                        aria-label={voiceOnly ? "Disable voice-only mode" : "Enable voice-only mode"}
                        title={voiceOnly ? "Voice-only mode enabled (click to disable)" : "Enable voice-only mode"}
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M2 10v4" />
                          <path d="M6 6v12" />
                          <path d="M10 3v18" />
                          <path d="M14 6v12" />
                          <path d="M18 10v4" />
                          <path d="M22 12v0" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`live-icon-btn ${muted ? "is-muted" : ""}`}
                        onClick={handleMuteToggle}
                        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                        title={muted ? "Unmute microphone" : "Mute microphone"}
                        disabled={!isLive}
                      >
                        {muted ? (
                          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="2" y1="2" x2="22" y2="22" />
                            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                            <path d="M5 10v2a7 7 0 0 0 12 5" />
                            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                          </svg>
                        ) : (
                          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="22" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="live-icon-btn"
                        onClick={() => void handleClearConversationAndLogs()}
                        aria-label="Clear conversation and logs"
                        title="Clear conversation transcript and disk logs"
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18" />
                          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          <line x1="10" y1="11" x2="10" y2="17" />
                          <line x1="14" y1="11" x2="14" y2="17" />
                        </svg>
                      </button>
                      <button
                        ref={settingsButtonRef}
                        type="button"
                        className="live-icon-btn live-settings-open"
                        aria-label="Open live settings"
                        aria-expanded={settingsOpen}
                        title="Settings"
                        onClick={() => setSettingsOpen(true)}
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="m19.4 15 .1.1a2 2 0 0 1-2.8 2.8l-.1-.1a2 2 0 0 0-3.4 1.4V19a2 2 0 0 1-4 0v-.2a2 2 0 0 0-3.4-1.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A2 2 0 0 0 3.4 11H3a2 2 0 0 1 0-4h.2a2 2 0 0 0 1.4-3.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A2 2 0 0 0 11 2.6V2a2 2 0 0 1 4 0v.2a2 2 0 0 0 3.4 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A2 2 0 0 0 20.6 10h.2a2 2 0 0 1 0 4h-.2a2 2 0 0 0-1.2 1Z"/></svg>
                      </button>
                    </div>
                  </div>

                  {!isCompactLayout && (
                    <div className="live-pane-orb-wrapper">
                      <button
                        type="button"
                        className={`room-toolbar-visibility-button room-live-rail-button live-pane-orb-button ${
                          isLive ? "is-connected" : ""
                        } ${status === "listening" ? "is-listening is-user-speaking" : ""} ${
                          status === "speaking" ? "is-speaking is-agent-speaking" : ""
                        } ${status === "thinking" || status === "connecting" ? "is-thinking" : ""}`}
                        onClick={() => void handleToggleSession()}
                        aria-label={isLive ? "End session" : "Start session"}
                        disabled={status === "connecting"}
                        title={isLive ? "Click to end Live session" : "Click to start Live session"}
                      >
                        <span className="room-live-rail-glow" aria-hidden="true" />
                        <span className="room-live-rail-sphere" aria-hidden="true">
                          <span className="room-live-rail-line line-one" />
                          <span className="room-live-rail-line line-two" />
                          <span className="room-live-rail-line line-three" />
                          <span className="room-live-rail-line line-four" />
                          <span className="room-live-rail-core" />
                        </span>
                      </button>
                    </div>
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
                    <div style={{ display: "flex", justifyContent: "center", margin: "6px 0" }}>
                      <button type="button" className="live-btn-secondary live-send-inputs" onClick={sendPendingInputs} disabled={!isLive}>
                        Send {pendingInputs.length} input{pendingInputs.length === 1 ? "" : "s"}
                      </button>
                    </div>
                  )}

                  {isLive && (
                    <div className="live-session-card-footer">
                      <div className="live-mic-level" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, userAudioLevel) * 100)}>
                        <div className="live-mic-level-fill" style={{ width: `${Math.min(100, Math.round(userAudioLevel * 100))}%` }} />
                      </div>
                    </div>
                  )}
                </section>

                {visibleTranscripts.length > 0 && (
                  <div className="live-transcript-feed" role="log" aria-label="Chat transcript">
                    {visibleTranscripts.map((item) => (
                      <div key={item.id} className={`live-transcript-bubble ${item.role}`}>
                        <div className="live-transcript-text">
                          {item.toolCall || item.id.startsWith("tool_") ? (
                            <details className="live-tool-call-badge">
                              <summary>Tool details</summary>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 }}>
                                <span>⚡</span>
                                <span>{item.toolCall?.name ?? "Control tool"}</span>
                                {item.toolCall?.status === "running" && <span style={{ color: "#e3b341", fontSize: "11px" }}>● Running</span>}
                                {item.toolCall?.status === "done" && <span style={{ color: "#3fb950", fontSize: "11px" }}>✓ Done</span>}
                                {item.toolCall?.status === "error" && <span style={{ color: "#f85149", fontSize: "11px" }}>✗ Error</span>}
                              </div>
                              {item.toolCall?.query && <div style={{ fontSize: "11px", opacity: 0.8 }}>Arguments: {item.toolCall?.query}</div>}
                              {item.toolCall?.resultSummary && <div style={{ fontSize: "11px", color: "#7ee787" }}>{item.toolCall?.resultSummary ?? item.text}</div>}
                            </details>
                          ) : (
                            item.text
                          )}
                        </div>
                        <div className="live-transcript-meta">
                          {item.toolCall ? "Space Control MCP" : item.role === "user" ? "You" : item.role === "assistant" ? (provider === "google" ? "Gemini Live" : provider === "amazon" ? "Nova Sonic" : provider === "local" ? "Local Qwen" : provider === "vercel" ? "GPT-Live (Vercel)" : "GPT-Live") : "System"} • {item.timestamp}
                        </div>
                      </div>
                    ))}
                    <div ref={transcriptBottomRef} />
                  </div>
                )}
              </div>
            );
          })()}
      </main>

      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: "none" }} />

    </section>
  );
}
