import { preloadIdleSurfaces } from "../../lazy-with-preload.js";

let hasPreloaded = false;
const NON_CRITICAL_DOCK_PRELOAD_DELAY_MS = 5_000;

/**
 * Pre-warms the dynamic import chunks for all dock components during browser idle time.
 * This guarantees that when the user clicks any dock for the first time, the code chunk
 * is already in the browser HTTP / module cache, avoiding any load delay or spinner.
 */
export function preloadDockModules(): void {
  if (hasPreloaded || typeof window === "undefined" || (typeof process !== "undefined" && process.env?.NODE_ENV === "test")) return;
  hasPreloaded = true;

  const prewarm = () => {
    void Promise.allSettled([
      import("../clipboard-dock/ClipboardDock.js"),
      import("../task-dock/TaskDock.js"),
      import("../agent-files/AgentFilesDock.js"),
      import("../media-dock/MediaDock.js"),
      import("../shared-chat/SharedChatDock.js"),
      import("../nous/NousDock.js"),
      import("../cli-dock/CliDock.js"),
      import("../agent-sessions/AgentSessionsDock.js"),
      import("../room-agent/RoomAgentDock.js"),
      import("../source-control/SourceControlDock.js"),
      import("../streaming/StreamingDock.js"),
      import("../memory-workspace/MemoryWorkspace.js"),
      import("../chat-launcher/ChatLauncherMenu.js"),
      import("../server-actions/ServerActionsMenu.js"),
      import("../pane-layout/PaneSpanAllMenu.js"),
      import("../vibe-music/VibeMusicPlayer.js"),
      import("../snip-tool/SnipToolOverlay.js"),
      import("../settings/EnvironmentPresetCard.js"),
      import("../auth/GoogleAccountSettingsCard.js"),
      import("../settings/DocksSettingsCard.js"),
      import("../settings/PanesSettingsCard.js"),
      import("../settings/WidgetsSettingsCard.js"),
      import("../date-time-settings/DateTimeSettingsCard.js"),
      import("../app-diagnostics/AppDiagnosticsSettingsCard.js"),
      import("../plugins/PluginsSettingsCard.js"),
      import("../keyboard-autocorrect/KeyboardAutocorrectSettingsCard.js"),
      import("../prompt-variables/PromptVariablesSettingsCard.js"),
      // Resolve the App surfaces built with lazyWithPreload so their first
      // open renders directly instead of suspending on a cached chunk.
      preloadIdleSurfaces()
    ]);
  };

  // Keep the first hard refresh focused on the workspace shell and its active
  // room. Loading every hidden dock at once creates a burst of script and CSS
  // requests immediately after mount, competing with the room's own pane
  // hydration. Docks remain lazy and start warming after the initial window has
  // settled, preserving the fast second-open path without taxing startup.
  window.setTimeout(() => {
    if ("requestIdleCallback" in window && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => prewarm(), { timeout: 10_000 });
    } else {
      prewarm();
    }
  }, NON_CRITICAL_DOCK_PRELOAD_DELAY_MS);
}
