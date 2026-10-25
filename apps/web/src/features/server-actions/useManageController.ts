import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import {
  Activity,
  Boxes,
  Eraser,
  Gauge,
  Link as LinkIcon,
  RefreshCw,
  Rocket,
  ServerCog,
  Terminal,
  Trash2,
  Users,
  Wrench
} from "../ui-theme/app-icons.js";
import type { CodexEnvironment } from "@space/contracts";
import { api, type ReadyzPayload } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import type { AdminCodexTool } from "../admin-codex-tools/AdminCodexToolsDialog.js";
import type { AdminOperationTool } from "../admin-operations/AdminOperationsDialog.js";
import { openManage } from "./manage-navigation.js";
import type { ServerActionCommand } from "./ServerActionsMenu.js";

// The Manage menu (server actions), the setup & connections wizard it opens, and the
// admin dialogs and restart confirmations behind its commands.

export interface ManageControllerContext {
  /** `auth?.user?.role`: only admins open Manage from the `space:manage` event. */
  role: string | undefined;
  /** Receives each readiness sample while a server restart is awaited. */
  onReadiness: (readiness: ReadyzPayload) => void;
  /** Receives the host environment once the restarted server is ready. */
  onEnvironment: (environment: CodexEnvironment) => void;
}

export interface RestartDialogController {
  isOpen: boolean;
  pending: boolean;
  message: string | null;
  error: string | null;
  open: () => void;
  close: () => void;
  confirm: () => Promise<void>;
  dismissMessage: () => void;
  dismissError: () => void;
}

export interface ServerActionCommandsContext {
  isCodexEnabled: boolean;
  anyCliEnabled: boolean;
  /** Opens the memory-reclaim panel anchored to the Manage trigger. */
  reclaimMemory: (anchor: HTMLButtonElement | null) => void;
  openSystemAnalytics: () => void;
}

export interface ManageController {
  serverActionsButtonRef: MutableRefObject<HTMLButtonElement | null>;
  adminCodexToolTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  adminOperationToolTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  userManagementTriggerRef: MutableRefObject<HTMLButtonElement | null>;
  isServerActionsMenuOpen: boolean;
  setIsServerActionsMenuOpen: (open: boolean) => void;
  manageLoginPending: boolean;
  manageLoginPendingRef: MutableRefObject<boolean>;
  setManageLoginPending: (pending: boolean) => void;
  manageInitialAction: string | null;
  isSetupConnectionsOpen: boolean;
  setIsSetupConnectionsOpen: (open: boolean) => void;
  workspaceSetupHost: HTMLDivElement | null;
  setWorkspaceSetupHost: (host: HTMLDivElement | null) => void;
  workspaceSetupBack: MutableRefObject<(() => void) | null>;
  /** True once the wizard has been shown inside the Workspace menu. */
  setupFromWorkspace: MutableRefObject<boolean>;
  /** True once the wizard has mounted; it then stays mounted. */
  setupConnectionsMounted: RefObject<boolean>;
  adminCodexTool: AdminCodexTool | null;
  adminOperationTool: AdminOperationTool | null;
  isSystemServicesDialogOpen: boolean;
  isUserManagementOpen: boolean;
  closeAdminCodexTool: () => void;
  closeAdminOperationTool: () => void;
  closeSystemServicesDialog: () => void;
  closeUserManagement: () => void;
  serverRestart: RestartDialogController;
  cliRuntimeRestartAll: RestartDialogController;
  /** Commands of the Manage menu; empty for non-admins. */
  buildCommands: (context: ServerActionCommandsContext) => ServerActionCommand[];
}

