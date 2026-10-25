import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { inferProviderFromModel, type LiveAudioProviderId, type VoiceTranscriptionSettings } from "@space/contracts";
import { api } from "../../api.js";
import { openVoiceRealtimeSession, supportsDeferredVoiceCapture, type VoiceRealtimeSessionHandle } from "../../voice-realtime.js";
import { resolveVoiceProvider, voiceProviderLabel, voiceProviderUnavailable, type VoiceProviderChoice } from "../../voice-relay-close.js";
import {
  VOICE_SETTINGS_UPDATED_EVENT,
  readVoiceComposerSettings,
  type VoiceComposerSettings
} from "../../voice-settings.js";

export type VoiceInputStatus = "idle" | "connecting" | "recording" | "transcribing";

export interface VoiceInputTarget {
  id: string;
  onTranscriptDelta?: (text: string) => void;
  onTranscriptComplete: (text: string) => void | Promise<void>;
  onError?: (message: string) => void;
}

interface VoiceInputContextValue {
  settings: VoiceComposerSettings;
  serverSettings: VoiceTranscriptionSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  ownerId: string | null;
  status: VoiceInputStatus;
  preview: string;
  error: string | null;
  start: (target: VoiceInputTarget) => Promise<void>;
  stop: (ownerId: string) => void;
  // A reason is reported back to the owner when the cancel interrupts an active recording.
  cancel: (ownerId?: string, reason?: string) => void;
  // When the current recording started (ms since epoch), for an elapsed/remaining clock.
  recordingStartedAt: number | null;
  cancelNotice: { ownerId: string; message: string } | null;
  clearCancelNotice: () => void;
  clearError: (ownerId: string) => void;
  prewarm: () => void;
  ensureServerSettings: () => Promise<void>;
  refreshServerSettings: () => Promise<void>;
}

const VoiceInputContext = createContext<VoiceInputContextValue | null>(null);

