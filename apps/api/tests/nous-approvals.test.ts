import { describe, expect, it, vi } from "vitest";
import type { NousDecision } from "@space/contracts";
import { approvalStates, copilotSettlement, type ApprovalStores } from "../src/nous/approvals.js";

// Goal 84ba917a: «Approved but not done» from the rows that already exist.
const decision = (id: string, extra: Partial<NousDecision>): NousDecision => ({ id, ownerUserId: "user:o", category: "EXTERNAL", status: "APPROVED", title: id, body: "",
  recommendation: "", action: null, refs: {}, answer: "Approve", outcome: null, createdAt: "2026-11-05T08:00:00.000Z", answeredAt: "2026-11-05T09:00:00.000Z", ...extra } as NousDecision);
const review = (itemId: string, copilot = "MARKETING", item = "REVIEW", choice = "approve") => ({ type: "COPILOT", copilot, item, itemId, paneId: null, decision: choice }) as never;

describe("copilotSettlement (rule 1)", () => {
  it("is DONE at the state the decision asked for, VOID at another final state, nothing while under way", () => {
    expect(copilotSettlement(review("mktpost:a"), { status: "PUBLISHED", proof: "https://x.com/1" })).toEqual({ state: "DONE", proof: "https://x.com/1" });
    expect(copilotSettlement(review("mktpost:a"), { status: "SUPERSEDED", proof: "mktpost:a" })).toEqual({ state: "VOID", proof: "mktpost:a ended SUPERSEDED" });
    expect(copilotSettlement(review("mktpost:a", "MARKETING", "REVIEW", "reject"), { status: "REJECTED", proof: "mktpost:a" })?.state).toBe("DONE");
    expect(copilotSettlement(review("mktpost:a"), { status: "PENDING_REVIEW", proof: "mktpost:a" })).toBeNull();
    expect(copilotSettlement(review("mktpost:a"), { status: "PUBLISHED_NO_URL", proof: "mktpost:a" })).toBeNull();
    expect(copilotSettlement(review("lead:a", "FREELANCE", "LEAD", "won"), { status: "LOST", proof: "lead:a" })?.state).toBe("VOID");
    expect(copilotSettlement(review("mktpost:a"), null)).toBeNull();
  });
});

