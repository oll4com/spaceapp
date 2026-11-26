import { lazy } from "react";
import { lazyWithPreload } from "../lazy-with-preload.js";

// Non-Warm screens, docks and dialogs split out of App.js (speed audit 21/11).
export const LazyMovePaneDialog = lazy(() => import("./pane-dialogs/PaneDialogs.js").then(m => ({ default: m.MovePaneDialog })));
export const LazyLoginScreen = lazy(() => import("./auth/LoginScreen.js").then(m => ({ default: m.LoginScreen })));
export const LazyAsteroidsGate = lazy(() => import("./asteroids/AsteroidsGate.js").then(m => ({ default: m.AsteroidsGate })));
export const LazyOwnerSetupScreen = lazy(() => import("./auth/OwnerSetupScreen.js").then(m => ({ default: m.OwnerSetupScreen })));
export const LazyHealthDock = lazy(() => import("./health/HealthDock.js").then(m => ({ default: m.HealthDock })));
export const LazyLinksPanel = lazy(() => import("./user-links/UserLinks.js").then(m => ({ default: m.LinksPanel })));
export const LazyQuickLinksPopover = lazy(() => import("./user-links/UserLinks.js").then(m => ({ default: m.QuickLinksPopover })));
export const LazyCliRuntimeRestartAllDialog = lazy(() => import("./server-actions/RestartDialogs.js").then(m => ({ default: m.CliRuntimeRestartAllDialog })));
export const LazyServerRestartDialog = lazy(() => import("./server-actions/RestartDialogs.js").then(m => ({ default: m.ServerRestartDialog })));
export const LazyStickyNoteLayer = lazy(() => import("./clipboard-dock/StickyNoteWindow.js").then(m => ({ default: m.StickyNoteLayer })));
export const LazyStickyNoteWindow = lazy(() => import("./clipboard-dock/StickyNoteWindow.js").then(m => ({ default: m.StickyNoteWindow })));
// Side docks (Slice 9): idle preload so the first open renders without a fallback flash.
export const LazyAgentSettingsDock = lazyWithPreload(() => import("./settings/AgentSettingsDock.js").then(m => ({ default: m.AgentSettingsDock })), { idle: true });
// The rooms dock is the desktop's open dock at start: fetch it now, in parallel with the auth round trip it renders after.
export const LazyRoomsDockPanel = lazyWithPreload(() => import("./rooms-dock/RoomsDockPanel.js").then(m => ({ default: m.RoomsDockPanel })));
void LazyRoomsDockPanel.preload().catch(() => undefined);
