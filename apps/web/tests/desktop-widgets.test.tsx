import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { playChime } from "../src/features/desktop-widgets/audio-chime.js";

vi.mock("../src/features/desktop-widgets/audio-chime.js", () => ({
  playChime: vi.fn(),
  getAudioContext: vi.fn()
}));
import {
  ClockWidget,
  CountdownTimerWidget,
  PushupReminderWidget,
  SpaceAppPromoWidget,
  AiQuotaWidget,
  computeQuotaAggregates,
  DEFAULT_PUSHUP_CONFIG,
  loadAiQuotaWidgetConfig,
  loadWidgetConfig,
  loadWidgetStates,
  saveWidgetConfig,
  saveWidgetStates,
  toggleDesktopWidget,
  normalizeWidgetStates,
  enforceRailDockSlots,
  resolveRailDockCollisions,
  resolveHeaderDockCollisions,
  getRailTopBoundary,
  getFloatingTopBoundary,
  WIDGET_DOCK_HEIGHTS,
  DOCK_GAP,
  RAIL_TOP_OFFSET,
  areWidgetStatesEqual,
  DesktopWidgetsLayer,
  loadSnipRailDock,
  saveSnipRailDock,
  SNIP_RAIL_HEIGHT
} from "../src/features/desktop-widgets/index.js";
import { DesktopWidgetContainer } from "../src/features/desktop-widgets/DesktopWidgetContainer.js";
import { preloadDesktopWidgets } from "../src/features/desktop-widgets/DesktopWidgetsLayer.js";
import { calculateRailDodgeShift } from "../src/features/rail-popover.js";
import {
  workspaceActionCategory,
  workspaceActionLabel,
  workspaceActionToggle
} from "../src/features/ui-theme/workspace-actions.js";
import type { IconToolbarAction } from "../src/icon-toolbar.js";