describe("approvalStates", () => {
  it("settles copilot decisions by their item and mail decisions by our send to the recipients", async () => {
    const posts: Record<string, { id: string; status: string; publishedUrl: string | null }> = {
      "mktpost:pub": { id: "mktpost:pub", status: "PUBLISHED", publishedUrl: "https://reddit.com/r/x/1" },
      "mktpost:bare": { id: "mktpost:bare", status: "SUPERSEDED", publishedUrl: null },
      "mktpost:wait": { id: "mktpost:wait", status: "APPROVED", publishedUrl: null }
    };
    const stores: ApprovalStores = {
      marketing: { getPost: vi.fn(async (_o: string, id: string) => posts[id] ?? null), listPosts: async () => [], listCampaigns: async () => [], listRules: async () => [] } as never,
      mail: { threadSend: vi.fn(async () => null), sentTo: vi.fn(async (_o: string, _a: string | null, to: string[]) => to.includes("b2b@vodafone.gr") ? { state: "SENT", account: "a", threadId: "t", messageId: "m" } : null),
        listEvents: async () => [], listRules: async () => [] } as never,
      job: { listEvents: async () => [{ type: "REVIEW_REQUESTED", applicationId: "job:1", payload: { reviewId: "jobrev:1" } }], getApplication: async () => ({ id: "job:1", status: "SUBMITTED", url: "https://jobs/1" }) } as never
    };
    const since = Date.parse("2026-11-01T00:00:00.000Z");
    const { sends, settled } = await approvalStates("user:o", [
      decision("nous_decision:pub", { action: review("mktpost:pub") }),
      decision("nous_decision:bare", { action: review("bare") }), // the itemId without its prefix (decision 153387ed)
      decision("nous_decision:wait", { action: review("mktpost:wait") }),
      decision("nous_decision:job", { action: review("jobrev:1", "JOB") }),
      decision("nous_decision:to", { refs: { recipients: ["b2b@vodafone.gr"] } }),
      decision("nous_decision:none", { refs: { recipients: ["nobody@x.com"] } }),
      decision("nous_decision:old", { action: review("mktpost:pub"), answeredAt: "2026-10-01T00:00:00.000Z" }),
      decision("nous_decision:internal", { category: "INTERNAL" as never, action: review("mktpost:pub") })
    ], since, stores);
    expect(settled).toEqual({ "nous_decision:pub": { state: "DONE", proof: "https://reddit.com/r/x/1" }, "nous_decision:bare": { state: "VOID", proof: "mktpost:bare ended SUPERSEDED" },
      "nous_decision:job": { state: "DONE", proof: "job:1 https://jobs/1" } });
    expect(sends).toEqual({ "nous_decision:to": "SENT" });
    expect(stores.mail!.sentTo).toHaveBeenCalledWith("user:o", null, ["b2b@vodafone.gr"], "2026-11-05T09:00:00.000Z");
  });

  it("audit 6/11 (operator «έφυγε στο τέλος»): a replacement post, an approved schedule and one send for duplicates settle it", async () => {
    // The real rows of approved-not-done-verified-20261106.md, cut to what the rules read.
    const post = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id: `mktpost:${id}`, channel: "X", target: null, title: null, status, publishedUrl: null,
      scheduledAt: null, createdAt: "2026-11-04T00:00:00.000Z", ...extra });
    const list = [
      post("cXBQgkVetcxE", "FAILED", { target: "x.com/i/status/1" }), // 153387ed's try that failed, re-filed …
      post("rOtYztiiIxt9", "PUBLISHED", { target: "x.com/i/status/1", createdAt: "2026-11-05T14:00:00.000Z", publishedUrl: "https://x.com/spaceapp_dev/status/2118352700022587744" }),
      post("FXtekInmGgmV", "SUPERSEDED", { channel: "REDDIT", target: "r/vibecoding" }), // 607c4881: re-filed as a draft that waits the mods
      post("IktZDQxmOjvx", "DRAFT", { channel: "REDDIT", target: "r/vibecoding", createdAt: "2026-11-04T16:00:00.000Z" }),
      post("yxRhsAAAAAAA", "FAILED", { channel: "REDDIT", title: "Vibe Art 8 [REPLACED by 5q-PL-RppA0S]" }), // 48a079f5: its slot passed, not published
      post("5q-PL-RppA0S", "APPROVED", { channel: "REDDIT", target: "r/ChatGPTCoding", scheduledAt: "2026-11-05T16:13:00.000Z" }),
      post("1VOZAQFJPDUN", "APPROVED", { channel: "LINKEDIN", scheduledAt: "2026-11-10T08:17:00.000Z" }), // b4e8eea8: waits for its date
      post("_qpjT825vzdL", "APPROVED", { channel: "LINKEDIN" })];
    const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
    const stores: ApprovalStores = {
      marketing: { getPost: async (_o: string, id: string) => byId[id] ?? null, listPosts: async (_o: string, filter: { channel?: string }) => list.filter((entry) => entry.channel === filter.channel),
        listCampaigns: async () => [], listRules: async () => [] } as never,
      mail: { threadSend: async () => null, sentTo: async () => null, listEvents: async () => [], listRules: async () => [] } as never
    };
    const hetzner = ["legal@hetzner.com", "info@hetzner.com"];
    const { settled, scheduled } = await approvalStates("user:o", [
      decision("nous_decision:153387ed", { action: review("cXBQgkVetcxE") }),
      decision("nous_decision:607c4881", { action: review("mktpost:FXtekInmGgmV") }),
      decision("nous_decision:48a079f5", { action: review("mktpost:yxRhsAAAAAAA") }),
      decision("nous_decision:b4e8eea8", { action: review("mktpost:1VOZAQFJPDUN") }),
      // Rule 5: Vibe Art 6 marked done once settles its duplicate; the Hetzner notice sent once settles the second decision for it.
      decision("nous_decision:c4fe6f12", { action: review("mktpost:_qpjT825vzdL"), outcome: "Done (marked by Nous): https://linkedin.com/pulse/x — 6/11 audit" }),
      decision("nous_decision:bbf2429b", { action: review("_qpjT825vzdL") }),
      decision("nous_decision:171a186a", { refs: { recipients: hetzner }, outcome: "Done (marked by Nous): thread 1a17b65672b48124 — 6/11 audit" }),
      decision("nous_decision:087b9f06", { refs: { recipients: ["Info@hetzner.com", "legal@hetzner.com"] } })
    ], Date.parse("2026-11-01T00:00:00.000Z"), stores);
    expect(settled).toEqual({
      "nous_decision:153387ed": { state: "DONE", proof: "https://x.com/spaceapp_dev/status/2118352700022587744" },
      "nous_decision:bbf2429b": { state: "DONE", proof: "https://linkedin.com/pulse/x (the same ask as nous_decision:c4fe6f12)" },
      "nous_decision:087b9f06": { state: "DONE", proof: "thread 1a17b65672b48124 (the same ask as nous_decision:171a186a)" } });
    expect(scheduled).toEqual({ "nous_decision:48a079f5": "2026-11-05T16:13:00.000Z", "nous_decision:b4e8eea8": "2026-11-10T08:17:00.000Z" });
  });
});

