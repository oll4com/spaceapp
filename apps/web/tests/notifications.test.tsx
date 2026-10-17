import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceNotification } from "@space/contracts";
import { NotificationCenterDock } from "../src/features/notifications/NotificationCenterDock.js";
import { NotificationSettingsCard } from "../src/features/notifications/NotificationSettingsCard.js";
import { NotificationToastHost } from "../src/features/notifications/NotificationToastHost.js";
import { deliverNotifications } from "../src/features/notifications/notification-delivery.js";
import { desktopNotificationPermission, setDesktopNotifications, showDesktopNotification, subscribeNativeNotificationOpen } from "../src/features/notifications/desktop-notifications.js";
import {
  ingestNotificationStreamPayload, peekNotificationStore, refreshNotifications, resetNotificationStore, setNotificationDeliveryHandler, setNotificationNavigator
} from "../src/features/notifications/notification-store.js";
import { workspaceRoomActivity } from "../src/features/ui-theme/workspace-room-filter.js";

const apiMock = vi.hoisted(() => ({
  notificationsPending: vi.fn(), notifications: vi.fn(), notification: vi.fn(), markNotificationRead: vi.fn(), ackNotification: vi.fn(), readAllNotifications: vi.fn(), testNotification: vi.fn(),
  userSettings: vi.fn(), updateUserSettings: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));
const chimeMock = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock("../src/features/desktop-widgets/audio-chime.js", () => chimeMock);

const now = new Date().toISOString();
function notification(id: string, overrides: Partial<SpaceNotification> = {}): SpaceNotification {
  return { id: `notification:${id}`, ownerUserId: "user:me", roomId: "room:1", paneId: "pane:mail", source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "ATTENTION", title: "Anna Papadopoulou",
    body: "Invoice #4521 — please find attached", link: { roomId: "room:1", paneId: "pane:mail", target: "thread:me@gmail.com:t1" }, dedupeKey: null, status: "OPEN", payload: {},
    createdAt: now, updatedAt: now, readAt: null, ackedAt: null, resolvedAt: null, ...overrides };
}
function pending(items: SpaceNotification[]) {
  const open = items.filter((item) => item.status === "OPEN");
  const count = (key: (item: SpaceNotification) => string | null) => open.reduce<Record<string, number>>((out, item) => { const value = key(item); if (value) out[value] = (out[value] ?? 0) + 1; return out; }, {});
  return { total: open.length, bySource: count((item) => item.source), byRoom: count((item) => item.roomId), byPane: count((item) => item.paneId), latest: open };
}

describe("Space notifications (web)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute("data-suppress-notifications");
    resetNotificationStore("user:me");
    apiMock.markNotificationRead.mockResolvedValue({});
    apiMock.ackNotification.mockResolvedValue({});
    apiMock.readAllNotifications.mockResolvedValue({ read: 1 });
    apiMock.updateUserSettings.mockResolvedValue({});
    apiMock.userSettings.mockResolvedValue({ notifications: null });
  });
  afterEach(() => { cleanup(); setNotificationNavigator(null); setNotificationDeliveryHandler(null); });

  it("loads what waits, delivers only records that are new after the first load, and ignores other users' stream events", async () => {
    const first = [notification("a")];
    apiMock.notificationsPending.mockResolvedValue(pending(first));
    apiMock.notifications.mockResolvedValue({ notifications: first });
    const delivered = vi.fn();
    setNotificationDeliveryHandler(delivered);
    await refreshNotifications();
    expect(peekNotificationStore().pending.total).toBe(1);
    expect(delivered).not.toHaveBeenCalled();
    const second = [notification("b"), ...first];
    apiMock.notificationsPending.mockResolvedValue(pending(second));
    apiMock.notifications.mockResolvedValue({ notifications: second });
    vi.useFakeTimers();
    ingestNotificationStreamPayload({ notificationId: "notification:x", ownerUserId: "user:other", source: "SYSTEM", kind: "TEST", severity: "INFO", status: "OPEN", roomId: null, paneId: null });
    await vi.advanceTimersByTimeAsync(400);
    expect(apiMock.notificationsPending).toHaveBeenCalledTimes(1);
    ingestNotificationStreamPayload({ notificationId: "notification:b", ownerUserId: "user:me", source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "ATTENTION", status: "OPEN", roomId: "room:1", paneId: "pane:mail" });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    await waitFor(() => expect(delivered).toHaveBeenCalledWith([expect.objectContaining({ id: "notification:b" })]));
    expect(peekNotificationStore().pending.byRoom).toEqual({ "room:1": 2 });
    // Rooms with open notifications count as needing attention.
    expect(workspaceRoomActivity([], {}, 0, 2).attention).toBe(true);
    expect(workspaceRoomActivity([], {}, 0, 0).attention).toBe(false);
  });

  it("delivers a toast and one chime in the foreground, nothing while suppressed, and a click opens the target", async () => {
    const navigate = vi.fn();
    setNotificationNavigator(navigate);
    apiMock.notificationsPending.mockResolvedValue(pending([]));
    apiMock.notifications.mockResolvedValue({ notifications: [] });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<NotificationToastHost />);
    act(() => { deliverNotifications([notification("a"), notification("b", { severity: "INFO", title: "Newsletter", paneId: "pane:news" })], null); });
    expect(await screen.findByText("Anna Papadopoulou")).toBeTruthy();
    expect(screen.getByText("Newsletter")).toBeTruthy();
    expect(screen.getAllByText("Mail Copilot")).toHaveLength(2);
    expect(chimeMock.playChime).toHaveBeenCalledTimes(1);
    expect(chimeMock.playChime).toHaveBeenCalledWith("notification");
    fireEvent.click(screen.getByText("Anna Papadopoulou"));
    expect(navigate).toHaveBeenCalledWith({ roomId: "room:1", paneId: "pane:mail", target: "thread:me@gmail.com:t1" }, expect.objectContaining({ id: "notification:a" }));
    await waitFor(() => expect(apiMock.markNotificationRead).toHaveBeenCalledWith("notification:a"));
    await waitFor(() => expect(screen.queryByText("Anna Papadopoulou")).toBeNull());
    document.documentElement.setAttribute("data-suppress-notifications", "true");
    act(() => { deliverNotifications([notification("c")], null); });
    expect(screen.queryByText(/Anna/)).toBeNull();
    expect(chimeMock.playChime).toHaveBeenCalledTimes(1);
    // A source turned down in the settings delivers nothing either.
    document.documentElement.removeAttribute("data-suppress-notifications");
    act(() => { deliverNotifications([notification("d")], { channels: { inApp: true, toast: true, sound: true, desktop: true, telegram: true }, perSource: { MAIL_COPILOT: { inApp: false } } }); });
    expect(screen.queryByText(/Anna/)).toBeNull();
  });

  it("shows one toast per pane (the newest replaces the rest) and closes it on its own", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.useFakeTimers();
    try {
      render(<NotificationToastHost />);
      // One Job Copilot moment: its question and the browser handoff arrive together with an older question, newest first.
      const pane = { roomId: "room:1", paneId: "pane:job" };
      act(() => { deliverNotifications([
        notification("q2", { ...pane, source: "JOB_COPILOT", title: "Job Copilot 16 needs you", body: "Needs you: captcha" }),
        notification("handoff", { ...pane, source: "BROWSER_HANDOFF", title: "The browser needs you" }),
        notification("q1", { ...pane, source: "JOB_COPILOT", title: "Older question" }),
        notification("mail")
      ], null); });
      expect(peekNotificationStore().toasts.map((toast) => toast.id)).toEqual(["notification:q2", "notification:mail"]);
      expect(screen.getByText("Job Copilot 16 needs you")).toBeTruthy();
      expect(screen.queryByText("The browser needs you")).toBeNull();
      // A later notification of the same pane replaces its toast instead of stacking.
      act(() => { deliverNotifications([notification("q3", { ...pane, source: "JOB_COPILOT", title: "Next question" })], null); });
      expect(peekNotificationStore().toasts.map((toast) => toast.id)).toEqual(["notification:mail", "notification:q3"]);
      act(() => { vi.advanceTimersByTime(8_100); });
      expect(peekNotificationStore().toasts).toEqual([]);
      expect(screen.queryByText("Next question")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("inside the Android app the shell shows the notification while Space is in the background and a tap comes back as the record's id", async () => {
    const native = { notify: vi.fn(() => true), notificationsAllowed: vi.fn(() => true), requestNotificationPermission: vi.fn(() => true), takePendingNotification: vi.fn<() => string | null>(() => null) };
    (window as unknown as { SpaceNative?: unknown }).SpaceNative = native;
    const hidden = vi.spyOn(document, "hidden", "get");
    try {
      expect(desktopNotificationPermission()).toBe("granted");
      await expect(setDesktopNotifications(true)).resolves.toBe(true);
      // Foreground: the toast covers it, the system stays quiet.
      hidden.mockReturnValue(false);
      act(() => { deliverNotifications([notification("fg")], null); });
      expect(native.notify).not.toHaveBeenCalled();
      // Background: the shell shows it (no toast), with the source in the title.
      hidden.mockReturnValue(true);
      act(() => { deliverNotifications([notification("bg")], null); });
      expect(native.notify).toHaveBeenCalledWith("notification:bg", "Mail Copilot: Anna Papadopoulou", "Invoice #4521 — please find attached");
      expect(peekNotificationStore().toasts.map((toast) => toast.id)).toEqual(["notification:fg"]);
      // The system permission is the gate: off means the browser toast path is used instead.
      native.notificationsAllowed.mockReturnValue(false);
      expect(desktopNotificationPermission()).toBe("default");
      native.notify.mockReturnValue(false);
      act(() => { deliverNotifications([notification("quiet")], null); });
      expect(peekNotificationStore().toasts.map((toast) => toast.id)).toContain("notification:quiet");
      // A tap: the shell keeps the id (cold start included) and the page takes it through the bootstrap hook.
      const opened: string[] = [];
      native.takePendingNotification.mockReturnValueOnce("notification:tapped");
      const unsubscribe = subscribeNativeNotificationOpen((id) => opened.push(id));
      expect(opened).toEqual(["notification:tapped"]);
      native.takePendingNotification.mockReturnValueOnce("notification:later");
      (window as unknown as { __spaceOpenNotification?: () => void }).__spaceOpenNotification?.();
      expect(opened).toEqual(["notification:tapped", "notification:later"]);
      unsubscribe();
      expect((window as unknown as { __spaceOpenNotification?: () => void }).__spaceOpenNotification).toBeUndefined();
      // Outside a shell, a direct call is a browser Notification only when granted and in the background.
      delete (window as unknown as { SpaceNative?: unknown }).SpaceNative;
      expect(showDesktopNotification({ title: "t", body: "b", tag: "x", onClick: () => undefined })).toBe(false);
    } finally {
      delete (window as unknown as { SpaceNative?: unknown }).SpaceNative;
      hidden.mockRestore();
      window.localStorage.removeItem("space.notifications.desktop");
    }
  });

  it("lists notifications in the Center with unread first, acknowledges one and marks all read", async () => {
    const items = [notification("a"), notification("b", { status: "READ", source: "ROOM_AGENT", title: "Bob is waiting" })];
    apiMock.notificationsPending.mockResolvedValue(pending(items));
    apiMock.notifications.mockResolvedValue({ notifications: items });
    render(<NotificationCenterDock />);
    expect(await screen.findByText("1 unread")).toBeTruthy();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "All" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: "Unread: Mail Copilot: Anna Papadopoulou" })).toBeTruthy();
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]!).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(apiMock.ackNotification).toHaveBeenCalledWith("notification:a"));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(apiMock.readAllNotifications).toHaveBeenCalled());
  });

  it("saves the channel settings and raises a test notification from the settings card", async () => {
    apiMock.testNotification.mockResolvedValue({ notification: notification("t") });
    const onSuppress = vi.fn();
    render(<NotificationSettingsCard suppressNotifications={false} onSuppressNotificationsChange={onSuppress} />);
    await waitFor(() => expect(apiMock.userSettings).toHaveBeenCalled());
    const sound = await screen.findByRole("switch", { name: "Sound" });
    await waitFor(() => expect((sound as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(sound);
    await waitFor(() => expect(apiMock.updateUserSettings).toHaveBeenCalledWith({ notifications: expect.objectContaining({ channels: expect.objectContaining({ sound: false }) }) }));
    fireEvent.click(screen.getByRole("switch", { name: "Show notifications" }));
    expect(onSuppress).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Send a test notification" }));
    await waitFor(() => expect(apiMock.testNotification).toHaveBeenCalled());
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
