import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_SOURCES, type SpaceNotification } from "@space/contracts";
import { NotificationCenterDock } from "../src/features/notifications/NotificationCenterDock.js";
import { NotificationSettingsCard } from "../src/features/notifications/NotificationSettingsCard.js";
import { NotificationToastHost } from "../src/features/notifications/NotificationToastHost.js";
import { deliverNotifications } from "../src/features/notifications/notification-delivery.js";
import { desktopNotificationPermission, setDesktopNotifications, showDesktopNotification, subscribeNativeNotificationOpen, subscribePushTokenRegistration } from "../src/features/notifications/desktop-notifications.js";
import {
  ingestNotificationStreamPayload, peekNotificationStore, refreshNotifications, resetNotificationStore, setNotificationDeliveryHandler, setNotificationNavigator
} from "../src/features/notifications/notification-store.js";
import { workspaceRoomActivity } from "../src/features/ui-theme/workspace-room-filter.js";
import { NOUS_FOCUS_EVENT, writeNousFocusEnabled, type NousFocusDetail } from "../src/features/nous-focus/nous-focus-events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const apiMock = vi.hoisted(() => ({
  notificationsPending: vi.fn(), notifications: vi.fn(), notification: vi.fn(), markNotificationRead: vi.fn(), ackNotification: vi.fn(), readAllNotifications: vi.fn(), testNotification: vi.fn(),
  registerPushDevice: vi.fn(), removePushDevice: vi.fn(), userSettings: vi.fn(), updateUserSettings: vi.fn()
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
  const count = (key: (item: SpaceNotification) => string | null, from = open) => from.reduce<Record<string, number>>((out, item) => { const value = key(item); if (value) out[value] = (out[value] ?? 0) + 1; return out; }, {});
  return { total: open.length, bySource: count((item) => item.source), byRoom: count((item) => item.roomId, open.filter((item) => item.severity !== "INFO")), byPane: count((item) => item.paneId), latest: open };
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

  it("delivers a needs-you request on a pane as the focus banner instead of a toast, with one chime; the device setting off keeps the toast (operator request 2026-10-24)", async () => {
    installSpaceRuntime(liveRuntime);
    writeNousFocusEnabled(true);
    apiMock.notificationsPending.mockResolvedValue(pending([]));
    apiMock.notifications.mockResolvedValue({ notifications: [] });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<NotificationToastHost />);
    const focused: NousFocusDetail[] = [];
    const onFocus = (event: Event) => focused.push((event as CustomEvent<NousFocusDetail>).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    const question = notification("q", { source: "JOB_COPILOT", kind: "QUESTION", title: "Which CV?", paneId: "pane:job", dedupeKey: "job-apply:question:1" });
    act(() => { deliverNotifications([question, notification("mail", { severity: "INFO", title: "Newsletter", paneId: "pane:news" })], null); });
    expect(focused).toEqual([{ roomId: "room:1", paneId: "pane:job", immediate: false, notification: question }]);
    expect(screen.queryByText("Which CV?")).toBeNull();
    expect(await screen.findByText("Newsletter")).toBeTruthy();
    expect(chimeMock.playChime).toHaveBeenCalledTimes(1);
    writeNousFocusEnabled(false);
    act(() => { deliverNotifications([notification("q2", { source: "JOB_COPILOT", kind: "QUESTION", title: "Which cover letter?", paneId: "pane:job2", dedupeKey: "job-apply:question:2" })], null); });
    window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    expect(focused).toHaveLength(1);
    expect(await screen.findByText("Which cover letter?")).toBeTruthy();
    writeNousFocusEnabled(true);
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
    act(() => { deliverNotifications([notification("d")], { channels: { inApp: true, toast: true, sound: true, desktop: true, telegram: true, push: true }, perSource: { MAIL_COPILOT: { inApp: false } }, quietHours: { enabled: true, start: "23:00", end: "09:00" } }); });
    expect(screen.queryByText(/Anna/)).toBeNull();
    // Held for the operator's morning (quiet hours, plan clipboard:9XSwTPyxXP1W): no toast or chime until then.
    act(() => { deliverNotifications([notification("e", { payload: { heldUntil: new Date(Date.now() + 3_600_000).toISOString() } })], null); });
    expect(screen.queryByText(/Anna/)).toBeNull();
    // A copilot question held for Nous (Ask Last step 7): nothing until its release re-alerts it.
    act(() => { deliverNotifications([notification("f", { payload: { heldForNous: { until: new Date(Date.now() + 3_600_000).toISOString() } } })], null); });
    expect(screen.queryByText(/Anna/)).toBeNull();
    expect(chimeMock.playChime).toHaveBeenCalledTimes(1);
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

  it("offers under Unread only the sources with something unread, and keeps the chosen one", async () => {
    const items = [notification("a"), notification("b", { source: "DESIGN", title: "Logo" }), notification("c", { status: "READ", source: "ROOM_AGENT", title: "Bob is waiting" })];
    apiMock.notificationsPending.mockResolvedValue(pending(items));
    apiMock.notifications.mockResolvedValue({ notifications: items });
    render(<NotificationCenterDock />);
    const sourceChips = async () => within(await screen.findByRole("group", { name: "Source" })).getAllByRole("button").map((chip) => chip.textContent);
    expect(await sourceChips()).toEqual(["All", "Mail Copilot1", "Design1"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "All" }));
    expect(await sourceChips()).toEqual(["All", "Mail Copilot1", "Design1", "Room Agent0"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Source" })).getByRole("button", { name: "Room Agent0" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: /Unread/ }));
    expect(await sourceChips()).toEqual(["All", "Mail Copilot1", "Design1", "Room Agent0"]);
  });

  it("groups a pane's notifications under Nous's card, opens that pane through Nous focus and delivers a new list once more (plan clipboard:8FfXWclYUfOH)", async () => {
    const card = (alertAt: string) => notification("nous", { source: "NOUS", kind: "NEEDS_HANDS", title: "Upwork needs you", body: "• Pass the Cloudflare check",
      dedupeKey: "nous:pane:pane:mail", link: { roomId: "room:1", paneId: "pane:mail" }, payload: { alertAt } });
    const items = [card("2026-10-17T14:00:00.000Z"), notification("a"), notification("c", { paneId: "pane:other", title: "Other pane" })];
    apiMock.notificationsPending.mockResolvedValue(pending(items));
    apiMock.notifications.mockResolvedValue({ notifications: items });
    const navigate = vi.fn();
    setNotificationNavigator(navigate);
    render(<NotificationCenterDock />);
    const list = (await screen.findAllByRole("list"))[0]!;
    await waitFor(() => expect(list.querySelectorAll(":scope > li")).toHaveLength(2));
    fireEvent.click(within(list).getByRole("button", { name: "Show 1 more from this pane" }));
    expect(within(screen.getByRole("list", { name: "More from this pane" })).getByRole("button", { name: "Unread: Mail Copilot: Anna Papadopoulou" })).toBeTruthy();

    const focused: NousFocusDetail[] = [];
    const onFocus = (event: Event) => focused.push((event as CustomEvent<NousFocusDetail>).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    fireEvent.click(within(list).getByRole("button", { name: "Unread: Nous: Upwork needs you" }));
    window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    expect(focused).toEqual([{ roomId: "room:1", paneId: "pane:mail", immediate: true, notification: expect.objectContaining({ id: "notification:nous" }) }]);
    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock.markNotificationRead).toHaveBeenCalledWith("notification:nous"));

    const delivered = vi.fn();
    setNotificationDeliveryHandler(delivered);
    await refreshNotifications();
    expect(delivered).not.toHaveBeenCalled();
    const relisted = [card("2026-10-17T14:05:00.000Z"), ...items.slice(1)];
    apiMock.notificationsPending.mockResolvedValue(pending(relisted));
    apiMock.notifications.mockResolvedValue({ notifications: relisted });
    await refreshNotifications();
    expect(delivered).toHaveBeenCalledWith([expect.objectContaining({ id: "notification:nous" })]);
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

  it("inside an Android app with Firebase the device switch registers its push token, keeps it registered and removes it; elsewhere there is no push switch", async () => {
    apiMock.userSettings.mockResolvedValue({ notifications: null });
    apiMock.registerPushDevice.mockResolvedValue({ registered: true, available: false });
    apiMock.removePushDevice.mockResolvedValue({ removed: true });
    const { unmount } = render(<NotificationSettingsCard suppressNotifications={false} onSuppressNotificationsChange={vi.fn()} />);
    await waitFor(() => expect(apiMock.userSettings).toHaveBeenCalled());
    expect(screen.queryByRole("switch", { name: "Push notifications on this device" })).toBeNull();
    unmount();
    const token = `fcm:${"t".repeat(40)}`;
    const native = { notify: vi.fn(() => true), notificationsAllowed: vi.fn(() => false), requestNotificationPermission: vi.fn(() => false), takePendingNotification: vi.fn(() => null),
      pushToken: vi.fn(() => token), appVersion: vi.fn(() => "0.1.24") };
    (window as unknown as { SpaceNative?: unknown }).SpaceNative = native;
    try {
      render(<NotificationSettingsCard suppressNotifications={false} onSuppressNotificationsChange={vi.fn()} />);
      const push = await screen.findByRole("switch", { name: "Push notifications on this device" });
      await waitFor(() => expect((push as HTMLInputElement).disabled).toBe(false));
      fireEvent.click(push);
      await waitFor(() => expect(apiMock.registerPushDevice).toHaveBeenCalledWith({ token, platform: "ANDROID", appVersion: "0.1.24" }));
      expect(native.requestNotificationPermission).toHaveBeenCalled();
      expect(await screen.findByText(/no push key yet/)).toBeTruthy();
      expect(screen.getAllByRole("switch", { name: "Push" })).toHaveLength(NOTIFICATION_SOURCES.length); // one per notification source
      // A new token from Firebase (or the next start) registers again while the switch is on.
      apiMock.registerPushDevice.mockClear();
      const unsubscribe = subscribePushTokenRegistration(apiMock);
      expect(apiMock.registerPushDevice).toHaveBeenCalledTimes(1);
      (window as unknown as { __spacePushToken?: () => void }).__spacePushToken?.();
      expect(apiMock.registerPushDevice).toHaveBeenCalledTimes(2);
      unsubscribe();
      fireEvent.click(screen.getByRole("switch", { name: "Push notifications on this device" }));
      await waitFor(() => expect(apiMock.removePushDevice).toHaveBeenCalledWith(token));
      expect(window.localStorage.getItem("space.notifications.push")).toBe("off");
    } finally {
      delete (window as unknown as { SpaceNative?: unknown }).SpaceNative;
      window.localStorage.removeItem("space.notifications.push");
    }
  });
});
