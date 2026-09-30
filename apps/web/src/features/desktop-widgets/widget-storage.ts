import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClockWidgetConfig,
  CountdownTimerWidgetConfig,
  DesktopWidgetId,
  DesktopWidgetState,
  PushupReminderWidgetConfig,
  SpaceAppPromoWidgetConfig,
  AiQuotaWidgetConfig
} from "./types.js";

const WIDGETS_STATE_KEY = "space.desktop-widgets.state.v1";
const WIDGET_CONFIG_PREFIX = "space.desktop-widgets.config.";
const WIDGETS_CHANGED_EVENT = "space:desktop-widgets:changed";

const DEFAULT_CLOCK_CONFIG: ClockWidgetConfig = {
  is24Hour: true,
  showSeconds: true
};

const DEFAULT_TIMER_CONFIG: CountdownTimerWidgetConfig = {
  durationSeconds: 25 * 60, // 25m Pomodoro default
  remainingSeconds: 25 * 60,
  isRunning: false,
  isCompleted: false
};

const DEFAULT_PUSHUP_CONFIG: PushupReminderWidgetConfig = {
  intervalMinutes: 30, // 30m default per user request
  targetReps: 20,
  totalRepsToday: 0,
  setsCompletedToday: 0,
  remainingSeconds: 30 * 60,
  isRunning: true,
  isAlertActive: false,
  lastActiveDate: new Date().toISOString().slice(0, 10)
};

const DEFAULT_PROMO_CONFIG: SpaceAppPromoWidgetConfig = {
  headline: "SpaceApp.dev it's FREE!!!",
  subheadline: "OPENSOURCE!!!",
  platformText: "FOR ALL PLATFORMS",
  url: "https://spaceapp.dev"
};

const DEFAULT_AI_QUOTA_CONFIG: AiQuotaWidgetConfig = {
  activeTab: "all",
  windowMode: "5h",
  autoRefresh: true,
  refreshIntervalSeconds: 90,
  miniCycleIntervalSeconds: 30
};

export const DOCK_WIDTH = 48;
export const DOCK_MARGIN_RIGHT = 2;
export const RAIL_TOP_OFFSET = 72;
export const DOCK_GAP = 8;

export const WIDGET_DOCK_HEIGHTS: Record<DesktopWidgetId, number> = {
  "ai-quota": 105,
  "pushup-reminder": 68,
  "clock": 52,
  "countdown-timer": 52,
  "spaceapp-promo": 52,
  "streaming-metrics": 52
};

export function getRailTopBoundary(): number {
  if (typeof document !== "undefined") {
    let maxBottom = 72;

    const healthRail = document.querySelector(".health-indicator-rail");
    if (healthRail) {
      const rect = healthRail.getBoundingClientRect();
      if (rect.bottom > 0) {
        maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom) + DOCK_GAP);
      } else {
        maxBottom = Math.max(maxBottom, 340);
      }
    }

    const healthItems = document.querySelector(".health-rail-items");
    if (healthItems) {
      const rect = healthItems.getBoundingClientRect();
      if (rect.bottom > 0) {
        maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom) + DOCK_GAP);
      }
    }

    const minBar = document.getElementById("minimized-pane-bar-toggle");
    if (minBar) {
      const rect = minBar.getBoundingClientRect();
      if (rect.bottom > 0) {
        maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom) + DOCK_GAP);
      }
    }

    const indicators = document.querySelectorAll(".health-indicator-rail button, .health-indicator, .health-rail-items > *");
    indicators.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 0) {
        maxBottom = Math.max(maxBottom, Math.ceil(rect.bottom) + DOCK_GAP);
      }
    });

    return maxBottom;
  }
  return 72;
}

