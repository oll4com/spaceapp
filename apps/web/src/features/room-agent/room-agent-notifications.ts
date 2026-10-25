// Room Agent "Desktop alerts" is the per-browser desktop notification switch shared by every notification
// source (Settings → Notifications); attention events reach the operator through the notification store.
export {
  desktopNotificationsEnabled as roomAgentDesktopNotificationsEnabled,
  desktopNotificationsSupported as roomAgentDesktopNotificationsSupported,
  setDesktopNotifications as setRoomAgentDesktopNotifications
} from "../notifications/desktop-notifications.js";
