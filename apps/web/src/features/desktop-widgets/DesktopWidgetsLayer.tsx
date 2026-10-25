import React, { memo, useCallback, useEffect, useState, type ComponentType } from "react";
import type { DesktopWidgetId, DesktopWidgetState } from "./types.js";
import { useDesktopWidgets } from "./widget-storage.js";
import { useWidgetsVisibility } from "./use-widgets-visibility.js";
import "./desktop-widgets.css";

interface DesktopWidgetComponentProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus: () => void;
}

type DesktopWidgetComponent = ComponentType<DesktopWidgetComponentProps>;

// Every widget is off by default, so widget code is only fetched once a
// widget is actually enabled. Loaded components are cached at module level so
// later renders (and re-enabling a widget) are synchronous.
const desktopWidgetLoaders: Record<DesktopWidgetId, () => Promise<DesktopWidgetComponent>> = {
  clock: () => import("./ClockWidget.js").then((module) => module.ClockWidget),
  "countdown-timer": () => import("./CountdownTimerWidget.js").then((module) => module.CountdownTimerWidget),
  "pushup-reminder": () => import("./PushupReminderWidget.js").then((module) => module.PushupReminderWidget),
  "spaceapp-promo": () => import("./SpaceAppPromoWidget.js").then((module) => module.SpaceAppPromoWidget),
  "ai-quota": () => import("./AiQuotaWidget.js").then((module) => module.AiQuotaWidget),
  "streaming-metrics": () => import("./StreamingMetricsWidget.js").then((module) => module.StreamingMetricsWidget)
};
const loadedDesktopWidgets = new Map<DesktopWidgetId, DesktopWidgetComponent>();
const pendingDesktopWidgets = new Map<DesktopWidgetId, Promise<DesktopWidgetComponent>>();

function loadDesktopWidget(id: DesktopWidgetId): Promise<DesktopWidgetComponent> {
  const loaded = loadedDesktopWidgets.get(id);
  if (loaded) return Promise.resolve(loaded);
  let pending = pendingDesktopWidgets.get(id);
  if (!pending) {
    pending = desktopWidgetLoaders[id]().then(
      (component) => {
        loadedDesktopWidgets.set(id, component);
        pendingDesktopWidgets.delete(id);
        return component;
      },
      (error: unknown) => {
        pendingDesktopWidgets.delete(id);
        throw error;
      }
    );
    pendingDesktopWidgets.set(id, pending);
  }
  return pending;
}

/** Resolve widget modules ahead of rendering (used by tests and warm-up paths). */
export function preloadDesktopWidgets(ids: readonly DesktopWidgetId[] = Object.keys(desktopWidgetLoaders) as DesktopWidgetId[]) {
  return Promise.all(ids.map((id) => loadDesktopWidget(id))).then(() => undefined);
}

function DeferredDesktopWidget({ widgetId, ...props }: DesktopWidgetComponentProps & { widgetId: DesktopWidgetId }) {
  const [Widget, setWidget] = useState<DesktopWidgetComponent | null>(() => loadedDesktopWidgets.get(widgetId) ?? null);
  useEffect(() => {
    if (Widget) return;
    let cancelled = false;
    loadDesktopWidget(widgetId).then(
      (component) => { if (!cancelled) setWidget(() => component); },
      (error: unknown) => { console.warn(`[desktop-widgets] ${widgetId} could not load`, error); }
    );
    return () => { cancelled = true; };
  }, [Widget, widgetId]);
  return Widget ? <Widget {...props} /> : null;
}

interface DesktopWidgetsLayerProps {
  widgetsController?: ReturnType<typeof useDesktopWidgets>;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
}

export function DesktopWidgetsLayer({
  widgetsController,
  isMultiColumn = false,
  isHeaderDockActive
}: DesktopWidgetsLayerProps) {
  if (widgetsController) {
    return (
      <DesktopWidgetsLayerContent
        controller={widgetsController}
        isMultiColumn={isMultiColumn}
        isHeaderDockActive={isHeaderDockActive}
      />
    );
  }
  return (
    <DesktopWidgetsLayerSelfContained
      isMultiColumn={isMultiColumn}
      isHeaderDockActive={isHeaderDockActive}
    />
  );
}

function DesktopWidgetsLayerSelfContained({
  isMultiColumn,
  isHeaderDockActive
}: {
  isMultiColumn: boolean;
  isHeaderDockActive?: boolean;
}) {
  const controller = useDesktopWidgets();
  return (
    <DesktopWidgetsLayerContent
      controller={controller}
      isMultiColumn={isMultiColumn}
      isHeaderDockActive={isHeaderDockActive}
    />
  );
}

const DesktopWidgetsLayerContent = memo(function DesktopWidgetsLayerContent({
  controller,
  isMultiColumn,
  isHeaderDockActive
}: {
  controller: ReturnType<typeof useDesktopWidgets>;
  isMultiColumn: boolean;
  isHeaderDockActive?: boolean;
}) {
  const { widgets, isWidgetEnabled, setPosition, toggleMinimize, bringToFront, closeWidget } =
    controller;
  const { isWidgetHidden } = useWidgetsVisibility();

  const anyEnabled = (Object.keys(widgets) as DesktopWidgetId[]).some(
    (id) => widgets[id]?.enabled && !isWidgetHidden(id)
  );

  useEffect(() => {
    if (isHeaderDockActive === false) {
      controller.enforceRailSlots?.();
    } else if (isHeaderDockActive === true) {
      controller.enforceHeaderSlots?.();
    }
  }, [isHeaderDockActive, controller]);

  const enabledIds = (Object.keys(widgets) as DesktopWidgetId[])
    .filter((id) => isWidgetEnabled(id) && !isWidgetHidden(id))
    .sort((a, b) => {
      if (isHeaderDockActive || isMultiColumn) {
        return (widgets[a]?.x ?? 0) - (widgets[b]?.x ?? 0);
      }
      return (widgets[a]?.y ?? 0) - (widgets[b]?.y ?? 0);
    });

  const handlePositionChange = useCallback(
    (id: DesktopWidgetId, x: number, y: number, docked?: boolean, dockPos?: "rail" | "header") => {
      setPosition(id, x, y, docked, dockPos);
    },
    [setPosition]
  );

  const handleToggleMinimize = useCallback(
    (id: DesktopWidgetId) => {
      toggleMinimize(id);
    },
    [toggleMinimize]
  );

  const handleClose = useCallback(
    (id: DesktopWidgetId) => {
      closeWidget(id);
    },
    [closeWidget]
  );

  const handleFocus = useCallback(
    (id: DesktopWidgetId) => {
      bringToFront(id);
    },
    [bringToFront]
  );

  if (!anyEnabled) return null;

  const renderWidget = (id: DesktopWidgetId) => {
    const state = widgets[id];
    if (!state) return null;
    return (
      <DeferredDesktopWidget
        key={id}
        widgetId={id}
        state={state}
        isMultiColumn={isMultiColumn}
        isHeaderDockActive={isHeaderDockActive}
        onPositionChange={(x, y, docked, dockPos) => handlePositionChange(id, x, y, docked, dockPos)}
        onToggleMinimize={() => handleToggleMinimize(id)}
        onClose={() => handleClose(id)}
        onFocus={() => handleFocus(id)}
      />
    );
  };

  return (
    <div className="desktop-widgets-layer" aria-label="Desktop float widgets">
      {enabledIds.map(renderWidget)}
    </div>
  );
});
