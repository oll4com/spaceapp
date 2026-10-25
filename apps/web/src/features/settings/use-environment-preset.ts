import { useCallback, useEffect, useRef, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  readHiddenDockIds,
  writeHiddenDockIds,
  DOCKS_VISIBILITY_EVENT
} from "../docks/use-docks-visibility.js";
import {
  readHiddenPaneIds,
  writeHiddenPaneIds,
  PANES_VISIBILITY_EVENT
} from "../pane-visibility/use-panes-visibility.js";
import {
  readHiddenWidgetIds,
  writeHiddenWidgetIds,
  WIDGETS_VISIBILITY_EVENT,
  type DesktopWidgetId
} from "../desktop-widgets/index.js";
import {
  ENVIRONMENT_PRESET_STORAGE_KEY,
  CUSTOM_DOCKS_HIDDEN_STORAGE_KEY,
  CUSTOM_PANES_HIDDEN_STORAGE_KEY,
  CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY,
  CUSTOM_CLI_DISABLED_STORAGE_KEY,
  ENVIRONMENT_PRESET_CHANGED_EVENT,
  saveUserSettingDebounced
} from "../user-settings/user-settings-manager.js";
import { api } from "../../api.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";

export type EnvironmentPreset = "custom" | "max";

export const DEFAULT_CUSTOM_DISABLED_CLIS: readonly string[] = Object.freeze([
  "cli:claude",
  "cli:gemini",
  "cli:autohand",
  "cli:qwen",
  "cli:kimi",
  "cli:grok",
  "cli:deepseek",
  "cli:cursor",
  "cli:copilot",
  "cli:hermes",
  "cli:omp",
  "cli:qoder",
  "cli:muse",
  "cli:droid"
]);

export const CANONICAL_CLI_ORDER = Object.freeze([
  "opencode",
  "codex",
  "claude",
  "gemini",
  "autohand",
  "qwen",
  "kimi",
  "grok",
  "deepseek",
  "cursor",
  "copilot",
  "hermes",
  "omp",
  "qoder",
  "muse",
  "droid"
] as const);

export const CLI_BRAND_LABELS: Record<string, string> = Object.freeze({
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  autohand: "Autohand",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  deepseek: "DeepSeek",
  cursor: "Cursor",
  copilot: "Copilot",
  hermes: "Hermes",
  omp: "Oh My Pi",
  qoder: "Qoder",
  muse: "Muse",
  droid: "Droid"
});

export function getCliDisplayName(runtimeId: string): string {
  const brand = runtimeId.replace(/^cli:/, "");
  return CLI_BRAND_LABELS[brand] ?? (brand.charAt(0).toUpperCase() + brand.slice(1));
}

export function withTimeout<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Operation timed out")), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getStorage(): Storage | null {
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function readStoredEnvironmentPreset(): EnvironmentPreset {
  try {
    const storage = getStorage();
    const val = storage?.getItem(ENVIRONMENT_PRESET_STORAGE_KEY);
    return val === "max" ? "max" : "custom";
  } catch {
    return "custom";
  }
}

export function readStoredCustomDocks(): string[] {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return readHiddenDockIds();
}

export function readStoredCustomPanes(): string[] {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return readHiddenPaneIds();
}

export function readStoredCustomWidgets(): DesktopWidgetId[] {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as DesktopWidgetId[];
    }
  } catch {}
  return readHiddenWidgetIds();
}