export function resolveRailDockCollisions(
  states: Record<DesktopWidgetId, DesktopWidgetState>,
  activeId?: DesktopWidgetId,
  viewportW = typeof window !== "undefined" ? window.innerWidth : 1200,
  viewportH = typeof window !== "undefined" ? window.innerHeight : 800
): boolean {
  const dockX = Math.max(12, viewportW - DOCK_WIDTH - DOCK_MARGIN_RIGHT);
  const minRailTop = getRailTopBoundary();
  const maxBottom = viewportH - 12;

  const railWidgets = (Object.keys(states) as DesktopWidgetId[])
    .map((id) => ({ ...states[id], origX: states[id]?.x ?? 0 }))
    .filter((w): w is DesktopWidgetState & { origX: number } => Boolean(w && w.enabled && w.dockedToRail && w.minimized && w.dockPosition !== "header"));

  if (railWidgets.length === 0) return false;

  let changed = false;

  // 1. Sort by y coordinate. If tied, prioritize activeId, then original x coordinate (e.g. from header toolbar)
  railWidgets.sort((a, b) => {
    if (a.y === b.y) {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
      return a.origX - b.origX;
    }
    return a.y - b.y;
  });

  // 2. Clamp first/top widget to at least minRailTop
  if (railWidgets[0]!.y < minRailTop) {
    railWidgets[0]!.y = minRailTop;
    states[railWidgets[0]!.id] = { ...states[railWidgets[0]!.id]!, y: minRailTop };
    changed = true;
  }

  // 3. Forward pass: ensure no overlap from top to bottom
  for (let i = 0; i < railWidgets.length - 1; i++) {
    const current = railWidgets[i]!;
    const next = railWidgets[i + 1]!;
    const currentH = WIDGET_DOCK_HEIGHTS[current.id] ?? 52;
    const minNextY = current.y + currentH + DOCK_GAP;

    if (next.y < minNextY) {
      next.y = minNextY;
      states[next.id] = { ...states[next.id]!, y: minNextY };
      changed = true;
    }
  }

  // 4. Backward pass: if bottom widget extends past maxBottom, shift upwards
  const lastIndex = railWidgets.length - 1;
  const lastWidget = railWidgets[lastIndex]!;
  const lastH = WIDGET_DOCK_HEIGHTS[lastWidget.id] ?? 52;

  if (lastWidget.y + lastH > maxBottom) {
    lastWidget.y = Math.max(minRailTop, maxBottom - lastH);
    states[lastWidget.id] = { ...states[lastWidget.id]!, y: lastWidget.y };
    changed = true;

    for (let i = lastIndex - 1; i >= 0; i--) {
      const prev = railWidgets[i]!;
      const next = railWidgets[i + 1]!;
      const prevH = WIDGET_DOCK_HEIGHTS[prev.id] ?? 52;
      const maxPrevY = next.y - prevH - DOCK_GAP;

      if (prev.y > maxPrevY) {
        prev.y = Math.max(minRailTop, maxPrevY);
        states[prev.id] = { ...states[prev.id]!, y: prev.y };
        changed = true;
      }
    }
  }

  // 5. Ensure all rail widgets have correct dockX
  for (const w of railWidgets) {
    if (states[w.id]!.x !== dockX) {
      states[w.id] = { ...states[w.id]!, x: dockX };
      changed = true;
    }
  }

  return changed;
}

export function enforceRailDockSlots(
  states: Record<DesktopWidgetId, DesktopWidgetState>,
  viewportW = typeof window !== "undefined" ? window.innerWidth : 1200,
  viewportH = typeof window !== "undefined" ? window.innerHeight : 800
): boolean {
  return resolveRailDockCollisions(states, undefined, viewportW, viewportH);
}

export function resolveHeaderDockCollisions(
  states: Record<DesktopWidgetId, DesktopWidgetState>,
  activeId?: DesktopWidgetId
): boolean {
  const headerWidgets = (Object.keys(states) as DesktopWidgetId[])
    .map((id) => ({ ...states[id] }))
    .filter((w): w is DesktopWidgetState => Boolean(w && w.enabled && w.dockedToRail && w.minimized));

  if (headerWidgets.length <= 1) return false;

  let changed = false;

  // Sort by x coordinate
  headerWidgets.sort((a, b) => {
    if (a.x === b.x) {
      if (a.id === activeId) return -1;
      if (b.id === activeId) return 1;
    }
    return a.x - b.x;
  });

  // Assign clean sequential slots for x: 100, 200, 300...
  for (let i = 0; i < headerWidgets.length; i++) {
    const w = headerWidgets[i]!;
    const slotX = (i + 1) * 100;
    if (w.x !== slotX) {
      states[w.id] = { ...states[w.id]!, x: slotX };
      changed = true;
    }
  }

  return changed;
}