const PREWARM_IDLE_TIMEOUT_MS = 15_000;
const PREWARM_FAIL_COOLDOWN_MS = 5_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function VoiceInputProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<VoiceComposerSettings>(() => readVoiceComposerSettings());
  const [serverSettings, setServerSettings] = useState<VoiceTranscriptionSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [preview, setPreview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [cancelNotice, setCancelNotice] = useState<{ ownerId: string; message: string } | null>(null);
  const statusRef = useRef<VoiceInputStatus>(status);
  statusRef.current = status;
  const sessionRef = useRef<VoiceRealtimeSessionHandle | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const serverSettingsRequestRef = useRef<Promise<VoiceTranscriptionSettings> | null>(null);
  const ownerRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const warmSessionRef = useRef<VoiceRealtimeSessionHandle | null>(null);
  const warmPromiseRef = useRef<Promise<VoiceRealtimeSessionHandle | null> | null>(null);
  const warmTimerRef = useRef<number | null>(null);
  const warmClaimRef = useRef<{ target: VoiceInputTarget; generation: number } | null>(null);
  const prewarmCooldownRef = useRef(0);
  // Which provider the warm and the active session use, so a failure can be traced to that provider.
  const warmProviderRef = useRef<LiveAudioProviderId | null>(null);
  const sessionProviderRef = useRef<LiveAudioProviderId | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const serverSettingsRef = useRef(serverSettings);
  serverSettingsRef.current = serverSettings;
  const startRef = useRef<((target: VoiceInputTarget) => Promise<void>) | null>(null);

  /** The operator's provider, or another configured one while it has no credits (see resolveVoiceProvider). */
  const sessionChoice = useCallback((): VoiceProviderChoice | null => {
    const server = serverSettingsRef.current;
    if (!server) return null;
    const current = settingsRef.current;
    const model = current.model || server.defaultModel;
    return resolveVoiceProvider({ provider: current.provider ?? inferProviderFromModel(model), model, voice: current.voice || server.defaultVoice },
      server.providerOptions);
  }, []);

  /** A session failed because its provider has no credits: start again for the same target on the fallback. */
  const startOnFallback = useCallback((target: VoiceInputTarget, failedProvider: LiveAudioProviderId | null): boolean => {
    if (!failedProvider || !voiceProviderUnavailable(failedProvider)) return false;
    const choice = sessionChoice();
    if (!choice || choice.provider === failedProvider || !startRef.current) return false;
    void startRef.current(target);
    return true;
  }, [sessionChoice]);

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current === null) return;
    window.clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
  }, []);

  const closeActiveSession = useCallback(() => {
    clearStopTimer();
    sessionRef.current?.close();
    sessionRef.current = null;
  }, [clearStopTimer]);

  const closeWarmSession = useCallback(() => {
    if (warmTimerRef.current !== null) {
      window.clearTimeout(warmTimerRef.current);
      warmTimerRef.current = null;
    }
    warmPromiseRef.current = null;
    warmSessionRef.current?.close();
    warmSessionRef.current = null;
    warmClaimRef.current = null;
  }, []);

  const reset = useCallback(() => {
    ownerRef.current = null;
    setOwnerId(null);
    setStatus("idle");
    setPreview("");
    setRecordingStartedAt(null);
  }, []);

  const cancel = useCallback((requestedOwnerId?: string, reason?: string) => {
    if (requestedOwnerId && ownerRef.current !== requestedOwnerId) return;
    const interruptedOwner = ownerRef.current;
    if (reason && interruptedOwner && (statusRef.current === "connecting" || statusRef.current === "recording")) {
      setCancelNotice({ ownerId: interruptedOwner, message: reason });
    }
    generationRef.current += 1;
    closeActiveSession();
    warmClaimRef.current = null;
    setError(null);
    reset();
  }, [closeActiveSession, reset]);

  const failWarm = useCallback((message: string) => {
    const claim = warmClaimRef.current;
    if (!claim) {
      // An unclaimed warm connection failed; drop it so the next start opens a fresh one.
      closeWarmSession();
      return;
    }
    if (claim.generation !== generationRef.current || ownerRef.current !== claim.target.id) return;
    closeActiveSession();
    if (startOnFallback(claim.target, sessionProviderRef.current)) return;
    setStatus("idle");
    setError(message);
    claim.target.onError?.(message);
  }, [closeActiveSession, closeWarmSession, startOnFallback]);

  const warmCallbacks = useMemo(() => ({
    onTranscriptDelta: (text: string) => {
      const claim = warmClaimRef.current;
      if (!claim || claim.generation !== generationRef.current) return;
      setPreview(text);
      claim.target.onTranscriptDelta?.(text);
    },
    onTranscriptComplete: async (text: string) => {
      const claim = warmClaimRef.current;
      if (!claim || claim.generation !== generationRef.current) return;
      const transcript = text.trim();
      closeActiveSession();
      if (!transcript) {
        reset();
        return;
      }
      setPreview(transcript);
      try {
        await claim.target.onTranscriptComplete(transcript);
        if (claim.generation === generationRef.current && ownerRef.current === claim.target.id) reset();
      } catch (completeError) {
        failWarm(errorMessage(completeError, "Voice transcript could not be submitted."));
      }
    },
    onError: failWarm
  }), [closeActiveSession, failWarm, reset]);

  // Hover or focus only connects; the microphone opens when the recording is claimed by an explicit start.
  const prewarm = useCallback(() => {
    if (!settings.prewarm || !serverSettings?.enabled) return;
    if (sessionRef.current || warmSessionRef.current || warmPromiseRef.current) return;
    if (Date.now() < prewarmCooldownRef.current) return;
    const choice = sessionChoice();
    if (!choice || !supportsDeferredVoiceCapture({ provider: choice.provider, model: choice.model })) return;
    // No recording is active here, so any earlier claim is stale and must not adopt this connection's errors.
    warmClaimRef.current = null;
    warmProviderRef.current = choice.provider;
    const promise = openVoiceRealtimeSession(
      {
        provider: choice.provider,
        model: choice.model,
        voice: choice.voice,
        language: settings.language,
        delay: serverSettings.defaultDelay,
        opening: settings.opening,
        prompt: settings.prompt,
        delegatedModel: settings.delegatedModel,
        delegatedType: settings.delegatedType,
        delegatedReasoningEffort: settings.delegatedReasoningEffort,
        delegatedWebSearch: settings.delegatedWebSearch,
        delegatedPrompt: settings.delegatedPrompt
      },
      warmCallbacks,
      { deferCapture: true }
    ).then((handle) => {
      warmPromiseRef.current = null;
      warmSessionRef.current = handle;
      warmTimerRef.current = window.setTimeout(closeWarmSession, PREWARM_IDLE_TIMEOUT_MS);
      return handle;
    }).catch(() => {
      warmPromiseRef.current = null;
      prewarmCooldownRef.current = Date.now() + PREWARM_FAIL_COOLDOWN_MS;
      return null;
    });
    warmPromiseRef.current = promise;
  }, [closeWarmSession, serverSettings, sessionChoice, settings, warmCallbacks]);

  const claimWarmSession = useCallback(async (
    handle: VoiceRealtimeSessionHandle,
    target: VoiceInputTarget,
    generation: number
  ) => {
    if (warmTimerRef.current !== null) {
      window.clearTimeout(warmTimerRef.current);
      warmTimerRef.current = null;
    }
    warmSessionRef.current = null;
    warmClaimRef.current = { target, generation };
    sessionRef.current = handle;
    sessionProviderRef.current = warmProviderRef.current;
    try {
      await handle.startCapture();
    } catch (captureError) {
      failWarm(errorMessage(captureError, "Microphone permission was not granted."));
      return;
    }
    if (generationRef.current !== generation || ownerRef.current !== target.id) return;
    setStatus("recording");
    setRecordingStartedAt(Date.now());
    stopTimerRef.current = window.setTimeout(() => {
      if (generationRef.current !== generation || ownerRef.current !== target.id) return;
      setStatus("transcribing");
      handle.commit();
      clearStopTimer();
    }, serverSettings?.maxDurationMs ?? 60_000);
  }, [clearStopTimer, failWarm, serverSettings]);

  const loadServerSettings = useCallback(async (force = false) => {
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      if (force || !serverSettingsRequestRef.current) {
        serverSettingsRequestRef.current = api.voiceTranscriptionSettings().catch((requestError: unknown) => {
          serverSettingsRequestRef.current = null;
          throw requestError;
        });
      }
      setServerSettings(await serverSettingsRequestRef.current);
    } catch (loadError) {
      setServerSettings(null);
      setSettingsError(errorMessage(loadError, "Voice transcription settings failed to load."));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const ensureServerSettings = useCallback(async () => {
    await loadServerSettings();
    // Authentication can become available while the eager request is still in
    // flight. Retry once when that shared request failed and cleared its cache.
    if (!serverSettingsRequestRef.current) await loadServerSettings();
  }, [loadServerSettings]);

  useEffect(() => {
    const handleSettingsUpdate = () => setSettings(readVoiceComposerSettings());
    window.addEventListener(VOICE_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
    return () => window.removeEventListener(VOICE_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancel(undefined, "Voice input stopped because the tab was hidden.");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [cancel]);

  useEffect(() => {
    if (status !== "connecting" && status !== "recording") return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [cancel, status]);

  useEffect(() => () => {
    cancel();
    closeWarmSession();
  }, [cancel, closeWarmSession]);

  const start = useCallback(async (target: VoiceInputTarget) => {
    cancel();
    if (!settings.enabled) return;
    if (!serverSettings?.enabled) {
      const message = serverSettings?.statusReason ?? settingsError ?? "Voice transcription is not configured.";
      ownerRef.current = target.id;
      setOwnerId(target.id);
      setError(message);
      target.onError?.(message);
      return;
    }

    const generation = ++generationRef.current;
    ownerRef.current = target.id;
    setOwnerId(target.id);
    setStatus("connecting");
    setPreview("");
    setError(null);

    const choice = sessionChoice()!;
    if (choice.fallbackFrom) setPreview(`${voiceProviderLabel(choice.fallbackFrom)} has no voice credits; using ${voiceProviderLabel(choice.provider)}.`);
    const fail = (message: string) => {
      if (generationRef.current !== generation || ownerRef.current !== target.id) return;
      closeActiveSession();
      if (startOnFallback(target, choice.provider)) return;
      setStatus("idle");
      setError(message);
      target.onError?.(message);
    };

    // A warm connection to a provider that has since run out of credits is dropped, not claimed.
    const warmUsable = () => !warmProviderRef.current || warmProviderRef.current === choice.provider;
    const warmPromise = warmPromiseRef.current;
    if (warmPromise) {
      const handle = await warmPromise;
      warmPromiseRef.current = null;
      if (handle && warmUsable()) {
        await claimWarmSession(handle, target, generation);
        return;
      }
      handle?.close();
      warmSessionRef.current = null;
    } else if (warmSessionRef.current) {
      const handle = warmSessionRef.current;
      warmSessionRef.current = null;
      if (warmUsable()) {
        await claimWarmSession(handle, target, generation);
        return;
      }
      handle.close();
    }
    if (generationRef.current !== generation || ownerRef.current !== target.id) return;

    sessionProviderRef.current = choice.provider;
    try {
      const handle = await openVoiceRealtimeSession(
        {
          provider: choice.provider,
          model: choice.model,
          voice: choice.voice,
          language: settings.language,
          delay: serverSettings.defaultDelay,
          opening: settings.opening,
          prompt: settings.prompt,
          delegatedModel: settings.delegatedModel,
          delegatedType: settings.delegatedType,
          delegatedReasoningEffort: settings.delegatedReasoningEffort,
          delegatedWebSearch: settings.delegatedWebSearch,
          delegatedPrompt: settings.delegatedPrompt
        },
        {
          onTranscriptDelta: (text) => {
            if (generationRef.current !== generation || ownerRef.current !== target.id) return;
            setPreview(text);
            target.onTranscriptDelta?.(text);
          },
          onTranscriptComplete: async (text) => {
            if (generationRef.current !== generation || ownerRef.current !== target.id) return;
            const transcript = text.trim();
            closeActiveSession();
            if (!transcript) {
              reset();
              return;
            }
            setPreview(transcript);
            try {
              await target.onTranscriptComplete(transcript);
              if (generationRef.current === generation && ownerRef.current === target.id) reset();
            } catch (completeError) {
              fail(errorMessage(completeError, "Voice transcript could not be submitted."));
            }
          },
          onError: fail
        }
      );
      if (generationRef.current !== generation || ownerRef.current !== target.id) {
        handle.close();
        return;
      }
      sessionRef.current = handle;
      setStatus("recording");
      setRecordingStartedAt(Date.now());
      stopTimerRef.current = window.setTimeout(() => {
        if (generationRef.current !== generation || ownerRef.current !== target.id) return;
        setStatus("transcribing");
        handle.commit();
        clearStopTimer();
      }, serverSettings.maxDurationMs);
    } catch (startError) {
      fail(errorMessage(startError, "Microphone permission was not granted."));
    }
  }, [cancel, claimWarmSession, clearStopTimer, closeActiveSession, reset, serverSettings, sessionChoice, settings, settingsError, startOnFallback]);
  startRef.current = start;

  const stop = useCallback((requestedOwnerId: string) => {
    if (ownerRef.current !== requestedOwnerId || !sessionRef.current) return;
    clearStopTimer();
    setStatus("transcribing");
    sessionRef.current.commit();
  }, [clearStopTimer]);

  const clearError = useCallback((requestedOwnerId: string) => {
    if (ownerRef.current !== requestedOwnerId) return;
    setError(null);
    if (status === "idle") reset();
  }, [reset, status]);

  const value = useMemo<VoiceInputContextValue>(() => ({
    settings,
    serverSettings,
    settingsLoading,
    settingsError,
    ownerId,
    status,
    preview,
    error,
    start,
    stop,
    cancel,
    clearError,
    prewarm,
    ensureServerSettings,
    refreshServerSettings: () => loadServerSettings(true),
    recordingStartedAt,
    cancelNotice,
    clearCancelNotice: () => setCancelNotice(null)
  }), [cancel, cancelNotice, clearError, ensureServerSettings, error, loadServerSettings, ownerId, prewarm, preview, recordingStartedAt, serverSettings, settings, settingsError, settingsLoading, start, status, stop]);

  return <VoiceInputContext.Provider value={value}>{children}</VoiceInputContext.Provider>;
}

export function useVoiceInput(): VoiceInputContextValue {
  const value = useContext(VoiceInputContext);
  if (!value) throw new Error("useVoiceInput must be used inside VoiceInputProvider.");
  return value;
}

export function useOptionalVoiceInput(): VoiceInputContextValue | null {
  return useContext(VoiceInputContext);
}
