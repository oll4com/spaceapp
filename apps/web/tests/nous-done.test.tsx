import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceNotification } from "@space/contracts";
import { NousDone, useDoneRequests, useDoneView } from "../src/features/nous/NousDone.js";
import { consumeDoneView, requestDoneView } from "../src/features/nous/nous-done-events.js";
import { formatUserTime } from "../src/features/date-time-settings/date-time-settings.js";
import { api } from "../src/api.js";

const { storeItems } = vi.hoisted(() => ({ storeItems: [] as SpaceNotification[] }));
vi.mock("../src/api.js", () => ({ api: { notifications: vi.fn(), ackNotification: vi.fn(), deployQueueTicket: vi.fn() } }));
vi.mock("../src/features/notifications/notification-store.js", () => ({
  useNotificationStore: () => ({ items: storeItems }), refreshNotifications: vi.fn(), openNotification: vi.fn()
}));
afterEach(() => { cleanup(); consumeDoneView(); vi.clearAllMocks(); });
const at = new Date().toISOString();
const record = (patch: Partial<SpaceNotification> = {}): SpaceNotification => ({ id: "notification:done0001", ownerUserId: "user:operator", source: "NOUS", kind: "REQUEST_DONE", severity: "ATTENTION", title: "Your request is done", body: "Built it", link: { surface: "nous", target: "done" }, roomId: null, paneId: null, dedupeKey: "nous:done:clipboard:done0001", status: "READ", createdAt: at, updatedAt: at, readAt: at, ackedAt: null, resolvedAt: null,
  payload: { request: "Θέλω μία καρτέλα Done", summary: "Προστέθηκε η καρτέλα με επιβεβαίωση.", where: "dev", planId: "clipboard:done0001", tickets: ["q-20261029-060000-abcd"] }, ...patch });

describe("Nous Done tab", () => {
  it("shows the request, summary, operator time, live location and links; Got it removes it", async () => {
    const first = record();
    vi.mocked(api.ackNotification).mockResolvedValue({ notification: { ...first, status: "ACKED", ackedAt: at } });
    let items = [first];
    const onOpenPlan = vi.fn();
    const changed = vi.fn((next: SpaceNotification) => { items = items.map((item) => item.id === next.id ? next : item); });
    const { rerender } = render(<NousDone requests={items} onOpenPlan={onOpenPlan} onAcknowledged={changed} />);
    expect(screen.getByText("Θέλω μία καρτέλα Done")).toBeTruthy();
    expect(screen.getByText("Προστέθηκε η καρτέλα με επιβεβαίωση.")).toBeTruthy();
    expect(screen.getByText(formatUserTime(at))).toBeTruthy();
    expect(screen.getByText("Dev")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open plan" }));
    expect(onOpenPlan).toHaveBeenCalledWith("clipboard:done0001");
    expect(screen.getByRole("link", { name: "q-20261029-060000-abcd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: "ACKED" })));
    rerender(<NousDone requests={items} onOpenPlan={onOpenPlan} onAcknowledged={changed} />);
    expect(screen.queryByText("Θέλω μία καρτέλα Done")).toBeNull();
    expect(screen.queryByRole("region", { name: "Acknowledged" })).toBeNull();
    expect(screen.getByText("You’re up to date")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Got it" })).toBeNull();
  });

  it("keeps acknowledgement errors visible and the action available to retry", async () => {
    vi.mocked(api.ackNotification).mockRejectedValue(new Error("Connection lost"));
    const changed = vi.fn();
    render(<NousDone requests={[record()]} onOpenPlan={vi.fn()} onAcknowledged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Connection lost");
    expect(screen.getByRole("button", { name: "Got it" }).hasAttribute("disabled")).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("shows what Nous checked where the operator looks (repeat-mistake upgrade 31/10)", () => {
    render(<NousDone requests={[record({ payload: { ...record().payload, verified: "Requests tab on stable: In progress 11" } } as never)]} onOpenPlan={vi.fn()} onAcknowledged={vi.fn()} />);
    expect(screen.getByText("Checked: Requests tab on stable: In progress 11")).toBeTruthy();
  });

  it("opens the selected ticket, including an older ticket outside the recent queue list", async () => {
    vi.mocked(api.deployQueueTicket).mockResolvedValue({ ticket: { id: "q-20261029-060000-abcd", status: "DEPLOYED", summary: "Done tab deployed", note: "Verified" } as never });
    render(<NousDone requests={[record()]} onOpenPlan={vi.fn()} onAcknowledged={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: "q-20261029-060000-abcd" }));
    const details = await screen.findByRole("region", { name: "Ticket q-20261029-060000-abcd" });
    expect(within(details).getByText("Done tab deployed")).toBeTruthy();
    expect(api.deployQueueTicket).toHaveBeenCalledWith("q-20261029-060000-abcd");
  });

  it("honors a notification click before the lazy dock mounts, and subsequent clicks", () => {
    const open = vi.fn();
    requestDoneView();
    function View() { useDoneView(open); return null; }
    render(<View />);
    expect(open).toHaveBeenCalledTimes(1);
    requestDoneView();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("retries a failed list read without closing the dock", async () => {
    vi.mocked(api.notifications).mockRejectedValueOnce(new Error("Could not load")).mockResolvedValue({ notifications: [] });
    function View() { const done = useDoneRequests(true); return <NousDone requests={done.requests} error={done.error} onRetry={done.retry} onOpenPlan={vi.fn()} onAcknowledged={done.acknowledged} />; }
    render(<View />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("You’re up to date")).toBeTruthy();
  });

  it("counts OPEN and READ, hides every ACKED record and removes a successful acknowledgement before refreshing", async () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const first = record();
    vi.mocked(api.notifications).mockResolvedValue({ notifications: [first, record({ id: "notification:done0002", status: "OPEN", payload: { ...first.payload, request: "Another request" } }),
      record({ id: "notification:done0003", status: "ACKED", ackedAt: at, createdAt: old }), record({ id: "notification:done0004", status: "ACKED", ackedAt: old })] });
    vi.mocked(api.ackNotification).mockResolvedValue({ notification: { ...first, status: "ACKED", ackedAt: at } });
    function View() { const done = useDoneRequests(true); return <><span aria-label="Done count">{done.count}</span><NousDone requests={done.requests} error={done.error} onOpenPlan={vi.fn()} onAcknowledged={done.acknowledged} /></>; }
    render(<View />);
    await waitFor(() => expect(screen.getByLabelText("Done count").textContent).toBe("2"));
    expect(api.notifications).toHaveBeenCalledWith(expect.objectContaining({ source: "NOUS", kind: "REQUEST_DONE", status: "ALL" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Acknowledged" })).toBeNull();
    fireEvent.click(within(screen.getByRole("article", { name: "Θέλω μία καρτέλα Done" })).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.getByLabelText("Done count").textContent).toBe("1"));
    expect(screen.queryByText("Θέλω μία καρτέλα Done")).toBeNull();
    expect(screen.getByRole("article", { name: "Another request" })).toBeTruthy();
  });
});