function getDefaultPositions(): Record<DesktopWidgetId, { x: number; y: number }> {
  const w = typeof window !== "undefined" ? window.innerWidth : 1200;
  return {
    clock: { x: Math.max(20, w - 280), y: 60 },
    "ai-quota": { x: Math.max(20, w - 460), y: 60 },
    "countdown-timer": { x: Math.max(20, w - 280), y: 260 },
    "pushup-reminder": { x: Math.max(20, w - 460), y: 380 },
    "spaceapp-promo": { x: Math.max(20, w - 320), y: 520 },
    "streaming-metrics": { x: Math.max(20, w - 460), y: 240 }
  };
}

export function loadWidgetStates(): Record<DesktopWidgetId, DesktopWidgetState> {
  const defaults = getDefaultPositions();
  const initial: Record<DesktopWidgetId, DesktopWidgetState> = {
    clock: { id: "clock", enabled: false, x: defaults.clock.x, y: defaults.clock.y, zIndex: 120 },
    "countdown-timer": { id: "countdown-timer", enabled: false, x: defaults["countdown-timer"].x, y: defaults["countdown-timer"].y, zIndex: 121 },
    "pushup-reminder": { id: "pushup-reminder", enabled: false, x: defaults["pushup-reminder"].x, y: defaults["pushup-reminder"].y, zIndex: 122 },
    "spaceapp-promo": { id: "spaceapp-promo", enabled: false, x: defaults["spaceapp-promo"].x, y: defaults["spaceapp-promo"].y, zIndex: 123 },
    "ai-quota": { id: "ai-quota", enabled: false, x: defaults["ai-quota"].x, y: defaults["ai-quota"].y, zIndex: 124 },
    "streaming-metrics": { id: "streaming-metrics", enabled: false, x: defaults["streaming-metrics"].x, y: defaults["streaming-metrics"].y, zIndex: 125 }
  };

  try {
    if (typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(WIDGETS_STATE_KEY);
    if (!raw) return initial;
    const parsed = JSON.parse(raw) as Partial<Record<DesktopWidgetId, DesktopWidgetState>>;
    const result: Record<DesktopWidgetId, DesktopWidgetState> = {
      clock: { ...initial.clock, ...parsed.clock },
      "countdown-timer": { ...initial["countdown-timer"], ...parsed["countdown-timer"] },
      "pushup-reminder": { ...initial["pushup-reminder"], ...parsed["pushup-reminder"] },
      "spaceapp-promo": { ...initial["spaceapp-promo"], ...parsed["spaceapp-promo"] },
      "ai-quota": { ...initial["ai-quota"], ...parsed["ai-quota"] },
      "streaming-metrics": { ...initial["streaming-metrics"], ...parsed["streaming-metrics"] }
    };
    if (typeof window !== "undefined") {
      const maxX = Math.max(16, window.innerWidth - 180);
      const maxY = Math.max(48, window.innerHeight - 100);
      for (const key of Object.keys(result) as DesktopWidgetId[]) {
        const item = result[key];
        if (item.enabled && !item.dockedToRail) {
          item.x = Math.min(Math.max(16, item.x), maxX);
          item.y = Math.min(Math.max(48, item.y), maxY);
        }
      }
      enforceRailDockSlots(result, window.innerWidth, window.innerHeight);
    }
    return result;
  } catch {
    return initial;
  }
}

export function saveWidgetStates(states: Record<DesktopWidgetId, DesktopWidgetState>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WIDGETS_STATE_KEY, JSON.stringify(states));
    window.dispatchEvent(new CustomEvent(WIDGETS_CHANGED_EVENT, { detail: states }));
  } catch {
    // Storage unavailable
  }
}

