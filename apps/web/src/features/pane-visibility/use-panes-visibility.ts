import { useCallback, useEffect, useMemo, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import type { NonCliPaneType, PaneItemConfig } from "./pane-visibility-types.js";
import { saveUserSettingDebounced } from "../user-settings/user-settings-save-queue.js";
import { SERVER_MODULES_EVENT, serverModuleOn } from "./server-modules.js";

// Panes that belong to an optional server module: hidden while the server has the module off.
const PANE_SERVER_MODULE: Partial<Record<NonCliPaneType, string>> = {
  jobs: "job-copilot",
  mail: "mail-copilot",
  marketing: "marketing-copilot",
  freelance: "freelance-copilot"
};

export const PANES_HIDDEN_STORAGE_KEY = "space:panes-hidden:v1";
export const PANES_VISIBILITY_EVENT = "space:panes-visibility-changed";

export const NON_CLI_PANE_DEFINITIONS: PaneItemConfig[] = [
  {
    id: "chat",
    actionId: "add-chat",
    label: "Chat",
    description: "Start a conversation with an AI assistant.",
    icon: modeIcons.CHAT
  },
  {
    id: "browser",
    actionId: "add-browser",
    label: "Browser",
    description: "Browse the web inside this room.",
    icon: modeIcons.BROWSER
  },
  {
    id: "files",
    actionId: "add-files",
    label: "File Manager",
    description: "Open the native file manager pane in this room.",
    icon: modeIcons.FILES
  },
  {
    id: "databases",
    actionId: "add-databases",
    label: "Databases",
    description: "Explore, query and manage relational databases.",
    icon: modeIcons.DATABASES
  },
  {
    id: "demos",
    actionId: "add-demos",
    label: "Demo Projects",
    description: "Explore and run demo applications with live previews.",
    icon: modeIcons.DEMOS
  },
  {
    id: "youtube",
    actionId: "add-youtube",
    label: "YouTube",
    description: "Watch a video alongside your work.",
    icon: modeIcons.YOUTUBE
  },
  {
    id: "vnc",
    actionId: "add-vnc",
    label: "VNC",
    description: "Connect to a graphical remote desktop.",
    icon: modeIcons.VNC
  },
  {
    id: "live",
    actionId: "add-live",
    label: "Live audio",
    description: "Interactive real-time voice and audio conversation.",
    icon: modeIcons.LIVE
  },
  {
    id: "harness",
    actionId: "add-harness",
    label: "DeepSeek Harness",
    description: "Open a DeepSeek Harness coding session.",
    icon: modeIcons.HARNESS,
    requiresHarness: true
  },
  {
    id: "t3code",
    actionId: "add-t3code",
    label: "T3 Code",
    description: "Supervise CLI agent execution with structured event streaming and visual diff review.",
    icon: modeIcons.T3CODE
  },
  {
    id: "jobs",
    actionId: "add-jobs",
    label: "Job Copilot",
    description: "A Claude Code agent and a live browser that find, fill and submit job applications from your CV.",
    icon: modeIcons.JOB_APPLY
  },
  {
    id: "mail",
    actionId: "add-mail",
    label: "Mail Copilot",
    description: "All your Gmail accounts in one inbox, with an agent that learns how you handle mail and gradually answers for you.",
    icon: modeIcons.MAIL_COPILOT
  },
  {
    id: "marketing",
    actionId: "add-marketing",
    label: "Marketing Copilot",
    description: "An agent and a live browser that plan, write and publish posts promoting SpaceApp on your own accounts, after your approval.",
    icon: modeIcons.MARKETING_COPILOT
  },
  {
    id: "freelance",
    actionId: "add-freelance",
    label: "Freelance Copilot",
    description: "An agent and a live browser that find clients on freelance platforms, send proposals and talk to clients until they are ready for you.",
    icon: modeIcons.FREELANCE_COPILOT
  }
];

export const VALID_PANE_IDS = new Set<string>(
  NON_CLI_PANE_DEFINITIONS.map((pane) => pane.id)
);

export const ACTION_TO_PANE_TYPE: Record<string, NonCliPaneType> = {
  "add-chat": "chat",
  "add-browser": "browser",
  "add-files": "files",
  "add-databases": "databases",
  "add-demos": "demos",
  "add-youtube": "youtube",
  "add-vnc": "vnc",
  "add-live": "live",
  "add-harness": "harness",
  "add-t3code": "t3code",
  "add-jobs": "jobs",
  "add-mail": "mail",
  "add-marketing": "marketing",
  "add-freelance": "freelance"
};

export const PANE_TYPE_TO_ACTION: Record<NonCliPaneType, string> = {
  chat: "add-chat",
  browser: "add-browser",
  files: "add-files",
  databases: "add-databases",
  demos: "add-demos",
  youtube: "add-youtube",
  vnc: "add-vnc",
  live: "add-live",
  harness: "add-harness",
  t3code: "add-t3code",
  jobs: "add-jobs",
  mail: "add-mail",
  marketing: "add-marketing",
  freelance: "add-freelance"
};

export type { NonCliPaneType, PaneItemConfig } from "./pane-visibility-types.js";

export function resolvePaneId(idOrAction: string): NonCliPaneType | null {
  if (VALID_PANE_IDS.has(idOrAction)) return idOrAction as NonCliPaneType;
  if (idOrAction in ACTION_TO_PANE_TYPE) return ACTION_TO_PANE_TYPE[idOrAction] ?? null;
  return null;
}

function getStorage(customStorage?: Storage): Storage | null {
  if (customStorage) return customStorage;
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function normalizeHiddenPaneIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const valid = values
    .map((item) => (typeof item === "string" ? resolvePaneId(item) : null))
    .filter((id): id is NonCliPaneType => id !== null);
  return Array.from(new Set(valid));
}

export function readHiddenPaneIds(customStorage?: Storage): string[] {
  try {
    const storage = getStorage(customStorage);
    if (!storage) return [];
    const raw = storage.getItem(PANES_HIDDEN_STORAGE_KEY);
    if (!raw) return [];
    return normalizeHiddenPaneIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeHiddenPaneIds(hiddenIds: string[], customStorage?: Storage): void {
  try {
    const storage = getStorage(customStorage);
    const normalized = normalizeHiddenPaneIds(hiddenIds);
    if (storage) {
      if (normalized.length > 0) {
        storage.setItem(PANES_HIDDEN_STORAGE_KEY, JSON.stringify(normalized));
      } else {
        storage.removeItem(PANES_HIDDEN_STORAGE_KEY);
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PANES_VISIBILITY_EVENT, { detail: normalized }));
    }
  } catch {
    // Ignore storage errors in restrictive environments
  }
}

export function usePanesVisibility(customStorage?: Storage) {
  const [hiddenPaneIds, setHiddenPaneIds] = useState<string[]>(() => readHiddenPaneIds(customStorage));
  const [serverModulesVersion, setServerModulesVersion] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleModules = () => setServerModulesVersion((version) => version + 1);
    window.addEventListener(SERVER_MODULES_EVENT, handleModules);
    return () => window.removeEventListener(SERVER_MODULES_EVENT, handleModules);
  }, []);

  useEffect(() => {
    const handleUpdate = () => {
      setHiddenPaneIds(readHiddenPaneIds(customStorage));
    };
    if (typeof window !== "undefined") {
      window.addEventListener(PANES_VISIBILITY_EVENT, handleUpdate);
      window.addEventListener("storage", handleUpdate);
      return () => {
        window.removeEventListener(PANES_VISIBILITY_EVENT, handleUpdate);
        window.removeEventListener("storage", handleUpdate);
      };
    }
  }, [customStorage]);

  const hiddenSet = useMemo(() => new Set(hiddenPaneIds), [hiddenPaneIds]);

  const isPaneHidden = useCallback(
    (idOrAction: string) => {
      const resolved = resolvePaneId(idOrAction);
      if (!resolved) return false;
      const serverModule = PANE_SERVER_MODULE[resolved];
      return hiddenSet.has(resolved) || (serverModule !== undefined && !serverModuleOn(serverModule));
    },
    // serverModulesVersion re-creates the callback when the server's module list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiddenSet, serverModulesVersion]
  );

  const isPaneVisible = useCallback(
    (idOrAction: string) => {
      const resolved = resolvePaneId(idOrAction);
      if (!resolved) return true;
      return !hiddenSet.has(resolved);
    },
    [hiddenSet]
  );

  const hidePane = useCallback(
    (idOrAction: string) => {
      const resolved = resolvePaneId(idOrAction);
      if (!resolved || hiddenSet.has(resolved)) return;
      const next = [...hiddenPaneIds, resolved];
      writeHiddenPaneIds(next, customStorage);
      setHiddenPaneIds(next);
      saveUserSettingDebounced("panesHidden", next);
    },
    [customStorage, hiddenPaneIds, hiddenSet]
  );

  const showPane = useCallback(
    (idOrAction: string) => {
      const resolved = resolvePaneId(idOrAction);
      if (!resolved || !hiddenSet.has(resolved)) return;
      const next = hiddenPaneIds.filter((hiddenId) => hiddenId !== resolved);
      writeHiddenPaneIds(next, customStorage);
      setHiddenPaneIds(next);
      saveUserSettingDebounced("panesHidden", next);
    },
    [customStorage, hiddenPaneIds, hiddenSet]
  );

  const togglePane = useCallback(
    (idOrAction: string) => {
      const resolved = resolvePaneId(idOrAction);
      if (!resolved) return;
      if (hiddenSet.has(resolved)) {
        showPane(resolved);
      } else {
        hidePane(resolved);
      }
    },
    [hiddenSet, hidePane, showPane]
  );

  const resetPanes = useCallback(() => {
    writeHiddenPaneIds([], customStorage);
    setHiddenPaneIds([]);
    saveUserSettingDebounced("panesHidden", []);
  }, [customStorage]);

  return {
    hiddenPaneIds,
    isPaneHidden,
    isPaneVisible,
    hidePane,
    showPane,
    togglePane,
    resetPanes
  };
}