describe("audit 6/11 rule 4: a booking", () => {
  it("is done when the recipient's invitation or confirmation arrived after the approval (0f222670, Snyk)", async () => {
    const received = [
      { id: "mailevt:snyk", accountEmail: "ntheogr@gmail.com", threadId: "1a1a133553bfbc1d", messageId: "1a1a133553bfbc1d", type: "MAIL_RECEIVED", createdAt: "2026-11-03T11:37:00.000Z",
        payload: { from: { name: "Luke Baker", address: "Luke.Baker@snyk.io" }, subject: "Invitation from an unknown sender: Interview with Snyk | Luke Baker" } },
      { id: "mailevt:acme", accountEmail: "ntheogr@gmail.com", threadId: "t-acme", messageId: "m-acme", type: "MAIL_RECEIVED", createdAt: "2026-11-03T12:00:00.000Z",
        payload: { from: { address: "recruiter@acme.io" }, subject: "Thanks, talk soon" } }
    ];
    const threadSend = vi.fn(async () => null);
    const stores: ApprovalStores = { mail: { threadSend, sentTo: async () => null, listEvents: async () => received, listRules: async () => [] } as never };
    const booking = (id: string, recipients: string[]) => decision(id, { answeredAt: "2026-11-03T11:34:50.666Z",
      refs: { mailThread: { account: "ntheogr@gmail.com", threadId: "1a1a11f961c9e544" }, sendKind: "interview-booking", recipients } as never });
    const { settled } = await approvalStates("user:o", [booking("nous_decision:0f222670", ["luke.baker@snyk.io"]), booking("nous_decision:acme", ["recruiter@acme.io"])],
      Date.parse("2026-11-01T00:00:00.000Z"), stores);
    expect(settled).toEqual({ "nous_decision:0f222670": { state: "DONE",
      proof: "ntheogr@gmail.com message 1a1a133553bfbc1d: Invitation from an unknown sender: Interview with Snyk | Luke Baker" } });
    // A mail from the recipient that confirms nothing leaves the booking to the send checks.
    expect(threadSend).toHaveBeenCalledTimes(1);
  });
});

describe("goal 84ba917a 6/11: a marketing decision that names its post only in text", () => {
  it("finds the post in refs.copilotItem, a file name, the pane prompt, the title or the body, and settles it by the post", async () => {
    const post = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id: `mktpost:${id}`, channel: "X", target: null, title: null, status, publishedUrl: null,
      scheduledAt: null, createdAt: "2026-11-04T00:00:00.000Z", ...extra });
    // The operator's hand-settled rows of 6/11 02:15 BKK, cut to what the rules read.
    const list = [
      post("-fRz78yOWFiI", "PUBLISHED", { publishedUrl: "https://x.com/spaceapp_dev/status/2117636085522342116" }),
      post("_qpjT825vzdL", "PUBLISHED", { channel: "LINKEDIN", publishedUrl: "https://www.linkedin.com/pulse/spaceapp" }),
      post("t0lY7vZHlo5E", "PUBLISHED", { channel: "REDDIT", target: "r/selfhosted", publishedUrl: "https://reddit.com/r/selfhosted/comments/1xmwbwz" }),
      post("okjMe1wBosN8", "PUBLISHED", { channel: "DEVTO", publishedUrl: "https://dev.to/spaceapp/x" }),
      // 57ebdc91: the HN try failed and was re-filed under the same title at another target.
      post("eRUQon5wkmhX", "FAILED", { channel: "HN", target: "submit", title: "Show HN: SpaceApp" }),
      post("hnRefiled001", "PUBLISHED", { channel: "HN", target: "item", title: "Show HN: SpaceApp", createdAt: "2026-11-05T00:00:00.000Z",
        publishedUrl: "https://news.ycombinator.com/item?id=50365885" }),
      post("rejected0001", "REJECTED", { channel: "MASTODON" }),
      post("superseded01", "SUPERSEDED", { channel: "BLUESKY" })];
    const byId = Object.fromEntries(list.map((entry) => [entry.id, entry]));
    const stores: ApprovalStores = {
      marketing: { getPost: async (_o: string, id: string) => byId[id] ?? null, listPosts: async (_o: string, filter: { channel?: string }) => list.filter((entry) => entry.channel === filter.channel),
        listCampaigns: async () => [], listRules: async () => [] } as never
    };
    const failed = "Failed: This post is no longer waiting for a decision.";
    const x = { sendKind: "marketing-x", notificationId: "notif:1" } as never;
    const pane = (text: string) => ({ type: "PANE_TEXT", roomId: "room:m", paneId: "pane:m", text, mode: "SEND" }) as never;
    const { settled } = await approvalStates("user:o", [
      decision("nous_decision:482201cb50a4445cb4b8e7b9", { title: "Έγκριση X thread «Vibe Art 3» (mktpost:-fRz78yOWFiI)", refs: x, outcome: failed }),
      decision("nous_decision:new", { refs: { sendKind: "marketing-x", copilotItem: "mktpost:-fRz78yOWFiI" } as never }),
      decision("nous_decision:bbf2429b", { refs: { sendKind: "marketing-linkedin", files: ["nous/reviews/20261104-mktpost-_qpjT825vzdL.txt"] } as never, outcome: failed }),
      decision("nous_decision:7320c431", { action: pane("Approve mktpost:t0lY7vZHlo5E and publish it"), refs: x }),
      decision("nous_decision:ea97c021", { body: "The dev.to article mktpost:okjMe1wBosN8 is ready.", refs: x }),
      decision("nous_decision:57ebdc91", { title: "Show HN (mktpost:eRUQon5wkmhX)", refs: x }),
      decision("nous_decision:rejected", { title: "mktpost:rejected0001", refs: x }),
      decision("nous_decision:superseded", { title: "mktpost:superseded01", refs: x }),
      decision("nous_decision:none", { title: "Vibe Art 9 on X", refs: x })
    ], Date.parse("2026-11-01T00:00:00.000Z"), stores);
    expect(settled).toEqual({
      "nous_decision:482201cb50a4445cb4b8e7b9": { state: "DONE", proof: "https://x.com/spaceapp_dev/status/2117636085522342116" },
      "nous_decision:new": { state: "DONE", proof: "https://x.com/spaceapp_dev/status/2117636085522342116" },
      "nous_decision:bbf2429b": { state: "DONE", proof: "https://www.linkedin.com/pulse/spaceapp" },
      "nous_decision:7320c431": { state: "DONE", proof: "https://reddit.com/r/selfhosted/comments/1xmwbwz" },
      "nous_decision:ea97c021": { state: "DONE", proof: "https://dev.to/spaceapp/x" },
      "nous_decision:57ebdc91": { state: "DONE", proof: "https://news.ycombinator.com/item?id=50365885" },
      "nous_decision:rejected": { state: "VOID", proof: "mktpost:rejected0001 ended REJECTED" },
      "nous_decision:superseded": { state: "VOID", proof: "mktpost:superseded01 ended SUPERSEDED" } });
  });
});

