// Mail Copilot → Campaigns (plan clipboard:IJ2ovfLg1Lbw step 9): the operator reads every mail of a campaign (list, search, next and
// previous, text and HTML) and their Approve carries the fingerprint of exactly the mails they read; a campaign that changed meanwhile
// cannot be approved until it is read again.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CampaignsTab } from "../src/features/mail-copilot-pane/CampaignsTab.js";
import { resetNousReviewing } from "../src/features/copilot-kit/nous-reviewing.js";

const apiMock = vi.hoisted(() => ({
  mailCampaigns: vi.fn(), mailCampaign: vi.fn(), mailCampaignChecks: vi.fn(), mailCampaignPreview: vi.fn(), mailCampaignPreviewMail: vi.fn(), decideMailCampaign: vi.fn(),
  mailCampaignControl: vi.fn(), mailCampaignLists: vi.fn(), mailCampaignListContacts: vi.fn(), mailCampaignSuppressions: vi.fn(), mailCampaignTemplates: vi.fn(),
  mailCampaignTemplate: vi.fn(), mailCampaignSenders: vi.fn(), setMailSenderWarmup: vi.fn(), setMailSenderBulk: vi.fn(),
  nousApprovals: vi.fn(async () => ({ nousReviewing: false }))
}));
vi.mock("../src/api.js", () => ({ api: apiMock }));

const fingerprint = "f".repeat(64);
const campaign = { id: "mcamp:abcdefgh", ownerUserId: "user:o", paneId: null, name: "oll4 support", goal: "", templateId: "mtpl:abcdefgh", templateVersion: 1, senderId: "msender:abcdefgh",
  listIds: ["mlist:abcdefgh"], schedule: { startAt: null, timeZone: "Europe/Athens", days: [1, 2, 3, 4, 5], fromHour: 9, toHour: 18 },
  pacing: { perMinute: 1, perDay: 90, intervalSeconds: 360, maxHardBounces: 3 }, status: "IN_REVIEW", fingerprint, approval: null, audience: null, testSeeds: [], pauseReason: null,
  createdBy: "t", createdAt: "2026-10-29T10:00:00.000Z", updatedAt: "2026-10-29T10:00:00.000Z" };
const items = [
  { index: 0, contactId: "mcontact:aaaaaaaa", address: "z@shop-z.gr", name: "Z", priority: 0, subject: "Τεχνική παρατήρηση για το shop-z.gr" },
  { index: 1, contactId: "mcontact:bbbbbbbb", address: "a@shop-a.gr", name: "A", priority: 1, subject: "Τεχνική παρατήρηση για το shop-a.gr" }
];
const mailFor = (index: number, print = fingerprint) => ({ fingerprint: print, index, total: 2, previous: index ? items[0]!.contactId : null, next: index ? null : items[1]!.contactId,
  contactId: items[index]!.contactId, to: items[index]!.address, name: items[index]!.name, priority: items[index]!.priority, from: "Νικόλαος Θεοδωρόπουλος | oll4.com <ntheo@example.invalid>",
  replyTo: null, subject: items[index]!.subject, preheader: "", html: "<p>html</p>", text: `Καλημέρα, ${items[index]!.address}`, renderHash: "h" });

beforeEach(() => {
  apiMock.mailCampaigns.mockResolvedValue({ campaigns: [campaign] });
  apiMock.mailCampaign.mockResolvedValue({ campaign, stats: { byStatus: {}, bounced: { hard: 0, soft: 0 }, complained: 0, replied: 0, unsubscribed: 0 }, recent: [] });
  apiMock.mailCampaignChecks.mockResolvedValue({ fingerprint, current: [], older: [] });
  apiMock.mailCampaignPreview.mockResolvedValue({ fingerprint, total: 2, matched: 2, skipped: { suppressed: 1 }, status: "IN_REVIEW", items });
  apiMock.mailCampaignPreviewMail.mockImplementation(async (_id: string, contactId: string) => mailFor(items.findIndex((item) => item.contactId === contactId)));
  apiMock.decideMailCampaign.mockResolvedValue({ display: "Approved", campaign: { ...campaign, status: "APPROVED" } });
  apiMock.nousApprovals.mockResolvedValue({ nousReviewing: false });
  resetNousReviewing();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Campaigns tab", () => {
  it("shows every mail with next and previous, and approves with the fingerprint of what was read", async () => {
    render(<CampaignsTab isVisible target={{ id: campaign.id, at: 1 }} />);
    expect(await screen.findByText("Mail 1 of 2")).toBeTruthy();
    // Redesign 2/11: a mail opens as the whole rendered mail (sandboxed: no scripts, no same-origin cookie), plain text one tab away.
    expect(screen.getByTitle("HTML of the mail to z@shop-z.gr").getAttribute("sandbox")).toBe("");
    expect(screen.getByLabelText("In the inbox").textContent).toContain("Τεχνική παρατήρηση για το shop-z.gr");
    expect(screen.getByText(/one every 6 min, at most 90 a day · stops after 3 hard bounces/)).toBeTruthy();
    expect(screen.getByText("Left out: 1 suppressed")).toBeTruthy();
    expect(screen.getByText("You opened 1 of 2 mails")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Plain text" }));
    expect(screen.getByText("Καλημέρα, z@shop-z.gr")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Καλημέρα, a@shop-a.gr")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTitle("HTML of the mail to a@shop-a.gr")).toBeTruthy();
    expect(screen.getByText("You opened 2 of 2 mails")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Full view" }));
    expect(screen.getAllByTitle("HTML of the mail to a@shop-a.gr")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the mails" }), { target: { value: "shop-a" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(apiMock.mailCampaignPreview).toHaveBeenLastCalledWith(campaign.id, { q: "shop-a", offset: 0, limit: 50 }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, approve" }));
    await waitFor(() => expect(apiMock.decideMailCampaign).toHaveBeenCalledWith(campaign.id, { decision: "approve", fingerprint }));
  });

  it("leaves a campaign in review to Nous while May send is on: its mails stay readable, Approve and Decline are gone (operator 2/11 15:08 BKK)", async () => {
    apiMock.nousApprovals.mockResolvedValue({ nousReviewing: true });
    render(<CampaignsTab isVisible target={{ id: campaign.id, at: 1 }} />);
    expect(await screen.findByText("Mail 1 of 2")).toBeTruthy();
    expect(await screen.findByText(/Nous reads every mail and approves or declines this campaign/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  });

  it("keeps Approve off when the mails read are not the ones asked about", async () => {
    apiMock.mailCampaignPreviewMail.mockImplementation(async (_id: string, contactId: string) => mailFor(items.findIndex((item) => item.contactId === contactId), "e".repeat(64)));
    render(<CampaignsTab isVisible target={{ id: campaign.id, at: 1 }} />);
    expect(await screen.findByText(/changed while you read it/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(apiMock.decideMailCampaign).toHaveBeenCalledWith(campaign.id, { decision: "decline" }));
  });
});
