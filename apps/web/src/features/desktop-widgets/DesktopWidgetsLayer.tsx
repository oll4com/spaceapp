import React, { memo, useCallback, useEffect } from "react";
import { ClockWidget } from "./ClockWidget.js";
import { CountdownTimerWidget } from "./CountdownTimerWidget.js";
import { PushupReminderWidget } from "./PushupReminderWidget.js";
import { SpaceAppPromoWidget } from "./SpaceAppPromoWidget.js";
import { AiQuotaWidget } from "./AiQuotaWidget.js";
import { StreamingMetricsWidget } from "./StreamingMetricsWidget.js";
import type { DesktopWidgetId } from "./types.js";
import { useDesktopWidgets } from "./widget-storage.js";
import "./desktop-widgets.css";

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

  const anyEnabled = Object.values(widgets).some((w) => w.enabled);

  useEffect(() => {
    if (isHeaderDockActive === false) {
      controller.enforceRailSlots?.();
    } else if (isHeaderDockActive === true) {
      controller.enforceHeaderSlots?.();
    }
  }, [isHeaderDockActive, controller]);


  const enabledIds = (Object.keys(widgets) as DesktopWidgetId[])
    .filter((id) => isWidgetEnabled(id))
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
    switch (id) {
      case "clock":
        return (
          <ClockWidget
            key="clock"
            state={widgets.clock}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("clock", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("clock")}
            onClose={() => handleClose("clock")}
            onFocus={() => handleFocus("clock")}
          />
        );
      case "countdown-timer":
        return (
          <CountdownTimerWidget
            key="countdown-timer"
            state={widgets["countdown-timer"]}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("countdown-timer", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("countdown-timer")}
            onClose={() => handleClose("countdown-timer")}
            onFocus={() => handleFocus("countdown-timer")}
          />
        );
      case "pushup-reminder":
        return (
          <PushupReminderWidget
            key="pushup-reminder"
            state={widgets["pushup-reminder"]}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("pushup-reminder", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("pushup-reminder")}
            onClose={() => handleClose("pushup-reminder")}
            onFocus={() => handleFocus("pushup-reminder")}
          />
        );
      case "spaceapp-promo":
        return (
          <SpaceAppPromoWidget
            key="spaceapp-promo"
            state={widgets["spaceapp-promo"]}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("spaceapp-promo", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("spaceapp-promo")}
            onClose={() => handleClose("spaceapp-promo")}
            onFocus={() => handleFocus("spaceapp-promo")}
          />
        );
      case "ai-quota":
        return (
          <AiQuotaWidget
            key="ai-quota"
            state={widgets["ai-quota"]}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("ai-quota", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("ai-quota")}
            onClose={() => handleClose("ai-quota")}
            onFocus={() => handleFocus("ai-quota")}
          />
        );
      case "streaming-metrics":
        return (
          <StreamingMetricsWidget
            key="streaming-metrics"
            state={widgets["streaming-metrics"]}
            isMultiColumn={isMultiColumn}
            isHeaderDockActive={isHeaderDockActive}
            onPositionChange={(x, y, docked, dockPos) => handlePositionChange("streaming-metrics", x, y, docked, dockPos)}
            onToggleMinimize={() => handleToggleMinimize("streaming-metrics")}
            onClose={() => handleClose("streaming-metrics")}
            onFocus={() => handleFocus("streaming-metrics")}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="desktop-widgets-layer" aria-label="Desktop float widgets">
      {enabledIds.map(renderWidget)}
    </div>
  );
});