describe("Nous 6/11 (nous_msg:d1325a00): a scheduled send is not owed before its date", () => {
  it("dates a batch by its title and settles a named mail campaign by its approval", async () => {
    const stores: ApprovalStores = {
      mailCampaigns: { campaigns: async () => [{ id: "mcamp:YDCUL_837XYf", status: "APPROVED", schedule: { startAt: "2026-11-12T07:00:00.000Z" } }] } as never,
      mail: { threadSend: async () => null, sentTo: async () => null, listEvents: async () => [], listRules: async () => [] } as never
    };
    const asked = { answeredAt: "2026-11-03T20:00:00.000Z", refs: { recipients: ["hello@oddbit.id"] } };
    const { settled, scheduled } = await approvalStates("user:o", [
      decision("nous_decision:a7a0a672", { ...asked, title: "Pilot παρτίδα 4: προγραμματισμός 20 mails για Δευτ. 9/11 και Τρ. 10/11" }),
      decision("nous_decision:8fe06919", { ...asked, title: "example.invalid: mail για τις παρτίδες στοκ σε 239 εταιρείες από 12/11, αφού το διαβάσεις;" }),
      decision("nous_decision:english", { ...asked, title: "Send the follow-up on Monday 10/11/2026" }),
      // A date before the approval, a date with no word that schedules it and «24/7» date nothing.
      decision("nous_decision:past", { ...asked, title: "Reply to the mail from 2/11" }),
      decision("nous_decision:bare", { ...asked, title: "Vibe Art 8 (5/12 16:13 UTC)" }),
      decision("nous_decision:always", { ...asked, title: "Offer for 24/7 support" }),
      decision("nous_decision:campaign", { ...asked, refs: {}, title: "Stock lots campaign", body: "Approve mcamp:YDCUL_837XYf (starts 12/11 09:00 Athens)." })
    ], Date.parse("2026-11-01T00:00:00.000Z"), stores);
    expect(scheduled).toEqual({ "nous_decision:a7a0a672": "2026-11-09T00:00:00.000Z", "nous_decision:8fe06919": "2026-11-12T00:00:00.000Z",
      "nous_decision:english": "2026-11-10T00:00:00.000Z" });
    expect(settled).toEqual({ "nous_decision:campaign": { state: "DONE", proof: "mcamp:YDCUL_837XYf" } });
  });
});
