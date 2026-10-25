import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountSummary, MailLabel, MailMessage, MailThreadSummary } from "@space/contracts";
import { Composer, MailClient, composeDraft, mailTime, replyRecipients } from "../src/features/mail-copilot-pane/MailClient.js";
import { useMailbox } from "../src/features/mail-copilot-pane/useMailbox.js";

const apiMock = vi.hoisted(() => ({
  mailAccounts: vi.fn(), mailLabels: vi.fn(), mailThreads: vi.fn(), mailThread: vi.fn(), modifyMailThread: vi.fn(), sendMail: vi.fn(), saveMailDraft: vi.fn(),
  updateMailCopilotView: vi.fn(), requestMailFix: vi.fn(), mailAttachmentUrl: (paneId: string | undefined, account: string, messageId: string, attachmentId: string) => `/api/mail-copilot/messages/${messageId}/attachments/${attachmentId}?account=${account}`
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const accounts: MailAccountSummary[] = [
  { email: "me@gmail.com", access: "full", inPane: true, unread: 2, error: null },
  { email: "work@gmail.com", access: "read", inPane: true, unread: 0, error: null }
];
const labels: MailLabel[] = [{ id: "INBOX", name: "Inbox", type: "system", unread: 2 }, { id: "STARRED", name: "Starred", type: "system", unread: null }, { id: "Clients", name: "Clients", type: "user", unread: 1 }];
const now = new Date().toISOString();
const rows: MailThreadSummary[] = [
  { account: "me@gmail.com", threadId: "t1", messageId: "m1", from: { name: "Anna", address: "anna@acme.com" }, subject: "Invoice", snippet: "Please find", receivedAt: now, unread: true, starred: false, hasAttachment: true, messageCount: 2, labelIds: ["INBOX", "UNREAD"] },
  { account: "work@gmail.com", threadId: "wt1", messageId: "w1", from: { name: "", address: "boss@corp.example" }, subject: "Standup", snippet: "9am", receivedAt: now, unread: false, starred: true, hasAttachment: false, messageCount: 1, labelIds: ["INBOX"] }
];
const message: MailMessage = {
  account: "me@gmail.com", messageId: "m1", threadId: "t1", from: { name: "Anna", address: "anna@acme.com" }, to: [{ name: "Me", address: "me@gmail.com" }, { name: "Carl", address: "carl@acme.com" }], cc: [], replyTo: [],
  subject: "Invoice", receivedAt: now, rfcMessageId: "<m1@x>", references: null, labelIds: ["INBOX"], unread: false, starred: false,
  text: "Please find the invoice.", html: "<p>Please find the <b>invoice</b>.</p>", blockedImages: true,
  attachments: [{ attachmentId: "a1", filename: "invoice.pdf", mimeType: "application/pdf", size: 2048, contentId: null }]
};

function Harness({ stacked = false }: { stacked?: boolean }) {
  const mailbox = useMailbox("pane:mail00001", true);
  return <MailClient paneId="pane:mail00001" mailbox={mailbox} signature="-- Nik" stacked={stacked} />;
}

describe("MailClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mailAccounts.mockResolvedValue({ accounts });
    apiMock.mailLabels.mockResolvedValue({ labels });
    apiMock.mailThreads.mockResolvedValue({ threads: rows, nextPageToken: "page2", errors: [] });
    apiMock.mailThread.mockResolvedValue({ thread: { account: "me@gmail.com", threadId: "t1", subject: "Invoice", messages: [{ ...message, messageId: "m0", unread: false, html: null, text: "Earlier" }, message] } });
    apiMock.modifyMailThread.mockResolvedValue({ ok: true });
    apiMock.sendMail.mockResolvedValue({ messageId: "sent", threadId: "t1" });
    apiMock.saveMailDraft.mockResolvedValue({ draftId: "d", messageId: "dm" });
    apiMock.updateMailCopilotView.mockResolvedValue({ view: null });
  });
  afterEach(() => cleanup());

  it("shows the unified inbox with labels, account dots, unread rows and paging", async () => {
    render(<Harness />);
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenCalledWith("pane:mail00001", { account: "all", labelId: "INBOX", q: undefined }));
    const list = await screen.findByRole("list", { name: "Inbox conversations" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.className).toContain("unread");
    expect(within(items[0]!).getByRole("button", { name: "Unread: Anna: Invoice" })).toBeTruthy();
    expect(within(items[0]!).getByLabelText("Has attachment")).toBeTruthy();
    expect(within(items[1]!).getByRole("button", { name: "boss@corp.example: Standup" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Inbox/ }).getAttribute("aria-selected")).toBe("true");
    // User labels sit in a picker that stays visible beside the scrolling chips.
    expect(screen.queryByRole("tab", { name: /Clients/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Show label" }), { target: { value: "Clients" } });
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenLastCalledWith("pane:mail00001", { account: "all", labelId: "Clients", q: undefined }));
    expect(screen.getByRole("combobox", { name: "Show label" }).closest("label")!.className).toContain("selected");
    fireEvent.click(screen.getByRole("tab", { name: /Starred/ }));
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenLastCalledWith("pane:mail00001", { account: "all", labelId: "STARRED", q: undefined }));
    fireEvent.change(screen.getByRole("combobox", { name: "Account" }), { target: { value: "work@gmail.com" } });
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenLastCalledWith("pane:mail00001", { account: "work@gmail.com", labelId: "STARRED", q: undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenLastCalledWith("pane:mail00001", { account: "work@gmail.com", labelId: "STARRED", q: undefined, pageToken: "page2" }));
    // The server learns what the operator looks at.
    await waitFor(() => expect(apiMock.updateMailCopilotView).toHaveBeenCalledWith("pane:mail00001", expect.objectContaining({ account: "work@gmail.com", labelId: "STARRED" })));
  });

  it("searches, opens a conversation (marking it read), shows the newest message expanded with attachments, and acts on it", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), { target: { value: "invoice" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(apiMock.mailThreads).toHaveBeenLastCalledWith("pane:mail00001", { account: "all", labelId: "INBOX", q: "invoice" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unread: Anna: Invoice" }));
    await waitFor(() => expect(apiMock.mailThread).toHaveBeenCalledWith("pane:mail00001", "me@gmail.com", "t1", false));
    expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "read" });
    expect(await screen.findByRole("heading", { name: "Invoice" })).toBeTruthy();
    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(2);
    expect(articles[0]!.className).not.toContain("expanded");
    expect(articles[1]!.className).toContain("expanded");
    expect(within(articles[1]!).getByTitle("Message from Anna").getAttribute("sandbox")).toBe("");
    expect(within(articles[1]!).getByRole("link", { name: /invoice\.pdf/ }).getAttribute("href")).toBe("/api/mail-copilot/messages/m1/attachments/a1?account=me@gmail.com");
    fireEvent.click(within(articles[1]!).getByRole("button", { name: "Load images" }));
    await waitFor(() => expect(apiMock.mailThread).toHaveBeenLastCalledWith("pane:mail00001", "me@gmail.com", "t1", true));
    fireEvent.click(screen.getByRole("button", { name: "Archive conversation" }));
    await waitFor(() => expect(apiMock.modifyMailThread).toHaveBeenLastCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "archive" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Anna: Invoice/ })).toBeNull());
  });

  it("sends the open conversation to the AI with an optional note to check and fix what it needs", async () => {
    apiMock.requestMailFix.mockResolvedValue({ event: { id: "mailevt:e1" }, runStarted: true });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Unread: Anna: Invoice" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send conversation to AI" }));
    const sheet = screen.getByRole("form", { name: "Send to AI" });
    fireEvent.change(within(sheet).getByRole("textbox", { name: "What should the copilot check or fix?" }), { target: { value: "Why was it charged twice?" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(apiMock.requestMailFix).toHaveBeenCalledWith("pane:mail00001", { account: "me@gmail.com", threadId: "t1", note: "Why was it charged twice?" }));
    expect(await screen.findByText("Sent to the copilot: it checks and fixes what this mail needs.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Send to AI" })).toBeNull();
  });

  it("moves the open conversation to a user label: out of the inbox and closed", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Unread: Anna: Invoice" }));
    const move = await screen.findByRole("combobox", { name: "Move to" });
    expect(within(move).getAllByRole("option").map((option) => option.textContent)).toEqual(["Move to…", "Clients"]);
    fireEvent.change(move, { target: { value: "Clients" } });
    await waitFor(() => expect(apiMock.modifyMailThread).toHaveBeenLastCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "move", labelIds: ["Clients"] }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Anna: Invoice/ })).toBeNull());
    expect(screen.queryByRole("combobox", { name: "Move to" })).toBeNull();
  });

  it("replies from the conversation with quoted text, threading ids and the signature, and sends", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Unread: Anna: Invoice" }));
    const article = (await screen.findAllByRole("article"))[1]!;
    fireEvent.click(within(article).getByRole("button", { name: "Reply all" }));
    const form = await screen.findByRole("form", { name: "Reply all" });
    expect((within(form).getByRole("textbox", { name: "To" }) as HTMLInputElement).value).toBe("anna@acme.com");
    expect((within(form).getByRole("textbox", { name: "Cc" }) as HTMLInputElement).value).toBe("carl@acme.com");
    expect((within(form).getByRole("textbox", { name: "Subject" }) as HTMLInputElement).value).toBe("Re: Invoice");
    const body = within(form).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(body.value).toContain("-- Nik");
    expect(body.value).toContain("> Please find the invoice.");
    fireEvent.change(body, { target: { value: "Received, thanks.\n\n-- Nik" } });
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Send" })); });
    await waitFor(() => expect(apiMock.sendMail).toHaveBeenCalledWith("pane:mail00001", {
      account: "me@gmail.com", to: ["anna@acme.com"], cc: ["carl@acme.com"], bcc: [], subject: "Re: Invoice", text: "Received, thanks.\n\n-- Nik", threadId: "t1", inReplyToMessageId: "m1"
    }));
    expect(await screen.findByText("Sent.")).toBeTruthy();
  });

  it("composes new mail from a full-access account only, and saves drafts", async () => {
    const onClose = vi.fn();
    const onSent = vi.fn();
    render(<Composer mode={{ kind: "new" }} accounts={accounts} defaultAccount="me@gmail.com" signature={null} paneId="pane:mail00001" onClose={onClose} onSent={onSent} />);
    const from = screen.getByRole("combobox", { name: "From account" }) as HTMLSelectElement;
    expect(Array.from(from.options).map((option) => option.value)).toEqual(["me@gmail.com"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    expect((await screen.findByRole("alert")).textContent).toContain("Add at least one recipient.");
    fireEvent.change(screen.getByRole("textbox", { name: "To" }), { target: { value: "x@y.com; bad, z@w.org" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "Hello" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Body" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    await waitFor(() => expect(apiMock.saveMailDraft).toHaveBeenCalledWith("pane:mail00001", { account: "me@gmail.com", to: ["x@y.com", "z@w.org"], cc: [], bcc: [], subject: "Hello", text: "Body" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("stacks on phones: list first, then the conversation with a Back button", async () => {
    render(<Harness stacked />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    expect(screen.queryByText("Pick a conversation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unread: Anna: Invoice" }));
    expect(await screen.findByRole("heading", { name: "Invoice" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Inbox conversations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("list", { name: "Inbox conversations" })).toBeTruthy();
  });

  it("archives a row by swiping it on phones and undoes it from the snackbar; a swipe never opens the conversation", async () => {
    render(<Harness stacked />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    const row = screen.getByRole("button", { name: "Unread: Anna: Invoice" }).closest("[role='listitem']") as HTMLElement;
    // Wide-pane hover actions are not offered on phones; the swipe replaces them.
    expect(row.querySelector(".mc-thread-actions")).not.toBeNull();
    fireEvent.pointerDown(row, { pointerId: 7, pointerType: "touch", clientX: 10, clientY: 40 });
    fireEvent.pointerMove(row, { pointerId: 7, pointerType: "touch", clientX: 90, clientY: 42 });
    expect(row.querySelector(".mc-swipe-reveal")?.textContent).toContain("Archive");
    fireEvent.pointerMove(row, { pointerId: 7, pointerType: "touch", clientX: 170, clientY: 42 });
    await act(async () => { fireEvent.pointerUp(row, { pointerId: 7, pointerType: "touch", clientX: 170, clientY: 42 }); });
    fireEvent.click(within(row).getByRole("button", { name: "Unread: Anna: Invoice" }));
    expect(apiMock.mailThread).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "archive" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Anna: Invoice/ })).toBeNull());
    const snackbar = screen.getByText("Archived").closest("[role='status']") as HTMLElement;
    const listCalls = apiMock.mailThreads.mock.calls.length;
    await act(async () => { fireEvent.click(within(snackbar).getByRole("button", { name: "Undo" })); });
    expect(apiMock.modifyMailThread).toHaveBeenLastCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "unarchive" });
    await waitFor(() => expect(apiMock.mailThreads.mock.calls.length).toBeGreaterThan(listCalls));
    // A short or vertical drag is a tap or a scroll, not an archive.
    const other = screen.getByRole("button", { name: "boss@corp.example: Standup" }).closest("[role='listitem']") as HTMLElement;
    apiMock.modifyMailThread.mockClear();
    fireEvent.pointerDown(other, { pointerId: 8, pointerType: "touch", clientX: 10, clientY: 40 });
    fireEvent.pointerMove(other, { pointerId: 8, pointerType: "touch", clientX: 14, clientY: 120 });
    fireEvent.pointerUp(other, { pointerId: 8, pointerType: "touch", clientX: 14, clientY: 120 });
    fireEvent.pointerDown(other, { pointerId: 9, pointerType: "touch", clientX: 10, clientY: 40 });
    fireEvent.pointerMove(other, { pointerId: 9, pointerType: "touch", clientX: 60, clientY: 40 });
    fireEvent.pointerUp(other, { pointerId: 9, pointerType: "touch", clientX: 60, clientY: 40 });
    expect(apiMock.modifyMailThread).not.toHaveBeenCalled();
  });

  it("offers star, archive, trash and read state on wide panes and decorates rows with sender avatars", async () => {
    render(<Harness />);
    const list = await screen.findByRole("list", { name: "Inbox conversations" });
    const first = within(list).getAllByRole("listitem")[0]!;
    expect(first.querySelector(".mc-avatar")?.textContent).toBe("A");
    // Two accounts in the pane: the avatar carries the account's color dot.
    expect(first.querySelector(".mc-avatar-account")?.getAttribute("title")).toBe("me@gmail.com");
    fireEvent.click(within(first).getByRole("button", { name: "Star" }));
    await waitFor(() => expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "star" }));
    fireEvent.click(within(first).getByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "read" }));
    await act(async () => { fireEvent.click(within(first).getByRole("button", { name: "Trash" })); });
    expect(await screen.findByText("Moved to trash")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compose" })).toBeTruthy();
  });

  it("selects conversations by their avatar and acts on all of them from the selection bar, with one undo", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    const first = screen.getByRole("button", { name: "Select Anna: Invoice" });
    fireEvent.click(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(first.closest("[role='listitem']")?.querySelector(".mc-avatar.checked")).not.toBeNull();
    // Selecting does not open the conversation; the search bar becomes the selection bar.
    expect(apiMock.mailThread).not.toHaveBeenCalled();
    const bar = screen.getByRole("toolbar", { name: "Selected conversations" });
    expect(screen.queryByRole("search")).toBeNull();
    expect(within(bar).getByText("1 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Select all" }));
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    // Gmail's rule: any unread marks all read; star unless all are starred.
    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: "Mark as read" })); });
    expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "read" });
    expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "wt1", { account: "work@gmail.com", action: "read" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    expect(within(bar).getAllByRole("combobox", { name: "Move selected to" })).toHaveLength(1);
    apiMock.modifyMailThread.mockClear();
    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: "Trash selected" })); });
    expect(apiMock.modifyMailThread.mock.calls.map((call) => call[1])).toEqual(["t1", "wt1"]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Anna: Invoice|Standup/ })).toBeNull());
    expect(screen.getByRole("search")).toBeTruthy();
    const snackbar = screen.getByText("Moved to trash · 2 conversations").closest("[role='status']") as HTMLElement;
    await act(async () => { fireEvent.click(within(snackbar).getByRole("button", { name: "Undo" })); });
    expect(apiMock.modifyMailThread).toHaveBeenCalledWith("pane:mail00001", "t1", { account: "me@gmail.com", action: "untrash" });
    expect(apiMock.modifyMailThread).toHaveBeenLastCalledWith("pane:mail00001", "wt1", { account: "work@gmail.com", action: "untrash" });
    // Rows that come back after an undo are not selected any more.
    expect((await screen.findByRole("button", { name: "Select Anna: Invoice" })).getAttribute("aria-pressed")).toBe("false");
  });

  it("reports the conversations a selection action could not change and keeps them selected", async () => {
    render(<Harness />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    fireEvent.click(screen.getByRole("button", { name: "Select Anna: Invoice" }));
    fireEvent.click(screen.getByRole("button", { name: "Select boss@corp.example: Standup" }));
    apiMock.modifyMailThread.mockImplementation(async (_pane: string, threadId: string) => { if (threadId === "wt1") throw new Error("Read-only account"); return { ok: true }; });
    const bar = screen.getByRole("toolbar", { name: "Selected conversations" });
    await act(async () => { fireEvent.click(within(bar).getByRole("button", { name: "Archive selected" })); });
    expect(screen.getByText("1 of 2 conversations failed: Read-only account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Anna: Invoice/ })).toBeNull();
    expect(within(screen.getByRole("toolbar", { name: "Selected conversations" })).getByText("1 selected")).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
  });

  it("resizes the list against the conversation by dragging or with the arrow keys, remembers it per pane and resets on double-click", async () => {
    window.localStorage.removeItem("space:mail-copilot:list-width:pane:mail00001");
    const view = render(<Harness />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    const client = document.querySelector(".mc-client") as HTMLElement;
    client.getBoundingClientRect = () => ({ width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    const splitter = screen.getByRole("separator", { name: "Resize the conversation list" });
    (splitter.previousElementSibling as HTMLElement).getBoundingClientRect = () => ({ width: 480, height: 800, top: 0, left: 0, right: 480, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(splitter, { pointerId: 1, clientX: 480 });
    expect(client.dataset.resizing).toBe("true");
    fireEvent.pointerMove(splitter, { pointerId: 1, clientX: 600 });
    fireEvent.pointerUp(splitter, { pointerId: 1, clientX: 600 });
    expect(client.style.getPropertyValue("--mc-list-width")).toBe("max(260px, min(600px, calc(100% - 320px)))");
    expect(window.localStorage.getItem("space:mail-copilot:list-width:pane:mail00001")).toBe("600");
    // The conversation keeps 320px: dragging past it stops there; the keyboard moves 16px (64 with Shift).
    fireEvent.pointerDown(splitter, { pointerId: 2, clientX: 600 });
    fireEvent.pointerMove(splitter, { pointerId: 2, clientX: 1190 });
    fireEvent.pointerUp(splitter, { pointerId: 2, clientX: 1190 });
    expect(window.localStorage.getItem("space:mail-copilot:list-width:pane:mail00001")).toBe("880");
    fireEvent.keyDown(splitter, { key: "ArrowLeft", shiftKey: true });
    expect(window.localStorage.getItem("space:mail-copilot:list-width:pane:mail00001")).toBe("816");
    fireEvent.keyDown(splitter, { key: "Home" });
    expect(window.localStorage.getItem("space:mail-copilot:list-width:pane:mail00001")).toBe("260");
    // Reopening the pane keeps the width; a double-click goes back to the default split.
    view.unmount();
    render(<Harness />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    expect((document.querySelector(".mc-client") as HTMLElement).style.getPropertyValue("--mc-list-width")).toContain("min(260px");
    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize the conversation list" }));
    expect((document.querySelector(".mc-client") as HTMLElement).style.getPropertyValue("--mc-list-width")).toBe("");
    expect(window.localStorage.getItem("space:mail-copilot:list-width:pane:mail00001")).toBeNull();
    cleanup();
    // Phones show one column at a time and have no splitter.
    render(<Harness stacked />);
    await screen.findByRole("list", { name: "Inbox conversations" });
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("derives reply recipients, compose drafts and short times", () => {
    expect(replyRecipients(message, false)).toEqual({ to: ["anna@acme.com"], cc: [] });
    expect(replyRecipients(message, true)).toEqual({ to: ["anna@acme.com"], cc: ["carl@acme.com"] });
    expect(replyRecipients({ ...message, replyTo: [{ name: "", address: "billing@acme.com" }] }, false)).toEqual({ to: ["billing@acme.com"], cc: [] });
    const forward = composeDraft({ kind: "forward", message: { ...message, subject: "Re: Fwd: Invoice" } }, "me@gmail.com", null);
    expect(forward.subject).toBe("Fwd: Invoice");
    expect(forward.text).toContain("---------- Forwarded message ----------\nFrom: Anna <anna@acme.com>");
    expect(forward.threadId).toBeUndefined();
    expect(composeDraft({ kind: "new" }, "me@gmail.com", "-- Nik").text).toBe("\n\n-- Nik");
    const today = Date.parse("2026-10-13T10:30:00.000Z");
    expect(mailTime(new Date(today - 3600_000).toISOString(), today)).toMatch(/\d/);
    expect(mailTime(new Date(today - 3 * 86_400_000).toISOString(), today)).toMatch(/^[A-Z][a-z]{2}$/);
    expect(mailTime(null, today)).toBe("");
  });
});