export function useManageController({ role, onReadiness, onEnvironment }: ManageControllerContext): ManageController {
  const [isServerActionsMenuOpen, setIsServerActionsMenuOpen] = useState(false);
  const [manageLoginPending, setManageLoginPending] = useState(false);
  const manageLoginPendingRef = useRef(false);
  const [manageInitialAction, setManageInitialAction] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (role !== "ADMIN") return;
      manageLoginPendingRef.current = false;
      setManageLoginPending(false);
      setManageInitialAction((event as CustomEvent<{action?: string}>).detail?.action ?? null);
      setIsServerActionsMenuOpen(true);
    };
    window.addEventListener("space:manage", open);
    return () => window.removeEventListener("space:manage", open);
  }, [role]);

  const [isSetupConnectionsOpen, setIsSetupConnectionsOpen] = useState(false);
  const [workspaceSetupHost, setWorkspaceSetupHost] = useState<HTMLDivElement | null>(null);
  const workspaceSetupBack = useRef<(() => void) | null>(null);
  const setupFromWorkspace = useRef(false);
  const setupConnectionsMounted = useRef(false);
  if (workspaceSetupHost) setupFromWorkspace.current = true;
  if (isSetupConnectionsOpen || workspaceSetupHost) setupConnectionsMounted.current = true;
  const [isServerRestartDialogOpen, setIsServerRestartDialogOpen] = useState(false);
  const [adminCodexTool, setAdminCodexTool] = useState<AdminCodexTool | null>(null);
  const [adminOperationTool, setAdminOperationTool] = useState<AdminOperationTool | null>(null);
  const [isSystemServicesDialogOpen, setIsSystemServicesDialogOpen] = useState(false);
  const [isUserManagementOpen, setIsUserManagementOpen] = useState(false);
  const userManagementTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [serverRestartPending, setServerRestartPending] = useState(false);
  const [serverRestartMessage, setServerRestartMessage] = useState<string | null>(null);
  const [serverRestartError, setServerRestartError] = useState<string | null>(null);
  useAutoDismiss(serverRestartMessage, setServerRestartMessage);
  useAutoDismiss(serverRestartError, setServerRestartError);
  const [isCliRuntimeRestartAllDialogOpen, setIsCliRuntimeRestartAllDialogOpen] = useState(false);
  const [cliRuntimeRestartAllPending, setCliRuntimeRestartAllPending] = useState(false);
  const [cliRuntimeRestartAllMessage, setCliRuntimeRestartAllMessage] = useState<string | null>(null);
  const [cliRuntimeRestartAllError, setCliRuntimeRestartAllError] = useState<string | null>(null);
  useAutoDismiss(cliRuntimeRestartAllMessage, setCliRuntimeRestartAllMessage);
  useAutoDismiss(cliRuntimeRestartAllError, setCliRuntimeRestartAllError);
  const serverActionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const adminCodexToolTriggerRef = useRef<HTMLButtonElement | null>(null);
  const adminOperationToolTriggerRef = useRef<HTMLButtonElement | null>(null);

  function closeAdminCodexTool() {
    setAdminCodexTool(null);
    window.requestAnimationFrame(() => adminCodexToolTriggerRef.current?.focus());
  }

  function closeAdminOperationTool() {
    setAdminOperationTool(null);
    window.requestAnimationFrame(() => adminOperationToolTriggerRef.current?.focus());
  }

  function closeUserManagement() {
    setIsUserManagementOpen(false);
    window.requestAnimationFrame(() => userManagementTriggerRef.current?.focus());
  }

  function openServerRestartDialog() {
    setServerRestartError(null);
    setServerRestartMessage(null);
    setIsServerRestartDialogOpen(true);
  }

  function openCliRuntimeRestartAllDialog() {
    setCliRuntimeRestartAllError(null);
    setCliRuntimeRestartAllMessage(null);
    setIsCliRuntimeRestartAllDialogOpen(true);
  }

  function closeCliRuntimeRestartAllDialog() {
    if (cliRuntimeRestartAllPending) return;
    setIsCliRuntimeRestartAllDialogOpen(false);
    window.requestAnimationFrame(() => serverActionsButtonRef.current?.focus());
  }

  async function confirmCliRuntimeRestartAll() {
    if (cliRuntimeRestartAllPending) return;
    setCliRuntimeRestartAllPending(true);
    setCliRuntimeRestartAllError(null);
    setCliRuntimeRestartAllMessage("Restarting every CLI runtime session...");
    try {
      const result = await api.cliRuntimeRestartAll();
      const restarted = result.restartedSessionIds.length;
      const failed = result.failedSessionIds.length;
      setCliRuntimeRestartAllMessage(
        failed > 0
          ? `Restart requested: ${restarted} sessions restarted across ${result.requestedRuntimes.length} runtimes, ${failed} failed.`
          : `Restart requested: ${restarted} sessions restarted across ${result.requestedRuntimes.length} runtimes.`
      );
    } catch (err) {
      setCliRuntimeRestartAllMessage(null);
      setCliRuntimeRestartAllError(err instanceof Error ? err.message : "CLI restart-all failed.");
    } finally {
      setCliRuntimeRestartAllPending(false);
    }
  }

  function closeServerRestartDialog() {
    if (serverRestartPending) return;
    setIsServerRestartDialogOpen(false);
    window.requestAnimationFrame(() => serverActionsButtonRef.current?.focus());
  }

  async function waitForServerRestart(previousApiStartedAt: string) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const nextReady = await api.readyz();
        onReadiness(nextReady);
        if (nextReady.ok && nextReady.apiStartedAt && nextReady.apiStartedAt !== previousApiStartedAt) return;
      } catch {
        // The API is expected to be briefly unavailable while the core services restart.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    throw new Error("Timed out waiting for Space to become ready after restart.");
  }

  async function confirmServerRestart() {
    if (serverRestartPending) return;
    setServerRestartPending(true);
    setServerRestartError(null);
    setServerRestartMessage("Requesting server restart...");
    try {
      const accepted = await api.restartCoreServices();
      if (getSpaceRuntimeKind() === "demo") {
        setServerRestartMessage(DEMO_LOCAL_REPLY);
        return;
      }
      setServerRestartMessage("Restart request accepted. Waiting for Space to return...");
      await waitForServerRestart(accepted.apiStartedAt);
      try {
        onEnvironment(await api.codexEnvironment());
      } catch {
        // Host metrics are refreshed by the existing environment poll if this immediate read races the restart.
      }
      setServerRestartMessage("Server restarted and ready.");
    } catch (restartError) {
      const message = restartError instanceof Error ? restartError.message : "Server restart failed.";
      setServerRestartError(message);
      setServerRestartMessage(null);
    } finally {
      setServerRestartPending(false);
    }
  }

  function buildCommands({ isCodexEnabled, anyCliEnabled, reclaimMemory, openSystemAnalytics }: ServerActionCommandsContext): ServerActionCommand[] {
    return role === "ADMIN"
      ? [
          {
            id: "user-management",
            categoryHeader: "Users & Security",
            label: "Users & permissions",
            description: "Manage Space users, modify user/admin roles, and inspect rooms and Google account links.",
            icon: Users,
            onSelect: () => {
              userManagementTriggerRef.current = serverActionsButtonRef.current;
              openManage("user-management");
            }
          },
          {
            id: "setup-connections",
            categoryHeader: "Setup & Release",
            label: "Setup & connections",
            description: "Inspect and verify live provider connections, test API credentials, and complete setup.",
            icon: LinkIcon,
            onSelect: () => openManage("setup-connections")
          },
          {
            id: "publish-space-release",
            label: "Publish Space release",
            description: "Preview git state, tag a release version, and publish commits to Gitea and GitHub.",
            icon: Rocket,
            onSelect: () => {
              adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("publish-space-release");
            }
          },
          {
            id: "restart-server",
            categoryHeader: "Services & Runtimes",
            label: "Restart server",
            description: "Restart Space web, API, and worker services while keeping active CLI and browser panes alive.",
            icon: ServerCog,
            disabled: serverRestartPending,
            onSelect: openServerRestartDialog
          },
          {
            id: "restart-all-cli-runtimes",
            label: "Restart all CLI runtimes",
            description: "Sequentially restart sessions for all CLI types (codex, claude, gemini, opencode, kimi).",
            icon: Terminal,
            disabled: cliRuntimeRestartAllPending,
            onSelect: openCliRuntimeRestartAllDialog
          },
          {
            id: "space-cli-maintenance",
            categoryHeader: "Maintenance & Speed",
            label: "Space & CLI maintenance",
            description: "Run Space health checks, doctor diagnostics, package repairs, and guarded updates with rollback.",
            icon: Wrench,
            onSelect: () => {
              adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("space-cli-maintenance");
            }
          },
          {
            id: "codex-lb-speed-control",
            label: "Codex speed defaults",
            description: isCodexEnabled
              ? "Configure global default speed tiers (Standard or Fast) for active AI provider models."
              : "OFF · Enable Codex in Settings.",
            icon: Gauge,
            disabled: !isCodexEnabled,
            title: !isCodexEnabled ? "Enable Codex in Settings" : undefined,
            onSelect: () => {
              adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("codex-lb-speed-control");
            }
          },
          {
            id: "cli-session-cleanup",
            categoryHeader: "Cleanup & Storage",
            label: "Clean CLI sessions & storage",
            description: anyCliEnabled
              ? "Safely remove empty tasks (0 turns/messages), orphaned pane homes, and temporary store files."
              : "OFF · Enable a CLI in Settings.",
            icon: Trash2,
            disabled: !anyCliEnabled,
            title: !anyCliEnabled ? "Enable a CLI in Settings" : undefined,
            onSelect: () => {
              adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("cli-session-cleanup");
            }
          },
          {
            id: "codex-history-purge",
            label: "Purge inactive history",
            description: anyCliEnabled
              ? "Permanently remove inactive task history across CLIs not currently open in an active pane."
              : "OFF · Enable a CLI in Settings.",
            icon: Eraser,
            disabled: !anyCliEnabled,
            title: !anyCliEnabled ? "Enable a CLI in Settings" : undefined,
            onSelect: () => {
              adminCodexToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("codex-history-purge");
            }
          },
          {
            id: "reclaim-safe-memory",
            label: "Reclaim safe memory",
            description: "Free page cache and stop leftover CLIs of closed panes; CLIs of open panes keep running.",
            icon: RefreshCw,
            onSelect: () => reclaimMemory(serverActionsButtonRef.current)
          },
          {
            id: "system-analytics",
            categoryHeader: "Monitoring",
            label: "System analytics",
            description: "Live system telemetry, model performance, CPU & RAM, and CLI sessions.",
            icon: Activity,
            onSelect: openSystemAnalytics
          },
          {
            id: "system-services",
            label: "System services",
            description: "Inspect and control systemd services, background workers, and timers.",
            icon: Boxes,
            onSelect: () => openManage("system-services")
          },
          {
            id: "cli-update-all",
            label: "Update all CLIs",
            description: "Detect and apply available updates across all CLI runtimes.",
            icon: RefreshCw,
            onSelect: () => {
              adminOperationToolTriggerRef.current = serverActionsButtonRef.current;
              openManage("cli-update-all");
            }
          }
        ]
      : [];
  }

  return {
    serverActionsButtonRef,
    adminCodexToolTriggerRef,
    adminOperationToolTriggerRef,
    userManagementTriggerRef,
    isServerActionsMenuOpen,
    setIsServerActionsMenuOpen,
    manageLoginPending,
    manageLoginPendingRef,
    setManageLoginPending,
    manageInitialAction,
    isSetupConnectionsOpen,
    setIsSetupConnectionsOpen,
    workspaceSetupHost,
    setWorkspaceSetupHost,
    workspaceSetupBack,
    setupFromWorkspace,
    setupConnectionsMounted,
    adminCodexTool,
    adminOperationTool,
    isSystemServicesDialogOpen,
    isUserManagementOpen,
    closeAdminCodexTool,
    closeAdminOperationTool,
    closeSystemServicesDialog: () => setIsSystemServicesDialogOpen(false),
    closeUserManagement,
    serverRestart: {
      isOpen: isServerRestartDialogOpen,
      pending: serverRestartPending,
      message: serverRestartMessage,
      error: serverRestartError,
      open: openServerRestartDialog,
      close: closeServerRestartDialog,
      confirm: confirmServerRestart,
      dismissMessage: () => setServerRestartMessage(null),
      dismissError: () => setServerRestartError(null)
    },
    cliRuntimeRestartAll: {
      isOpen: isCliRuntimeRestartAllDialogOpen,
      pending: cliRuntimeRestartAllPending,
      message: cliRuntimeRestartAllMessage,
      error: cliRuntimeRestartAllError,
      open: openCliRuntimeRestartAllDialog,
      close: closeCliRuntimeRestartAllDialog,
      confirm: confirmCliRuntimeRestartAll,
      dismissMessage: () => setCliRuntimeRestartAllMessage(null),
      dismissError: () => setCliRuntimeRestartAllError(null)
    },
    buildCommands
  };
}