export function readStoredCustomCliDisabled(): string[] {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(CUSTOM_CLI_DISABLED_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function useEnvironmentPreset(options?: {
  isAdmin?: boolean;
  canManageCliRuntimes?: boolean;
  userId?: string;
}) {
  const [preset, setPreset] = useState<EnvironmentPreset>(readStoredEnvironmentPreset);
  const [isActivating, setIsActivating] = useState(false);
  const [activationStep, setActivationStep] = useState(0);
  const [activationProgress, setActivationProgress] = useState(0);
  const [activationStepLabel, setActivationStepLabel] = useState("");
  const [activationComplete, setActivationComplete] = useState(false);
  const [restoredCustom, setRestoredCustom] = useState(false);
  const isOperatingRef = useRef(false);
  const completeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (completeTimerRef.current !== null) {
      clearTimeout(completeTimerRef.current);
      completeTimerRef.current = null;
    }
    if (restoreTimerRef.current !== null) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
  }, []);

  const dismissBanners = useCallback(() => {
    clearTimers();
    setActivationComplete(false);
    setRestoredCustom(false);
  }, [clearTimers]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  // Seed custom snapshots initially if unset and in custom mode
  useEffect(() => {
    const storage = getStorage();
    if (!storage) return;
    if (readStoredEnvironmentPreset() === "custom") {
      if (storage.getItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY) === null) {
        storage.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(readHiddenDockIds()));
      }
      if (storage.getItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY) === null) {
        storage.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(readHiddenPaneIds()));
      }
      if (storage.getItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY) === null) {
        storage.setItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY, JSON.stringify(readHiddenWidgetIds()));
      }
      if (storage.getItem(CUSTOM_CLI_DISABLED_STORAGE_KEY) === null) {
        storage.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(DEFAULT_CUSTOM_DISABLED_CLIS));
      }
    }
  }, []);

  // Sync state if changed externally or from server
  useEffect(() => {
    const handleUpdate = (e: Event) => {
      if (e instanceof CustomEvent && e.detail?.preset) {
        setPreset(e.detail.preset === "max" ? "max" : "custom");
      } else {
        setPreset(readStoredEnvironmentPreset());
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener(ENVIRONMENT_PRESET_CHANGED_EVENT, handleUpdate);
      return () => window.removeEventListener(ENVIRONMENT_PRESET_CHANGED_EVENT, handleUpdate);
    }
  }, []);

  // When user is in "custom" mode, track manual adjustments to docks, panes, and CLIs
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleDocksChange = (e: Event) => {
      if (isOperatingRef.current) return;
      if (readStoredEnvironmentPreset() === "custom") {
        const detail = (e as CustomEvent<string[]>).detail ?? readHiddenDockIds();
        const storage = getStorage();
        storage?.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(detail));
        saveUserSettingDebounced("customDocksHidden", detail);
      }
    };

    const handlePanesChange = (e: Event) => {
      if (isOperatingRef.current) return;
      if (readStoredEnvironmentPreset() === "custom") {
        const detail = (e as CustomEvent<string[]>).detail ?? readHiddenPaneIds();
        const storage = getStorage();
        storage?.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(detail));
        saveUserSettingDebounced("customPanesHidden", detail);
      }
    };

    const handleCliChange = (e: Event) => {
      if (isOperatingRef.current) return;
      if (readStoredEnvironmentPreset() === "custom") {
        const change = readCliRuntimeVisibilityChange(e);
        if (!change?.runtimeId) return;
        const current = readStoredCustomCliDisabled();
        let next: string[];
        if (change.enabled === false) {
          next = current.includes(change.runtimeId) ? current : [...current, change.runtimeId];
        } else {
          next = current.filter((id) => id !== change.runtimeId);
        }
        const storage = getStorage();
        storage?.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(next));
        saveUserSettingDebounced("customCliDisabled", next);
      }
    };

    const handleWidgetsChange = (e: Event) => {
      if (isOperatingRef.current) return;
      if (readStoredEnvironmentPreset() === "custom") {
        const detail = (e as CustomEvent<DesktopWidgetId[]>).detail ?? readHiddenWidgetIds();
        const storage = getStorage();
        storage?.setItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY, JSON.stringify(detail));
      }
    };

    window.addEventListener(DOCKS_VISIBILITY_EVENT, handleDocksChange);
    window.addEventListener(PANES_VISIBILITY_EVENT, handlePanesChange);
    window.addEventListener(WIDGETS_VISIBILITY_EVENT, handleWidgetsChange);
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliChange);

    return () => {
      window.removeEventListener(DOCKS_VISIBILITY_EVENT, handleDocksChange);
      window.removeEventListener(PANES_VISIBILITY_EVENT, handlePanesChange);
      window.removeEventListener(WIDGETS_VISIBILITY_EVENT, handleWidgetsChange);
      window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliChange);
    };
  }, []);

  const switchToMax = useCallback(async () => {
    if (isActivating || isOperatingRef.current) return;
    isOperatingRef.current = true;
    clearTimers();
    setIsActivating(true);
    setActivationComplete(false);
    setRestoredCustom(false);
    setPreset("max");

    try {
      const storage = getStorage();

      // Snapshot current custom state
      const currentHiddenDocks = readHiddenDockIds();
      const currentHiddenPanes = readHiddenPaneIds();
      const currentHiddenWidgets = readHiddenWidgetIds();
      storage?.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(currentHiddenDocks));
      storage?.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(currentHiddenPanes));
      storage?.setItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY, JSON.stringify(currentHiddenWidgets));
      saveUserSettingDebounced("customDocksHidden", currentHiddenDocks);
      saveUserSettingDebounced("customPanesHidden", currentHiddenPanes);

      // Snapshot disabled CLI runtimes if available
      let disabledCliIds: string[] = [];
      if (options?.canManageCliRuntimes) {
        try {
          const cliSettings = (api as any).cliRuntimeSettingsSnapshot?.()
            ?? await withTimeout(api.cliRuntimeSettings(), 3000);
          disabledCliIds = (cliSettings?.settings ?? [])
            .filter((s: any) => !s.enabled)
            .map((s: any) => s.runtimeId);
          const toSave = disabledCliIds.length > 0 ? disabledCliIds : [...DEFAULT_CUSTOM_DISABLED_CLIS];
          storage?.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(toSave));
          saveUserSettingDebounced("customCliDisabled", toSave);
        } catch {
          storage?.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(DEFAULT_CUSTOM_DISABLED_CLIS));
        }
      }

      // Step 1: Activate Workspace Docks (12 docks)
      setActivationStep(1);
      setActivationProgress(25);
      setActivationStepLabel("Activating workspace docks (12/12)...");
      writeHiddenDockIds([]);
      saveUserSettingDebounced("docksHidden", []);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 2: Activate Workspace Panes (9 non-CLI panes) & Desktop Widgets (7 widgets)
      setActivationStep(2);
      setActivationProgress(50);
      setActivationStepLabel("Activating workspace panes and widgets...");
      writeHiddenPaneIds([]);
      writeHiddenWidgetIds([]);
      saveUserSettingDebounced("panesHidden", []);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 3: Activate CLI Coding Runtimes & Types (16 CLI types in canonical order)
      setActivationStep(3);
      setActivationProgress(70);
      setActivationStepLabel("Checking CLI runtimes...");

      if (options?.canManageCliRuntimes) {
        let clisToEnable: string[] = CANONICAL_CLI_ORDER.map((brand) => `cli:${brand}`);
        try {
          const snapshot = (api as any).cliRuntimeSettingsSnapshot?.()
            ?? await withTimeout((api as any).cliRuntimeSettings?.(), 3000).catch(() => null);
          if (snapshot?.settings && Array.isArray(snapshot.settings)) {
            const enabledSet = new Set(
              snapshot.settings.filter((s: any) => s.enabled).map((s: any) => s.runtimeId)
            );
            clisToEnable = clisToEnable.filter((id) => !enabledSet.has(id));
          }
        } catch {
          // If checking settings fails, fallback to canonical order
        }

        const totalClis = clisToEnable.length;
        if (totalClis === 0) {
          setActivationProgress(95);
          setActivationStepLabel("All CLI runtimes already active...");
          await new Promise((resolve) => setTimeout(resolve, 150));
        } else {
          for (let i = 0; i < totalClis; i++) {
            const runtimeId = clisToEnable[i];
            if (!runtimeId) continue;
            const name = getCliDisplayName(runtimeId);
            const progress = 70 + Math.round(((i + 1) / totalClis) * 25);
            setActivationProgress(progress);
            setActivationStepLabel(`Activating ${name} (${i + 1}/${totalClis})...`);

            try {
              await withTimeout(api.updateCliRuntimeSetting(runtimeId, { enabled: true }), 4000);
            } catch {
              // Ignore individual runtime errors to ensure completion
            }
          }
        }

        try {
          (api as any).invalidateCliRuntimeSettings?.();
        } catch {
          // Ignore if runtime not installed
        }
        dispatchCliRuntimeVisibilityChange({
          source: "settings-card"
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 4: Finalize Max mode
      setActivationProgress(100);
      setActivationStepLabel("Finalizing...");
      storage?.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "max");
      saveUserSettingDebounced("environmentPreset", "max");
      setPreset("max");

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(ENVIRONMENT_PRESET_CHANGED_EVENT, { detail: { preset: "max" } })
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      setIsActivating(false);
      setActivationComplete(true);
      completeTimerRef.current = setTimeout(() => {
        setActivationComplete(false);
        completeTimerRef.current = null;
      }, 7000);
    } finally {
      setIsActivating(false);
      isOperatingRef.current = false;
    }
  }, [clearTimers, isActivating, options?.canManageCliRuntimes]);

  const switchToCustom = useCallback(async () => {
    if (isActivating || isOperatingRef.current) return;
    isOperatingRef.current = true;
    clearTimers();
    setIsActivating(true);
    setActivationComplete(false);
    setRestoredCustom(false);
    setPreset("custom");

    try {
      const storage = getStorage();
      const savedDocks = readStoredCustomDocks();
      const savedPanes = readStoredCustomPanes();
      const savedWidgets = readStoredCustomWidgets();
      const rawCustomCli = readStoredCustomCliDisabled();
      const clisToDisable = rawCustomCli.length > 0 ? rawCustomCli : [...DEFAULT_CUSTOM_DISABLED_CLIS];

      // Step 1: Restore workspace docks (25%)
      setActivationStep(1);
      setActivationProgress(25);
      setActivationStepLabel("Restoring custom workspace docks...");
      writeHiddenDockIds(savedDocks);
      saveUserSettingDebounced("docksHidden", savedDocks);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 2: Restore workspace panes (50%) & desktop widgets
      setActivationStep(2);
      setActivationProgress(50);
      setActivationStepLabel("Restoring custom workspace panes and widgets...");
      writeHiddenPaneIds(savedPanes);
      writeHiddenWidgetIds(savedWidgets);
      saveUserSettingDebounced("panesHidden", savedPanes);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 3: Disable non-custom CLI runtimes (70% - 95%)
      setActivationStep(3);
      setActivationProgress(70);
      setActivationStepLabel("Checking CLI runtimes...");

      if (options?.canManageCliRuntimes && clisToDisable.length > 0) {
        let targets = [...clisToDisable];
        try {
          const snapshot = (api as any).cliRuntimeSettingsSnapshot?.()
            ?? await withTimeout((api as any).cliRuntimeSettings?.(), 3000).catch(() => null);
          if (snapshot?.settings && Array.isArray(snapshot.settings)) {
            const disabledSet = new Set(
              snapshot.settings.filter((s: any) => !s.enabled).map((s: any) => s.runtimeId)
            );
            targets = targets.filter((id) => !disabledSet.has(id));
          }
        } catch {
          // If checking settings fails, fallback to clisToDisable
        }

        const totalClis = targets.length;
        const keptWithOpenWork: string[] = [];
        if (totalClis === 0) {
          setActivationProgress(95);
          setActivationStepLabel("Non-custom CLIs already disabled...");
          await new Promise((resolve) => setTimeout(resolve, 150));
        } else {
          for (let i = 0; i < totalClis; i++) {
            const runtimeId = targets[i];
            if (!runtimeId) continue;
            const name = getCliDisplayName(runtimeId);
            const progress = 70 + Math.round(((i + 1) / totalClis) * 25);
            setActivationProgress(progress);
            setActivationStepLabel(`Disabling ${name} (${i + 1}/${totalClis})...`);

            try {
              await withTimeout(
                (async () => {
                  const preview = await (api as any).cliRuntimeDisablePreview?.(runtimeId);
                  // A preset never closes open panes or stops running work; that CLI stays enabled.
                  if (
                    (preview?.openPaneCount ?? 0) + (preview?.activeSessionCount ?? 0) +
                    (preview?.openChatPaneCount ?? 0) + (preview?.activeChatRunCount ?? 0) > 0
                  ) {
                    keptWithOpenWork.push(name);
                    return;
                  }
                  const token = preview?.confirmationToken || "CONFIRM";
                  await api.updateCliRuntimeSetting(runtimeId, {
                    enabled: false,
                    confirmationToken: token
                  });
                })(),
                4000
              );
            } catch {
              // Ignore individual disable errors
            }
          }
          if (keptWithOpenWork.length > 0) {
            setActivationStepLabel(`Kept ${keptWithOpenWork.join(", ")} enabled: open panes are still using ${keptWithOpenWork.length === 1 ? "it" : "them"}.`);
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
        }

        try {
          (api as any).invalidateCliRuntimeSettings?.();
        } catch {
          // Ignore if runtime not installed
        }
        dispatchCliRuntimeVisibilityChange({
          source: "settings-card"
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Step 4: Finalize Custom mode (100%)
      setActivationProgress(100);
      setActivationStepLabel("Finalizing...");
      storage?.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "custom");
      saveUserSettingDebounced("environmentPreset", "custom");
      storage?.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(clisToDisable));
      saveUserSettingDebounced("customCliDisabled", clisToDisable);
      setPreset("custom");

      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(ENVIRONMENT_PRESET_CHANGED_EVENT, { detail: { preset: "custom" } })
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
      setIsActivating(false);
      setRestoredCustom(true);
      restoreTimerRef.current = setTimeout(() => {
        setRestoredCustom(false);
        restoreTimerRef.current = null;
      }, 5000);
    } finally {
      setIsActivating(false);
      isOperatingRef.current = false;
    }
  }, [clearTimers, isActivating, options?.canManageCliRuntimes]);

  return {
    preset,
    isActivating,
    activationStep,
    activationProgress,
    activationStepLabel,
    activationComplete,
    restoredCustom,
    dismissBanners,
    switchToMax,
    switchToCustom
  };
}
