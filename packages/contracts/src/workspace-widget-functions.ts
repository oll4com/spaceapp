/** Shared deterministic behavior used by the widgets and their setup function checks. */
export function formatWorkspaceClock(time: Date, is24Hour: boolean) {
  const hours = time.getHours();
  return {
    hours: String(is24Hour ? hours : hours % 12 || 12).padStart(2, "0"),
    minutes: String(time.getMinutes()).padStart(2, "0"),
    seconds: String(time.getSeconds()).padStart(2, "0"),
    ampm: is24Hour ? "" : hours >= 12 ? "PM" : "AM"
  };
}

export function advanceWorkspaceCountdown(current: { remainingSeconds: number; isRunning: boolean }) {
  if (!current.isRunning) return { ...current, isCompleted: current.remainingSeconds === 0 };
  const remainingSeconds = Math.max(0, current.remainingSeconds - 1);
  return { remainingSeconds, isRunning: remainingSeconds > 0, isCompleted: remainingSeconds === 0 };
}

export const WORKSPACE_PROMO_CONTENT = Object.freeze({
  headline: "SpaceApp.dev it's FREE!!!", subheadline: "OPEN SOURCE",
  platformText: "FOR ALL PLATFORMS", url: "https://spaceapp.dev"
});

export function advanceWorkspaceMovementReminder<T extends {
  remainingSeconds: number; intervalMinutes: number; isRunning: boolean; isAlertActive: boolean
}>(current: T, remainingSeconds = current.remainingSeconds - 1): T & { alertReason?: "pushups" } {
  if (!current.isRunning || current.isAlertActive) return current;
  if (remainingSeconds <= 0) return { ...current, remainingSeconds: current.intervalMinutes * 60,
    isAlertActive: true, alertReason: "pushups" };
  return { ...current, remainingSeconds };
}

export function checkWorkspaceWidgetFunction(id: "clock" | "countdown-timer" | "pushup-reminder" | "spaceapp-promo", timeZone: string) {
  if (id === "clock") {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
    const result = formatWorkspaceClock(new Date(2026, 0, 1, 13, 5, 9), true);
    if (result.hours !== "13" || result.minutes !== "05" || result.seconds !== "09") throw new Error("Clock function check failed.");
  } else if (id === "countdown-timer") {
    const stopped = advanceWorkspaceCountdown({ remainingSeconds: 2, isRunning: false });
    const running = advanceWorkspaceCountdown({ remainingSeconds: 2, isRunning: true });
    const finished = advanceWorkspaceCountdown({ remainingSeconds: 1, isRunning: true });
    if (stopped.remainingSeconds !== 2 || running.remainingSeconds !== 1 || finished.isRunning || !finished.isCompleted) throw new Error("Timer function check failed.");
  } else if (id === "pushup-reminder") {
    const current = { remainingSeconds: 2, intervalMinutes: 15, isRunning: true, isAlertActive: false };
    const next = advanceWorkspaceMovementReminder(current);
    const alert = advanceWorkspaceMovementReminder(next);
    if (next.remainingSeconds !== 1 || !alert.isAlertActive || alert.remainingSeconds !== 900 ||
      advanceWorkspaceMovementReminder(alert) !== alert) throw new Error("Movement reminder function check failed.");
  } else {
    const url = new URL(WORKSPACE_PROMO_CONTENT.url);
    if (url.protocol !== "https:" || url.hostname !== "spaceapp.dev" || !WORKSPACE_PROMO_CONTENT.headline ||
      !WORKSPACE_PROMO_CONTENT.subheadline || !WORKSPACE_PROMO_CONTENT.platformText) throw new Error("SpaceApp news source is unavailable.");
  }
}