export function toggleDesktopWidget(id: DesktopWidgetId, forced?: boolean): void {
  const currentStates = loadWidgetStates();
  const current = currentStates[id];
  if (!current) return;
  const targetEnabled = forced !== undefined ? forced : !current.enabled;
  let { x, y } = current;
  if (targetEnabled && typeof window !== "undefined") {
    x = Math.min(Math.max(16, x), window.innerWidth - 180);
    y = Math.min(Math.max(48, y), window.innerHeight - 120);
  }
  const maxZ = Object.values(currentStates).reduce((max, w) => Math.max(max, w.zIndex ?? 120), 120);
  const next: Record<DesktopWidgetId, DesktopWidgetState> = {
    ...currentStates,
    [id]: {
      ...current,
      enabled: targetEnabled,
      x,
      y,
      zIndex: targetEnabled ? maxZ + 1 : current.zIndex
    }
  };
  if (targetEnabled && current.dockedToRail && current.minimized) {
    enforceRailDockSlots(next);
  }
  saveWidgetStates(next);
}

export function loadWidgetConfig<T>(id: DesktopWidgetId, defaults: T): T {
  try {
    if (typeof localStorage === "undefined") return defaults;
    const raw = localStorage.getItem(`${WIDGET_CONFIG_PREFIX}${id}`);
    if (!raw) return defaults;
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function saveWidgetConfig<T>(id: DesktopWidgetId, config: T): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(`${WIDGET_CONFIG_PREFIX}${id}`, JSON.stringify(config));
  } catch {
    // Storage unavailable
  }
}

export { DEFAULT_CLOCK_CONFIG, DEFAULT_TIMER_CONFIG, DEFAULT_PUSHUP_CONFIG, DEFAULT_PROMO_CONFIG, DEFAULT_AI_QUOTA_CONFIG };

export function areWidgetStatesEqual(
  a: Record<DesktopWidgetId, DesktopWidgetState> | null | undefined,
  b: Record<DesktopWidgetId, DesktopWidgetState> | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a) as DesktopWidgetId[];
  const keysB = Object.keys(b) as DesktopWidgetId[];
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const sA = a[k];
    const sB = b[k];
    if (!sA || !sB) return false;
    if (
      sA.id !== sB.id ||
      sA.enabled !== sB.enabled ||
      sA.x !== sB.x ||
      sA.y !== sB.y ||
      sA.zIndex !== sB.zIndex ||
      sA.minimized !== sB.minimized ||
      sA.dockedToRail !== sB.dockedToRail ||
      sA.dockPosition !== sB.dockPosition
    ) {
      return false;
    }
  }
  return true;
}