describe("Desktop Float Widgets", () => {
  beforeAll(() => preloadDesktopWidgets());

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe("Widget Storage & Actions", () => {
    it("loads default widget states with all widgets disabled", () => {
      const states = loadWidgetStates();
      expect(states.clock.enabled).toBe(false);
      expect(states["countdown-timer"].enabled).toBe(false);
      expect(states["pushup-reminder"].enabled).toBe(false);
      expect(states.clock.x).toBeGreaterThan(0);
      expect(states.clock.y).toBeGreaterThan(0);
    });

    it("persists widget states to localStorage", () => {
      const states = loadWidgetStates();
      states.clock.enabled = true;
      states.clock.x = 250;
      states.clock.y = 150;
      saveWidgetStates(states);

      const reloaded = loadWidgetStates();
      expect(reloaded.clock.enabled).toBe(true);
      expect(reloaded.clock.x).toBe(250);
      expect(reloaded.clock.y).toBe(150);
    });

    it("saves and loads widget configurations", () => {
      const testConfig = { is24Hour: false, showSeconds: false };
      saveWidgetConfig("clock", testConfig);
      const loaded = loadWidgetConfig("clock", { is24Hour: true, showSeconds: true });
      expect(loaded.is24Hour).toBe(false);
      expect(loaded.showSeconds).toBe(false);
    });

    it("maps widget action IDs to widgets category and labels", () => {
      expect(workspaceActionCategory("widget-clock")).toBe("widgets");
      expect(workspaceActionCategory("widget-countdown-timer")).toBe("widgets");
      expect(workspaceActionCategory("widget-pushup-reminder")).toBe("widgets");

      const clockAction = { id: "widget-clock", label: "Clock widget" } as IconToolbarAction;
      const timerAction = { id: "widget-countdown-timer", label: "Countdown timer" } as IconToolbarAction;
      const pushupAction = { id: "widget-pushup-reminder", label: "Push-up reminder" } as IconToolbarAction;

      expect(workspaceActionLabel(clockAction)).toBe("Clock widget");
      expect(workspaceActionLabel(timerAction)).toBe("Countdown timer");
      expect(workspaceActionLabel(pushupAction)).toBe("Push-up reminder");

      expect(workspaceActionToggle({ ...clockAction, ariaPressed: true })).toBe(true);
      expect(workspaceActionToggle({ ...clockAction, ariaPressed: false })).toBe(false);
    });

    it("clamps loaded widget positions to fit inside viewport", () => {
      const states = loadWidgetStates();
      states["ai-quota"].enabled = true;
      states["ai-quota"].x = 4000;
      states["ai-quota"].y = 3000;
      saveWidgetStates(states);

      const reloaded = loadWidgetStates();
      expect(reloaded["ai-quota"].x).toBeLessThanOrEqual(window.innerWidth - 180);
      expect(reloaded["ai-quota"].y).toBeLessThanOrEqual(window.innerHeight - 100);
    });
  });

  describe("ClockWidget Component", () => {
    it("renders clock widget with time digits, colon, and date", () => {
      const state = {
        id: "clock" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <ClockWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      expect(screen.getByText("Clock")).toBeTruthy();
      expect(screen.getByText("24H")).toBeTruthy();
      expect(screen.getByText("SEC")).toBeTruthy();
    });

    it("toggles 24H and 12H format upon button click", () => {
      const state = {
        id: "clock" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <ClockWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const formatBtn = screen.getByText("24H");
      fireEvent.click(formatBtn);
      expect(screen.getByText("12H")).toBeTruthy();
    });

    it("triggers onClose and onToggleMinimize handlers", () => {
      const onClose = vi.fn();
      const onToggleMinimize = vi.fn();
      const state = {
        id: "clock" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <ClockWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={onToggleMinimize}
          onClose={onClose}
          onFocus={vi.fn()}
        />
      );

      const closeBtn = screen.getByLabelText("Close Clock");
      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalledOnce();

      const minimizeBtn = screen.getByLabelText("Minimize Clock");
      fireEvent.click(minimizeBtn);
      expect(onToggleMinimize).toHaveBeenCalledOnce();
    });
  });

  describe("CountdownTimerWidget Component", () => {
    it("renders countdown timer with preset buttons and start/reset controls", () => {
      const state = {
        id: "countdown-timer" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <CountdownTimerWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      expect(screen.getByText("Countdown Timer")).toBeTruthy();
      expect(screen.getByText("1m")).toBeTruthy();
      expect(screen.getByText("5m")).toBeTruthy();
      expect(screen.getByText("15m")).toBeTruthy();
      expect(screen.getByText("25m")).toBeTruthy();
      expect(screen.getByText("45m")).toBeTruthy();
      expect(screen.getByLabelText("Start timer")).toBeTruthy();
    });

    it("changes duration when selecting a preset", () => {
      const state = {
        id: "countdown-timer" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <CountdownTimerWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const preset5m = screen.getByText("5m");
      fireEvent.click(preset5m);
      expect(screen.getByText("05:00")).toBeTruthy();
    });

    it("toggles play/pause state when clicked", () => {
      const state = {
        id: "countdown-timer" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <CountdownTimerWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const startBtn = screen.getByLabelText("Start timer");
      fireEvent.click(startBtn);
      expect(screen.getByLabelText("Pause timer")).toBeTruthy();
    });
  });

  describe("PushupReminderWidget Component", () => {
    it("renders push-up reminder with interval options and rep tally", () => {
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      expect(screen.getByText("Push-up Reminder")).toBeTruthy();
      expect(screen.getByText("Next set in")).toBeTruthy();
      expect(screen.getByText("Today")).toBeTruthy();
      expect(screen.getByText("30m")).toBeTruthy();
      expect(screen.getByText("20 reps")).toBeTruthy();
    });

    it("logs a completed set and increments today's tally", () => {
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const logBtn = screen.getByText(/Log Set \(\+20\)/);
      fireEvent.click(logBtn);

      expect(screen.getByText("20")).toBeTruthy();
      expect(screen.getByText(/reps \(1 sets\)/)).toBeTruthy();
    });

    it("adjusts interval setting when clicking interval pill", () => {
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const interval15Btn = screen.getByText("15m");
      fireEvent.click(interval15Btn);

      expect(screen.getByText("15:00")).toBeTruthy();
    });

    it("rings alert chime for 5 seconds when countdown reaches 0 and then stops", () => {
      vi.useFakeTimers();
      try {
        saveWidgetConfig("pushup-reminder", {
          ...DEFAULT_PUSHUP_CONFIG,
          remainingSeconds: 2,
          isRunning: true,
          isAlertActive: false
        });

        const state = {
          id: "pushup-reminder" as const,
          enabled: true,
          x: 100,
          y: 80
        };

        render(
          <PushupReminderWidget
            state={state}
            onPositionChange={vi.fn()}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        expect(vi.mocked(playChime)).not.toHaveBeenCalledWith("pushup-alert");

        // Advance 2 seconds to trigger alert (countdown reaches 0)
        act(() => {
          vi.advanceTimersByTime(2000);
        });

        // 1st chime played immediately on alert trigger
        expect(vi.mocked(playChime)).toHaveBeenCalledWith("pushup-alert");
        const alertCallCountAtStart = vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length;
        expect(alertCallCountAtStart).toBe(1);

        // Advance 4 more seconds (total 5 rings: t=0, 1, 2, 3, 4s)
        act(() => {
          vi.advanceTimersByTime(4000);
        });
        const alertCallCountAt5s = vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length;
        expect(alertCallCountAt5s).toBe(5);

        // Advance further (another 10 seconds) - must NOT keep ringing indefinitely!
        act(() => {
          vi.advanceTimersByTime(10000);
        });
        const alertCallCountLater = vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length;
        expect(alertCallCountLater).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops alert ringing immediately when user logs completed set", () => {
      vi.useFakeTimers();
      try {
        saveWidgetConfig("pushup-reminder", {
          ...DEFAULT_PUSHUP_CONFIG,
          remainingSeconds: 1,
          isRunning: true,
          isAlertActive: false
        });

        const state = {
          id: "pushup-reminder" as const,
          enabled: true,
          x: 100,
          y: 80
        };

        render(
          <PushupReminderWidget
            state={state}
            onPositionChange={vi.fn()}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        act(() => {
          vi.advanceTimersByTime(1000);
        });

        // Chime #1 fired
        expect(vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length).toBe(1);

        // Advance 1 second: chime #2 fired
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        expect(vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length).toBe(2);

        // User clicks completed to dismiss early
        const doneBtn = screen.getByText(/Completed \(\+20\)/);
        fireEvent.click(doneBtn);

        // Advance several seconds - ringing stopped immediately, no further pushup-alert calls
        act(() => {
          vi.advanceTimersByTime(10000);
        });
        expect(vi.mocked(playChime).mock.calls.filter(c => c[0] === "pushup-alert").length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("SpaceAppPromoWidget Component", () => {
    it("renders promo widget with headline, subheadline, and platforms", () => {
      const state = {
        id: "spaceapp-promo" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <SpaceAppPromoWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      expect(screen.getByText("SpaceApp.dev it's FREE!!!")).toBeTruthy();
      expect(screen.getByText("OPEN SOURCE")).toBeTruthy();
      expect(screen.getByText("FOR ALL PLATFORMS")).toBeTruthy();
      expect(screen.getByText("Linux")).toBeTruthy();
      expect(screen.getByText("macOS")).toBeTruthy();
      expect(screen.getByText("Windows")).toBeTruthy();
      expect(screen.getByText("Web")).toBeTruthy();
      expect(screen.getByRole("link", { name: /spaceapp\.dev/ })).toBeTruthy();
      expect(screen.queryByText(/v0\.1\.0/)).toBeNull();
      expect(screen.queryByText(/Copy/)).toBeNull();
    });

    it("triggers onClose when close button is clicked", () => {
      const onClose = vi.fn();
      const state = {
        id: "spaceapp-promo" as const,
        enabled: true,
        x: 100,
        y: 80,
        zIndex: 120
      };

      render(
        <SpaceAppPromoWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={onClose}
          onFocus={vi.fn()}
        />
      );

      const closeBtn = screen.getByLabelText("Close SpaceApp.dev");
      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe("Top-bar and Rail Menu Dodge", () => {
    it("dodges when .health-resources drawer overlaps widget", () => {
      const drawer = document.createElement("aside");
      drawer.className = "health-resources";
      drawer.getBoundingClientRect = () => ({
        left: 700,
        right: 1140,
        top: 12,
        bottom: 780,
        width: 440,
        height: 768,
        x: 700,
        y: 12,
        toJSON: () => {}
      });
      document.body.appendChild(drawer);

      try {
        const shift = calculateRailDodgeShift({ left: 800, top: 100, width: 300, height: 200 });
        expect(shift).toBe(412);
      } finally {
        drawer.remove();
      }
    });

    it("dodges when .resources-drawer overlaps widget", () => {
      const drawer = document.createElement("aside");
      drawer.className = "resources-drawer";
      drawer.getBoundingClientRect = () => ({
        left: 750,
        right: 1160,
        top: 60,
        bottom: 750,
        width: 410,
        height: 690,
        x: 750,
        y: 60,
        toJSON: () => {}
      });
      document.body.appendChild(drawer);

      try {
        const shift = calculateRailDodgeShift({ left: 800, top: 100, width: 300, height: 200 });
        expect(shift).toBe(362);
      } finally {
        drawer.remove();
      }
    });

    it("dodges when .toolbar-metric-panel overlaps widget", () => {
      const panel = document.createElement("div");
      panel.className = "toolbar-metric-panel";
      panel.getBoundingClientRect = () => ({
        left: 800,
        right: 1150,
        top: 60,
        bottom: 300,
        width: 350,
        height: 240,
        x: 800,
        y: 60,
        toJSON: () => {}
      });
      document.body.appendChild(panel);

      try {
        const shift = calculateRailDodgeShift({ left: 850, top: 100, width: 250, height: 150 });
        expect(shift).toBe(312);
      } finally {
        panel.remove();
      }
    });

    it("returns 0 shift when no menus overlap", () => {
      const shift = calculateRailDodgeShift({ left: 100, top: 100, width: 250, height: 150 });
      expect(shift).toBe(0);
    });
  });

  describe("Viewport Clamping", () => {
    it("clamps widget within viewport bounds on render", () => {
      const onPositionChange = vi.fn();
      const view = render(
        <DesktopWidgetContainer
          id="clock"
          title="Clock"
          icon={null}
          x={window.innerWidth + 500}
          y={window.innerHeight + 500}
          onPositionChange={onPositionChange}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
        >
          <div>Clock content</div>
        </DesktopWidgetContainer>
      );

      const aside = view.container.querySelector("aside")!;
      expect(aside).toBeTruthy();
      expect(aside.style.transform).toContain("translate3d");
      expect(onPositionChange).toHaveBeenCalled();
    });
  });

  describe("Right Rail Docking, No Icons, and Alert Dismissal", () => {
    it("renders Push-up without Reminder in mini mode", () => {
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 200,
        y: 100,
        minimized: true
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      // Mini mode title must be Push-up, not Push-up Reminder
      expect(screen.getByText("Push-up")).toBeTruthy();
      expect(screen.queryByText("Push-up Reminder")).toBeNull();
      // Icons are present in desktop mini mode
      expect(container.querySelector(".desktop-widget-drag-handle")).toBeTruthy();
      expect(container.querySelector(".desktop-widget-icon")).toBeTruthy();
    });

    it("renders on right rail with zero icons and wrapped lines", () => {
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: window.innerWidth - 61,
        y: 120,
        minimized: true,
        dockedToRail: true
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const aside = container.querySelector("aside")!;
      expect(aside.classList.contains("is-rail-docked")).toBe(true);

      // Strictly ZERO icons when docked to rail
      expect(container.querySelector(".desktop-widget-drag-handle")).toBeNull();
      expect(container.querySelector(".desktop-widget-icon")).toBeNull();
      expect(container.querySelector(".desktop-widget-header-actions")).toBeNull();

      // Wrapped lines information
      expect(container.querySelector(".widget-docked-rail-body")).toBeTruthy();
      expect(container.querySelector(".widget-docked-title")?.textContent).toBe("Push-up");
      expect(container.querySelector(".widget-docked-countdown")).toBeTruthy();
    });

    it("stops alert with one click when docked to rail", () => {
      const onPositionChange = vi.fn();
      saveWidgetConfig("pushup-reminder", {
        intervalMinutes: 30,
        targetReps: 15,
        totalRepsToday: 0,
        setsCompletedToday: 0,
        remainingSeconds: 0,
        isRunning: true,
        isAlertActive: true,
        lastActiveDate: new Date().toISOString().slice(0, 10)
      });

      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: window.innerWidth - 61,
        y: 150,
        minimized: true,
        dockedToRail: true
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={onPositionChange}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      expect(container.querySelector(".widget-docked-alert-tag")?.textContent).toBe("ALERT!");
      const stopBtn = container.querySelector(".widget-docked-alert-action")!;
      expect(stopBtn).toBeTruthy();

      // 1-click stops the notification and logs the set (+15 reps)
      fireEvent.click(stopBtn);

      const reloadedConfig = loadWidgetConfig("pushup-reminder", DEFAULT_PUSHUP_CONFIG);
      expect(reloadedConfig.isAlertActive).toBe(false);
      expect(reloadedConfig.totalRepsToday).toBe(15);
      expect(reloadedConfig.setsCompletedToday).toBe(1);
    });

    it("renders clock on right rail with zero icons and wrapped lines", () => {
      const state = {
        id: "clock" as const,
        enabled: true,
        x: window.innerWidth - 61,
        y: 200,
        minimized: true,
        dockedToRail: true
      };

      const { container } = render(
        <ClockWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const aside = container.querySelector("aside")!;
      expect(aside.classList.contains("is-rail-docked")).toBe(true);
      expect(container.querySelector(".desktop-widget-drag-handle")).toBeNull();
      expect(container.querySelector(".desktop-widget-icon")).toBeNull();
      expect(container.querySelector(".widget-docked-title")?.textContent).toBe("Clock");
      expect(container.querySelector(".widget-docked-countdown")).toBeTruthy();
    });

    it("docks to right rail when dragging a large (un-minimized) widget towards the right rail", () => {
      const onPositionChange = vi.fn();
      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 500,
        y: 200,
        minimized: false
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={onPositionChange}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const header = container.querySelector(".desktop-widget-header")!;
      expect(header).toBeTruthy();

      // Drag large widget towards the right rail
      fireEvent.pointerDown(header, { clientX: 520, clientY: 210, button: 0 });
      fireEvent.pointerMove(window, { clientX: window.innerWidth - 50, clientY: 220 });
      fireEvent.pointerUp(window, { clientX: window.innerWidth - 50, clientY: 220 });

      // Must dock to rail!
      expect(onPositionChange).toHaveBeenCalledWith(expect.any(Number), 210, true, "rail");
    });

    it("renders visual ringing bell and Stop Alert button on expanded push-up widget when alert is active", () => {
      saveWidgetConfig("pushup-reminder", {
        ...DEFAULT_PUSHUP_CONFIG,
        remainingSeconds: 0,
        isRunning: true,
        isAlertActive: true
      });

      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 300,
        y: 200,
        minimized: false
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      // Visual alert indicator on timer and ringing bell in banner
      expect(container.querySelector(".widget-pushup-time.is-alert")).toBeTruthy();
      expect(container.querySelector(".widget-pushup-time.is-alert")?.textContent).toContain("ALERT!");
      expect(container.querySelector(".widget-timer-bell-icon")).toBeTruthy();

      // Ringing bell in banner header
      expect(container.querySelector(".widget-banner-icon.is-ringing")).toBeTruthy();

      // Dedicated Stop Alert button in banner
      const stopAlertBtn = container.querySelector(".widget-secondary-btn.is-stop-alert")!;
      expect(stopAlertBtn).toBeTruthy();
      expect(stopAlertBtn.textContent).toContain("Stop Alert");

      // Dedicated Stop button in header
      const headerStopBtn = container.querySelector(".desktop-widget-btn-action.is-alert-stop-btn")!;
      expect(headerStopBtn).toBeTruthy();

      // Clicking Stop Alert in banner dismisses alert without logging reps
      fireEvent.click(stopAlertBtn);
      const reloadedConfig = loadWidgetConfig("pushup-reminder", DEFAULT_PUSHUP_CONFIG);
      expect(reloadedConfig.isAlertActive).toBe(false);
      expect(reloadedConfig.totalRepsToday).toBe(0); // Reps NOT added!
      expect(reloadedConfig.remainingSeconds).toBe(reloadedConfig.intervalMinutes * 60);
    });

    it("mutes alert chime sound when chime sound is toggled off", () => {
      vi.useFakeTimers();
      try {
        saveWidgetConfig("pushup-reminder", {
          ...DEFAULT_PUSHUP_CONFIG,
          remainingSeconds: 2,
          isRunning: true,
          isAlertActive: false,
          soundEnabled: false // Chime muted
        });

        const state = {
          id: "pushup-reminder" as const,
          enabled: true,
          x: 300,
          y: 200,
          minimized: false
        };

        render(
          <PushupReminderWidget
            state={state}
            onPositionChange={vi.fn()}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        // Advance timers to trigger alert
        act(() => {
          vi.advanceTimersByTime(2000);
        });

        // Chime must NOT be played because sound is muted!
        expect(vi.mocked(playChime)).not.toHaveBeenCalledWith("pushup-alert");
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders Time's up! without repeating Push-ups twice in minimized alert mode and renders full Stop button", () => {
      saveWidgetConfig("pushup-reminder", {
        ...DEFAULT_PUSHUP_CONFIG,
        remainingSeconds: 0,
        isRunning: true,
        isAlertActive: true
      });

      const state = {
        id: "pushup-reminder" as const,
        enabled: true,
        x: 200,
        y: 0,
        minimized: true
      };

      const { container } = render(
        <PushupReminderWidget
          state={state}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      // Title must be Push-up
      const titleEl = container.querySelector(".desktop-widget-title");
      expect(titleEl?.textContent).toBe("Push-up");

      // Minimized summary must be Time's up!, not repeating Push-ups!
      const miniSummary = container.querySelector(".widget-pushup-mini.is-alert");
      expect(miniSummary?.textContent).toBe("Time's up!");
      expect(container.textContent).not.toContain("Push-ups!");

      // Stop button must be present in header controls with full text
      const stopBtn = container.querySelector(".desktop-widget-btn-action.is-alert-stop-btn");
      expect(stopBtn).toBeTruthy();
      expect(stopBtn?.textContent).toContain("Stop");
    });

    it("allows floating widgets to be positioned at y=0 flush to the top edge when no topbar is present", () => {
      const states = loadWidgetStates();
      states["pushup-reminder"] = {
        ...states["pushup-reminder"],
        enabled: true,
        minimized: true,
        dockedToRail: false,
        x: 100,
        y: 0
      };

      const normalized = normalizeWidgetStates(states);
      // When no topbar exists, y can reach 0 flush to viewport top
      expect(normalized["pushup-reminder"].y).toBe(0);
    });

    it("clamps floating widgets to below the topbar when desktop-window-titlebar is present to prevent slipping under it", () => {
      const titlebar = document.createElement("div");
      titlebar.className = "desktop-window-titlebar";
      vi.spyOn(titlebar, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 32,
        height: 32,
        width: 1200,
        left: 0,
        right: 1200,
        x: 0,
        y: 0,
        toJSON: () => {}
      });
      document.body.appendChild(titlebar);

      try {
        expect(getFloatingTopBoundary()).toBe(32);

        const states = loadWidgetStates();
        states["pushup-reminder"] = {
          ...states["pushup-reminder"],
          enabled: true,
          minimized: true,
          dockedToRail: false,
          x: 100,
          y: 0
        };

        const normalized = normalizeWidgetStates(states);
        // y must clamp to 32 (directly below the titlebar) and not slip underneath (y < 32)
        expect(normalized["pushup-reminder"].y).toBe(32);
      } finally {
        titlebar.remove();
      }
    });
  });

  describe("Rail Slot Locking and Header Dock Transfer", () => {
    it("enforces non-overlapping slots with clean gaps on the right rail", () => {
      const states = loadWidgetStates();
      // Enable 3 widgets docked to rail with overlapping initial y
      states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, y: 70 };
      states["ai-quota"] = { ...states["ai-quota"], enabled: true, minimized: true, dockedToRail: true, y: 70 };
      states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, y: 75 };

      enforceRailDockSlots(states, 1200, 800);

      // Verify each widget has a distinct non-overlapping slot with at least DOCK_GAP (8px)
      const railWidgets = [states.clock, states["ai-quota"], states["pushup-reminder"]].sort((a, b) => a.y - b.y);

      for (let i = 0; i < railWidgets.length - 1; i++) {
        const current = railWidgets[i]!;
        const next = railWidgets[i + 1]!;
        const currentH = WIDGET_DOCK_HEIGHTS[current.id] ?? 52;
        // next.y must be at least current.y + currentH + DOCK_GAP
        expect(next.y).toBeGreaterThanOrEqual(current.y + currentH + DOCK_GAP);
      }
    });

    it("transfers docked widgets into the header toolbar when isMultiColumn is active", () => {
      // Create a mock #toolbar-docked-widgets container in document.body
      const toolbarContainer = document.createElement("div");
      toolbarContainer.id = "toolbar-docked-widgets";
      toolbarContainer.className = "toolbar-docked-widgets";
      document.body.appendChild(toolbarContainer);

      try {
        const state = {
          id: "clock" as const,
          enabled: true,
          x: window.innerWidth - 61,
          y: 200,
          minimized: true,
          dockedToRail: true
        };

        const { container } = render(
          <ClockWidget
            state={state}
            isMultiColumn={true}
            onPositionChange={vi.fn()}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        // The widget should be rendered inside #toolbar-docked-widgets via portal
        const headerDocked = toolbarContainer.querySelector("[data-docked-header='true']");
        expect(headerDocked).toBeTruthy();
        expect(headerDocked?.classList.contains("is-header-docked")).toBe(true);
        expect(headerDocked?.textContent).toContain("Clock");

        // The original container should not contain the rail-docked widget
        expect(container.querySelector(".is-rail-docked")).toBeNull();
      } finally {
        toolbarContainer.remove();
      }
    });

    it("allows 1-click alert dismissal when transferred into header toolbar", () => {
      const toolbarContainer = document.createElement("div");
      toolbarContainer.id = "toolbar-docked-widgets";
      toolbarContainer.className = "toolbar-docked-widgets";
      document.body.appendChild(toolbarContainer);

      try {
        saveWidgetConfig("pushup-reminder", {
          intervalMinutes: 30,
          targetReps: 15,
          totalRepsToday: 0,
          setsCompletedToday: 0,
          remainingSeconds: 0,
          isRunning: true,
          isAlertActive: true,
          lastActiveDate: new Date().toISOString().slice(0, 10)
        });

        const state = {
          id: "pushup-reminder" as const,
          enabled: true,
          x: window.innerWidth - 61,
          y: 150,
          minimized: true,
          dockedToRail: true
        };

        render(
          <PushupReminderWidget
            state={state}
            isMultiColumn={true}
            onPositionChange={vi.fn()}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        const headerWidget = toolbarContainer.querySelector(".is-header-docked");
        expect(headerWidget).toBeTruthy();
        expect(headerWidget?.classList.contains("is-alert")).toBe(true);

        const stopBtn = headerWidget?.querySelector(".widget-docked-alert-action")!;
        expect(stopBtn).toBeTruthy();

        // 1-click stops the notification and logs the set (+15 reps)
        fireEvent.click(stopBtn);

        const reloadedConfig = loadWidgetConfig("pushup-reminder", DEFAULT_PUSHUP_CONFIG);
        expect(reloadedConfig.isAlertActive).toBe(false);
        expect(reloadedConfig.totalRepsToday).toBe(15);
        expect(reloadedConfig.setsCompletedToday).toBe(1);
      } finally {
        toolbarContainer.remove();
      }
    });

    it("undocks to floating window when double clicked in header toolbar", () => {
      const toolbarContainer = document.createElement("div");
      toolbarContainer.id = "toolbar-docked-widgets";
      toolbarContainer.className = "toolbar-docked-widgets";
      document.body.appendChild(toolbarContainer);

      try {
        const onPositionChange = vi.fn();
        const state = {
          id: "clock" as const,
          enabled: true,
          x: window.innerWidth - 61,
          y: 200,
          minimized: true,
          dockedToRail: true
        };

        render(
          <ClockWidget
            state={state}
            isMultiColumn={true}
            onPositionChange={onPositionChange}
            onToggleMinimize={vi.fn()}
            onClose={vi.fn()}
            onFocus={vi.fn()}
          />
        );

        const headerWidget = toolbarContainer.querySelector(".is-header-docked")!;
        expect(headerWidget).toBeTruthy();

        // Double click undocks the widget
        fireEvent.doubleClick(headerWidget);
        expect(onPositionChange).toHaveBeenCalledWith(expect.any(Number), 200, false);
      } finally {
        toolbarContainer.remove();
      }
    });

    it("preserves user-dragged vertical position on the rail without snapping back to the top", () => {
      const states = loadWidgetStates();
      states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, y: 72 };
      states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, y: 150 };
      states["ai-quota"] = { ...states["ai-quota"], enabled: true, minimized: true, dockedToRail: true, y: 400 };

      // Moving ai-quota to 400 should stay at 400 because there is no collision
      resolveRailDockCollisions(states, "ai-quota", 1200, 800);

      expect(states.clock.y).toBe(72);
      expect(states["pushup-reminder"].y).toBe(150);
      expect(states["ai-quota"].y).toBe(400);
    });

    it("locks widgets with 8px gap when dragged to an overlapping rail position", () => {
      const states = loadWidgetStates();
      states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, y: 72 };
      // User drags pushup-reminder to y = 80, overlapping with clock [72, 124]
      states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, y: 80 };

      resolveRailDockCollisions(states, "pushup-reminder", 1200, 800);

      expect(states.clock.y).toBe(72);
      // pushup-reminder locks cleanly right below clock with 8px gap
      expect(states["pushup-reminder"].y).toBe(72 + 52 + DOCK_GAP);
    });

    it("shares the rail column with an open docked Snip Tool, which a closed one leaves free", () => {
      const states = loadWidgetStates();
      saveSnipRailDock({ y: 72, open: true });
      states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, y: 80 };
      resolveRailDockCollisions(states, undefined, 1200, 800);
      expect(states.clock.y).toBe(72 + SNIP_RAIL_HEIGHT + DOCK_GAP);

      // A widget dropped onto the snip card pushes the card down instead.
      states.clock = { ...states.clock, y: 72 };
      resolveRailDockCollisions(states, "clock", 1200, 800);
      expect(states.clock.y).toBe(72);
      expect(loadSnipRailDock()).toEqual({ y: 72 + WIDGET_DOCK_HEIGHTS.clock + DOCK_GAP, open: true });

      saveSnipRailDock({ y: 72, open: false });
      states.clock = { ...states.clock, y: 80 };
      resolveRailDockCollisions(states, undefined, 1200, 800);
      expect(states.clock.y).toBe(80);
    });

    it("keeps docked widgets and the Snip card clear of the Live orb", () => {
      const rail = document.createElement("div");
      rail.className = "room-toolbar-collapsed";
      const orb = document.createElement("button");
      orb.className = "room-live-rail-button";
      orb.getBoundingClientRect = () => ({ top: 200, bottom: 248, left: 1150, right: 1198, width: 48, height: 48, x: 1150, y: 200, toJSON() {} }) as DOMRect;
      rail.append(orb);
      document.body.append(rail);
      try {
        const states = loadWidgetStates();
        // Dropped on the orb's upper half a widget sits above the orb, on its lower half below it.
        states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, y: 180 };
        resolveRailDockCollisions(states, "clock", 1200, 800);
        expect(states.clock.y).toBe(200 - DOCK_GAP - WIDGET_DOCK_HEIGHTS.clock);
        states.clock = { ...states.clock, y: 215 };
        resolveRailDockCollisions(states, "clock", 1200, 800);
        expect(states.clock.y).toBe(248 + DOCK_GAP);

        // A widget pushed down by the Snip card jumps over the orb instead of landing on it.
        saveSnipRailDock({ y: 100, open: true });
        states.clock = { ...states.clock, y: 110 };
        resolveRailDockCollisions(states, undefined, 1200, 800);
        expect(loadSnipRailDock()?.y).toBe(100);
        expect(states.clock.y).toBe(248 + DOCK_GAP);
      } finally {
        rail.remove();
      }
    });

    it("undocks to floating window when double clicked on right rail", () => {
      const onPositionChange = vi.fn();
      const state = {
        id: "clock" as const,
        enabled: true,
        x: window.innerWidth - 61,
        y: 200,
        minimized: true,
        dockedToRail: true
      };

      const { container } = render(
        <ClockWidget
          state={state}
          isMultiColumn={false}
          onPositionChange={onPositionChange}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const railWidget = container.querySelector(".is-rail-docked")!;
      expect(railWidget).toBeTruthy();

      fireEvent.doubleClick(railWidget);
      expect(onPositionChange).toHaveBeenCalledWith(expect.any(Number), 200, false);
    });

    it("reorders widgets horizontally in header dock when dragged", () => {
      const states = loadWidgetStates();
      states.clock = { ...states.clock, enabled: true, minimized: true, dockedToRail: true, x: 100 };
      states["pushup-reminder"] = { ...states["pushup-reminder"], enabled: true, minimized: true, dockedToRail: true, x: 200 };
      states["ai-quota"] = { ...states["ai-quota"], enabled: true, minimized: true, dockedToRail: true, x: 50 }; // dragged to the front

      resolveHeaderDockCollisions(states, "ai-quota");

      // ai-quota (x: 50) is first, clock (x: 100) is second, pushup-reminder (x: 200) is third
      expect(states["ai-quota"].x).toBe(100);
      expect(states.clock.x).toBe(200);
      expect(states["pushup-reminder"].x).toBe(300);
    });

    it("renders AI Quota in 2 distinct rows for compact 2-line header display", () => {
      const state = {
        id: "ai-quota" as const,
        enabled: true,
        x: 100,
        y: 100,
        minimized: true,
        dockedToRail: true
      };

      const { container } = render(
        <AiQuotaWidget
          state={state}
          isMultiColumn={false}
          onPositionChange={vi.fn()}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const rows = container.querySelectorAll(".ai-quota-docked-row");
      expect(rows.length).toBe(2);
      expect(rows[0]?.textContent).toContain("Ready");
      expect(rows[1]?.textContent).toContain("Next");
    });
  });

  describe("computeQuotaAggregates Quota Accounting", () => {
    it("reports 0 active accounts and 0% available quota when all accounts have exhausted weekly quota", () => {
      const mockCodexAccounts = {
        data: [
          {
            id: "1",
            label: "flpgmopai@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 56,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          },
          {
            id: "2",
            label: "indgmopai@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 8,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          },
          {
            id: "3",
            label: "mesienikolas@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 0,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          },
          {
            id: "4",
            label: "niggmopai@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 100,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          },
          {
            id: "5",
            label: "ntheogr@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 0,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          }
        ],
        pagination: { page: 1, pageSize: 100, totalItems: 5, totalPages: 1 },
        source: "space-gateway" as const,
        isStale: false,
        error: null,
        checkedAt: new Date().toISOString()
      };

      const result = computeQuotaAggregates(mockCodexAccounts, null, null);

      expect(result.codex.totalAccounts).toBe(5);
      expect(result.codex.activeAccounts5h).toBe(0);
      expect(result.codex.activeAccountsWeekly).toBe(0);
      expect(result.codex.exhaustedAccounts).toBe(5);
      expect(result.codex.available5h).toBe(0);
      expect(result.codex.availableWeekly).toBe(0);
      expect(result.codex.percent5h).toBe(0);
      expect(result.codex.percentWeekly).toBe(0);
      expect(result.codex.accounts.every((a) => a.status === "QUOTA_EXCEEDED")).toBe(true);
    });

    it("correctly calculates available 5h and weekly quota when accounts are healthy", () => {
      const mockCodexAccounts = {
        data: [
          {
            id: "1",
            label: "healthy@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 80,
            weeklyRemainingPercent: 90,
            sampledAt: new Date().toISOString()
          },
          {
            id: "2",
            label: "exhausted@gmail.com",
            planType: "plus",
            fiveHourRemainingPercent: 0,
            weeklyRemainingPercent: 0,
            sampledAt: new Date().toISOString()
          }
        ],
        pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 },
        source: "space-gateway" as const,
        isStale: false,
        error: null,
        checkedAt: new Date().toISOString()
      };

      const result = computeQuotaAggregates(mockCodexAccounts, null, null);

      expect(result.codex.totalAccounts).toBe(2);
      expect(result.codex.activeAccounts5h).toBe(1);
      expect(result.codex.activeAccountsWeekly).toBe(1);
      expect(result.codex.available5h).toBe(80);
      expect(result.codex.availableWeekly).toBe(90);
      expect(result.codex.percent5h).toBe(40); // 80 / 200 = 40%
      expect(result.codex.percentWeekly).toBe(45); // 90 / 200 = 45%
      expect(result.codex.accounts[0]?.status).toBe("ACTIVE");
      expect(result.codex.accounts[1]?.status).toBe("QUOTA_EXCEEDED");
    });
  });

  describe("Widget Drag Stability and Loop Prevention", () => {
    it("correctly identifies equal widget states with areWidgetStatesEqual", () => {
      const a = loadWidgetStates();
      const b = loadWidgetStates();
      expect(areWidgetStatesEqual(a, b)).toBe(true);

      b.clock.y = 999;
      expect(areWidgetStatesEqual(a, b)).toBe(false);
    });

    it("preserves rail dockPosition when dragging up on the rail even if isMultiColumn is active", () => {
      const onPositionChange = vi.fn();
      const state = {
        id: "clock" as const,
        enabled: true,
        x: 1139,
        y: 200,
        minimized: true,
        dockedToRail: true,
        dockPosition: "rail" as const
      };

      const { container } = render(
        <ClockWidget
          state={state}
          isMultiColumn={true}
          onPositionChange={onPositionChange}
          onToggleMinimize={vi.fn()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        />
      );

      const handle = container.querySelector(".desktop-widget-docked-card")!;
      expect(handle).toBeTruthy();

      // Drag up slightly on rail
      fireEvent.pointerDown(handle, { clientX: 1150, clientY: 200, button: 0 });
      fireEvent.pointerMove(window, { clientX: 1150, clientY: 160 });
      fireEvent.pointerUp(window, { clientX: 1150, clientY: 160 });

      expect(onPositionChange).toHaveBeenCalledWith(expect.any(Number), 160, true, "rail");
    });

    it("does not trigger infinite loop or ping-pong when rail widget is mounted or dragged", () => {
      const states = loadWidgetStates();
      states.clock.enabled = true;
      states.clock.minimized = true;
      states.clock.dockedToRail = true;
      states.clock.dockPosition = "rail";
      states["pushup-reminder"].enabled = true;
      states["pushup-reminder"].minimized = true;
      states["pushup-reminder"].dockedToRail = true;
      states["pushup-reminder"].dockPosition = "rail";
      saveWidgetStates(states);

      let dispatchCount = 0;
      const listener = () => {
        dispatchCount++;
      };
      window.addEventListener("space:desktop-widgets:changed", listener);

      try {
        const view = render(<DesktopWidgetsLayer isMultiColumn={true} />);
        const railCards = view.container.querySelectorAll(".desktop-widget-docked-card");
        expect(railCards.length).toBe(2);

        // Move first card up
        fireEvent.pointerDown(railCards[0]!, { clientX: 1150, clientY: 200, button: 0 });
        fireEvent.pointerMove(window, { clientX: 1150, clientY: 150 });
        fireEvent.pointerUp(window, { clientX: 1150, clientY: 150 });

        // Dispatch count should be strictly bounded (at most 1-2 changes, NOT an infinite cascade)
        expect(dispatchCount).toBeLessThan(5);
      } finally {
        window.removeEventListener("space:desktop-widgets:changed", listener);
      }
    });
  });

  describe("AI Token Reminder merged into AI Quota & Usage", () => {
    it("reopens an open reminder as AI Quota & Usage in the same place", () => {
      const legacyState = {
        clock: { id: "clock", enabled: true, x: 100, y: 100, zIndex: 120 },
        "token-reminder": { id: "token-reminder", enabled: true, x: 240, y: 320, zIndex: 123 }
      };
      const normalized = normalizeWidgetStates(legacyState);
      expect(Object.keys(normalized)).not.toContain("token-reminder");
      expect(normalized["ai-quota"]).toMatchObject({ enabled: true, minimized: false, x: 240, y: 320 });
    });

    it("keeps an already open AI Quota & Usage where it is", () => {
      const normalized = normalizeWidgetStates({
        "ai-quota": { id: "ai-quota", enabled: true, x: 500, y: 90 },
        "token-reminder": { id: "token-reminder", enabled: true, x: 240, y: 320 }
      });
      expect(normalized["ai-quota"]).toMatchObject({ enabled: true, x: 500, y: 90 });
    });

    it("adopts the reminder's alert settings once and turns alerts on when it was open", () => {
      localStorage.setItem("space.desktop-widgets.config.token-reminder", JSON.stringify({ tokenProvider: "codex", proOnly: true, soundEnabled: false }));
      localStorage.setItem("space.desktop-widgets.state.v1", JSON.stringify({ "token-reminder": { id: "token-reminder", enabled: true, x: 1, y: 1 } }));
      expect(loadAiQuotaWidgetConfig()).toMatchObject({ alertsEnabled: true, alertProvider: "codex", proOnly: true, soundEnabled: false });

      // Later changes are kept; the legacy settings are not read again.
      saveWidgetConfig("ai-quota", { ...loadAiQuotaWidgetConfig(), alertsEnabled: false });
      expect(loadAiQuotaWidgetConfig().alertsEnabled).toBe(false);
    });

    it("starts with alerts off when there was no reminder", () => {
      expect(loadAiQuotaWidgetConfig()).toMatchObject({ alertsEnabled: false, alertProvider: "all", proOnly: false, soundEnabled: true });
    });
  });
});