export function useDesktopWidgets() {
  const [widgets, setWidgets] = useState<Record<DesktopWidgetId, DesktopWidgetState>>(() => loadWidgetStates());
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const isInternalUpdateRef = useRef(false);

  useEffect(() => {
    const handler = (e: Event) => {
      if (isInternalUpdateRef.current) return;
      const customEvent = e as CustomEvent<Record<DesktopWidgetId, DesktopWidgetState>>;
      const nextStates = customEvent.detail ?? loadWidgetStates();
      if (!areWidgetStatesEqual(widgetsRef.current, nextStates)) {
        setWidgets(nextStates);
      }
    };
    window.addEventListener(WIDGETS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(WIDGETS_CHANGED_EVENT, handler);
  }, []);

  useEffect(() => {
    let resizeTimer: number | null = null;
    const handleResize = () => {
      if (typeof window === "undefined") return;
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        setWidgets((prev) => {
          let changed = false;
          const next = { ...prev };
          const maxX = Math.max(16, window.innerWidth - 180);
          const maxY = Math.max(48, window.innerHeight - 100);
          for (const key of Object.keys(next) as DesktopWidgetId[]) {
            const w = next[key];
            if (w.enabled && !w.dockedToRail) {
              if (w.x > maxX || w.y > maxY || w.x < 12 || w.y < 48) {
                const clampedX = Math.min(Math.max(16, w.x), maxX);
                const clampedY = Math.min(Math.max(48, w.y), maxY);
                if (clampedX !== w.x || clampedY !== w.y) {
                  next[key] = { ...w, x: clampedX, y: clampedY };
                  changed = true;
                }
              }
            }
          }
          if (enforceRailDockSlots(next, window.innerWidth, window.innerHeight)) {
            changed = true;
          }
          if (changed) {
            try {
              isInternalUpdateRef.current = true;
              saveWidgetStates(next);
            } finally {
              isInternalUpdateRef.current = false;
            }
            return next;
          }
          return prev;
        });
      }, 100);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const isWidgetEnabled = useCallback(
    (id: DesktopWidgetId): boolean => Boolean(widgets[id]?.enabled),
    [widgets]
  );

  const toggleWidget = useCallback((id: DesktopWidgetId, forced?: boolean) => {
    setWidgets((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const targetEnabled = forced !== undefined ? forced : !current.enabled;

      // When enabling, bring to front and ensure within viewport (only if floating)
      let { x, y } = current;
      if (targetEnabled && !current.dockedToRail && typeof window !== "undefined") {
        x = Math.min(Math.max(16, x), window.innerWidth - 180);
        y = Math.min(Math.max(48, y), window.innerHeight - 120);
      }

      const maxZ = Object.values(prev).reduce((max, w) => Math.max(max, w.zIndex ?? 120), 120);
      const next: Record<DesktopWidgetId, DesktopWidgetState> = {
        ...prev,
        [id]: {
          ...current,
          enabled: targetEnabled,
          x,
          y,
          zIndex: targetEnabled ? maxZ + 1 : current.zIndex
        }
      };
      if (targetEnabled && current.dockedToRail && current.minimized) {
        if (current.dockPosition === "header") {
          resolveHeaderDockCollisions(next, id);
        } else {
          resolveRailDockCollisions(next, id);
        }
      }
      if (areWidgetStatesEqual(prev, next)) return prev;
      try {
        isInternalUpdateRef.current = true;
        saveWidgetStates(next);
      } finally {
        isInternalUpdateRef.current = false;
      }
      return next;
    });
  }, []);

  const setPosition = useCallback((id: DesktopWidgetId, x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => {
    setWidgets((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const targetDocked = dockedToRail !== undefined ? dockedToRail : current.dockedToRail;
      const targetDockPos = targetDocked ? (dockPosition ?? current.dockPosition ?? "rail") : undefined;
      if (current.x === x && current.y === y && Boolean(current.dockedToRail) === Boolean(targetDocked) && current.dockPosition === targetDockPos) return prev;
      const next: Record<DesktopWidgetId, DesktopWidgetState> = {
        ...prev,
        [id]: {
          ...current,
          x,
          y,
          dockedToRail: targetDocked,
          dockPosition: targetDockPos
        }
      };
      if (targetDocked && current.minimized) {
        if (targetDockPos === "header") {
          resolveHeaderDockCollisions(next, id);
        } else {
          resolveRailDockCollisions(next, id);
        }
      } else if (!targetDocked) {
        for (const key of Object.keys(next) as DesktopWidgetId[]) {
          if (key !== id && next[key].enabled && !next[key].dockedToRail) {
            if (Math.abs(next[id].x - next[key].x) < 80 && Math.abs(next[id].y - next[key].y) < 40) {
              const viewW = typeof window !== "undefined" ? window.innerWidth : 1200;
              const viewH = typeof window !== "undefined" ? window.innerHeight : 800;
              next[id].x = Math.min(Math.max(12, viewW - 280 - 12), next[id].x + 32);
              next[id].y = Math.min(Math.max(48, viewH - 160 - 12), next[id].y + 32);
            }
          }
        }
      }
      if (areWidgetStatesEqual(prev, next)) return prev;
      try {
        isInternalUpdateRef.current = true;
        saveWidgetStates(next);
      } finally {
        isInternalUpdateRef.current = false;
      }
      return next;
    });
  }, []);

  const toggleMinimize = useCallback((id: DesktopWidgetId) => {
    setWidgets((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const nextMinimized = !current.minimized;
      const next: Record<DesktopWidgetId, DesktopWidgetState> = {
        ...prev,
        [id]: { ...current, minimized: nextMinimized }
      };
      if (current.dockedToRail && nextMinimized) {
        if (current.dockPosition === "header") {
          resolveHeaderDockCollisions(next, id);
        } else {
          resolveRailDockCollisions(next, id);
        }
      }
      if (areWidgetStatesEqual(prev, next)) return prev;
      try {
        isInternalUpdateRef.current = true;
        saveWidgetStates(next);
      } finally {
        isInternalUpdateRef.current = false;
      }
      return next;
    });
  }, []);

  const bringToFront = useCallback((id: DesktopWidgetId) => {
    setWidgets((prev) => {
      const current = prev[id];
      if (!current) return prev;
      const maxZ = Object.values(prev).reduce((max, w) => Math.max(max, w.zIndex ?? 120), 120);
      if (current.zIndex === maxZ) return prev;
      const next = {
        ...prev,
        [id]: { ...current, zIndex: maxZ + 1 }
      };
      if (areWidgetStatesEqual(prev, next)) return prev;
      try {
        isInternalUpdateRef.current = true;
        saveWidgetStates(next);
      } finally {
        isInternalUpdateRef.current = false;
      }
      return next;
    });
  }, []);

  const closeWidget = useCallback((id: DesktopWidgetId) => {
    toggleWidget(id, false);
  }, [toggleWidget]);

  const enforceRailSlots = useCallback(() => {
    const applySlots = () => {
      setWidgets((prev) => {
        const next: Record<DesktopWidgetId, DesktopWidgetState> = { ...prev };
        let hasDocked = false;
        for (const id of Object.keys(next) as DesktopWidgetId[]) {
          if (next[id]?.dockedToRail && next[id]?.minimized) {
            next[id] = { ...next[id]!, dockPosition: "rail" };
            hasDocked = true;
          }
        }
        if (!hasDocked) return prev;
        resolveRailDockCollisions(next);
        if (areWidgetStatesEqual(prev, next)) return prev;
        try {
          isInternalUpdateRef.current = true;
          saveWidgetStates(next);
        } finally {
          isInternalUpdateRef.current = false;
        }
        return next;
      });
    };

    applySlots();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(applySlots);
      window.setTimeout(applySlots, 60);
      window.setTimeout(applySlots, 200);
    }
  }, []);

  const enforceHeaderSlots = useCallback(() => {
    const applySlots = () => {
      setWidgets((prev) => {
        const next: Record<DesktopWidgetId, DesktopWidgetState> = { ...prev };
        let hasDocked = false;
        for (const id of Object.keys(next) as DesktopWidgetId[]) {
          if (next[id]?.dockedToRail && next[id]?.minimized) {
            next[id] = { ...next[id]!, dockPosition: "header", y: 8 };
            hasDocked = true;
          }
        }
        if (!hasDocked) return prev;
        resolveHeaderDockCollisions(next);
        if (areWidgetStatesEqual(prev, next)) return prev;
        try {
          isInternalUpdateRef.current = true;
          saveWidgetStates(next);
        } finally {
          isInternalUpdateRef.current = false;
        }
        return next;
      });
    };

    applySlots();
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(applySlots);
    }
  }, []);

  // Keep unrelated App updates out of the widget layout/effect tree.
  return useMemo(() => ({
    widgets,
    isWidgetEnabled,
    toggleWidget,
    setPosition,
    toggleMinimize,
    bringToFront,
    closeWidget,
    enforceRailSlots,
    enforceHeaderSlots
  }), [widgets, isWidgetEnabled, toggleWidget, setPosition, toggleMinimize, bringToFront, closeWidget, enforceRailSlots, enforceHeaderSlots]);
}
