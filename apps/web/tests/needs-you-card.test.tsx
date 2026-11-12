import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceNotification } from "@space/contracts";
import { NeedsYouCard } from "../src/features/needs-you/NeedsYouCard.js";
import { NOUS_FOCUS_EVENT } from "../src/features/nous-focus/nous-focus-events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Plan clipboard:ytwWl09xNH0Z (mockups approved 3/11 ~19:53 BKK): closed, a card is its title, ONE answer and Details; what it offers follows where
// the work is (off Space: done or a problem; here: its answer; in a pane: Go, only on his click).
const at = "2026-11-03T12:00:00.000Z";
const card = (patch: Partial<SpaceNotification>): SpaceNotification => ({
  id: "notification:card00000001", ownerUserId: "user:operator", roomId: "room:work000001", paneId: "pane:iris0000001", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION",
  title: "Iris needs you", body: "Install 0.2.13 on the phone\n1. Open the Play Store.\n2. Update SpaceApp.", link: { roomId: "room:work000001", paneId: "pane:iris0000001" },
  dedupeKey: null, status: "OPEN", createdAt: at, updatedAt: at, readAt: null, ackedAt: null, resolvedAt: null,
  payload: { paneMode: "TERMINAL", ask: { question: "Is 0.2.13 on the phone?", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "PANE" } } }, ...patch
} as SpaceNotification);
const closedButtons = () => within(screen.getByRole("article")).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

let answers: unknown[] = [];
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:card", headerName: "x-space-csrf-token" });
    if (url.endsWith("/answer")) { answers.push(JSON.parse(String(init?.body))); return Response.json({ display: "Sent to Iris." }); }
    return Response.json({ notifications: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("NeedsYouCard", () => {
  it("nous_msg:0cb8d563: a card's Agent Files are chips, closed or open, and a chip opens the Agent Files preview", async () => {
    const script = { id: "artifact:I2LCjrN6I0I8", roomId: "room:work000001", paneId: null, turnId: null, workflowId: null, kind: "EXPORT", mimeType: "text/markdown",
      storageUri: "space-artifact://agent-files/artifact:I2LCjrN6I0I8", sha256: "a".repeat(64), byteSize: 64, expiresAt: null, pinnedAt: null, deletedAt: null, createdAt: at,
      metadata: { source: "AGENT_OUTPUT", originalFilename: "YC W27 founder video script.md", folder: "Documents/Funding", previewKind: "TEXT" } };
    vi.spyOn(liveRuntime.api, "artifacts").mockResolvedValue({ data: [script], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } } as never);
    render(<NeedsYouCard variant="row" item={card({ body: "The script is in Agent Files › Documents/Funding.", payload: { ...card({}).payload,
      files: [{ artifactId: script.id, name: "YC W27 founder video script.md", folder: "Documents/Funding", mime: "text/markdown" }] } })} />);
    const chip = screen.getByRole("button", { name: /YC W27 founder video script\.md/ });
    expect(chip.textContent).toContain("Documents/Funding");
    fireEvent.click(chip);
    expect(await screen.findByRole("dialog", { name: "Preview YC W27 founder video script.md" })).toBeTruthy();
  });

  it("off Space: one answer, no Go anywhere, and «There is a problem» sends his words with it", async () => {
    render(<NeedsYouCard variant="peek" item={card({})} />);
    expect(closedButtons()).toEqual(["Later", "Done, all good", "Details"]);
    expect(screen.queryByText("Open the Play Store.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Open the Play Store.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Go/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "There is a problem" }));
    const words = screen.getByRole("textbox", { name: "What went wrong?" });
    fireEvent.change(words, { target: { value: "The Play Store still shows 0.2.12" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answers).toEqual([{ text: "There is a problem: The Play Store still shows 0.2.12" }]));
    expect(await screen.findByText("Sent to Iris.")).toBeTruthy();
  });

  it("operator 4/11 18:42 BKK: a card asking for a value leads with a text field and Send, closed or open, never focused by itself; every card takes his words", async () => {
    const value = card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Hetzner claim", body: "Form A needs the applicant's phone.",
      payload: { paneMode: "TERMINAL", ask: { question: "Which phone goes on Form A as the applicant's phone?", answerKind: "text", answer: { kind: "NOUS" } } } });
    render(<NeedsYouCard variant="peek" item={value} />);
    const field = screen.getByRole("textbox", { name: "Your answer" });
    expect(document.activeElement).not.toBe(field);
    expect(screen.getByRole("article").dataset.needsYouPlace).toBe("HERE");
    expect(closedButtons()).toEqual(["Later", "Send", "Details"]);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: " +66 00 000 0000 " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answers).toEqual([{ text: "+66 00 000 0000" }]));
    expect(await screen.findByText("Sent to Iris.")).toBeTruthy();
    cleanup();
    // Open, the field is there once, under what it needs.
    render(<NeedsYouCard variant="row" item={value} open />);
    expect(screen.getAllByRole("textbox", { name: "Your answer" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Done, all good" })).toBeNull();
    cleanup();
    // Off Space too: Done or a problem, and his own words beside them.
    render(<NeedsYouCard variant="row" item={card({})} open />);
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), { target: { value: "Installed 0.2.14 instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answers.at(-1)).toEqual({ text: "Installed 0.2.14 instead" }));
  });

  it("here: the recommended answer is the one button, sent as the card's option; in a pane: Go to pane, only on his click", async () => {
    render(<NeedsYouCard variant="row" item={card({ payload: { paneMode: "TERMINAL", ask: { question: "Which colour?", options: ["Red", "Blue"], recommended: "Blue", answer: { kind: "PANE" } } } })} />);
    expect(closedButtons()).toEqual(["Details", "Blue"]);
    fireEvent.click(screen.getByRole("button", { name: "Blue" }));
    await waitFor(() => expect(answers).toEqual([{ option: "Blue" }]));
    cleanup();
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      render(<NeedsYouCard variant="row" item={card({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", payload: {} })} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Go to pane" }));
      expect(seen).toEqual([expect.objectContaining({ roomId: "room:work000001", paneId: "pane:iris0000001", immediate: true })]);
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator nous_msg:4b36b80e: a browser handoff card is one short question and a big Go now to its own tab, the agent's steps behind Details", () => {
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      render(<NeedsYouCard variant="row" item={card({ source: "BROWSER_HANDOFF", kind: "BROWSER_HANDOFF_REQUESTED", title: "Finn: browser handoff",
        body: "LOGIN: [site:google.com] Sign in with the job account.\n1) Open the account chooser.\n2) Pick the job account.",
        link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "tab:page-google" },
        payload: { site: "google.com", ask: { question: "Sign in to google.com", options: ["Go now"], recommended: "Go now", answer: { kind: "PANE" } } } })} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
      expect(screen.getByText("Sign in to google.com")).toBeTruthy();
      expect(screen.queryByText(/Pick the job account/)).toBeNull();
      expect(closedButtons()).toEqual(["Details", "Go now"]);
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Go now" }));
      expect(seen).toEqual([expect.objectContaining({ roomId: "room:work000001", paneId: "pane:iris0000001", immediate: true })]);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getByText(/Pick the job account/)).toBeTruthy();
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator nous_msg:4b36b80e: Nous's pane card a sign-in joined leads with that item's question and Go now; every item's steps wait behind Details", () => {
    // The body and ask pane-notices.ts writes when the newest item (with tab:page-google) joins the card.
    render(<NeedsYouCard variant="row" item={card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Finn needs you",
      body: "• Pick the Upwork profile\n• LOGIN: Google sign-in for the job site\n  1. Open https://accounts.google.com in Finn's browser\n  2. Sign in as the job account",
      link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "tab:page-google" },
      payload: { ask: { question: "Sign in to google.com", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } })} />);
    expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
    expect(screen.getByText("Sign in to google.com")).toBeTruthy();
    expect(screen.queryByText(/accounts\.google\.com/)).toBeNull();
    expect(closedButtons()).toEqual(["Details", "Go now"]);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/Sign in as the job account/)).toBeTruthy();
  });

  it("a card answered here keeps its pane one click away in Details; a one-time code's field leads even on a pane card", () => {
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      // A campaign is approved in its pane, after he reads every mail; the card itself only declines.
      render(<NeedsYouCard variant="row" item={card({ source: "MAIL_COPILOT", kind: "CAMPAIGN_REVIEW", link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "campaign:c1" },
        payload: { ask: { question: "Review the campaign", options: ["Decline"], answer: { kind: "COPILOT_DECISION", copilot: "mail", item: "CAMPAIGN", itemId: "c1" } } } })} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("HERE");
      expect(closedButtons()).toEqual(["Details", "Review and approve"]);
      fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Go to pane" }));
      expect(seen).toEqual([expect.objectContaining({ paneId: "pane:iris0000001", immediate: true })]);
      cleanup();
      render(<NeedsYouCard variant="row" item={card({ source: "JOB_COPILOT", kind: "SIGN_IN", payload: { ask: { question: "The code from the mail", code: true, answer: { kind: "PANE" } } } })} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
      expect(screen.getByRole("textbox", { name: "One-time code" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Go to pane" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getAllByRole("textbox", { name: "One-time code" })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Go to pane" })).toBeTruthy();
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator 12/11 23:19 BKK: a card naming a Mail review shows that mail (the review's reply) and its Go opens the review, though Nous set no target", async () => {
    const reviewId = "mailrev:5vC-c2wzYPUf";
    const body = Array.from({ length: 20 }, (_, line) => `Line ${line + 1} of the reply.`).join("\n");
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith("/api/mail-copilot/events?")) return Response.json({ events: [{ id: "mailevt:1", type: "REVIEW_REQUESTED", accountEmail: "spaceappdv@gmail.com", threadId: "1a1d07d30f3b989e",
        payload: { reviewId, draft: { account: "spaceappdv@gmail.com", to: ["support@turso.tech"], cc: [], bcc: [], subject: "Re: Your Turso database", text: body, threadId: "1a1d07d30f3b989e" },
          attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }], reasoning: "They asked for the invoice." } }] });
      return Response.json({ notifications: [] });
    }));
    const seen: Array<{ notification?: SpaceNotification }> = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      render(<NeedsYouCard variant="row" open item={card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Dino needs you", body: `• Send the reply to Turso? (Mail Copilot review ${reviewId})`,
        payload: { ask: { question: "Send the reply to Turso?", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } })} />);
      const mail = await screen.findByRole("region", { name: "Mail" });
      expect(asked).toContain(`/api/mail-copilot/events?reviewId=${encodeURIComponent(reviewId)}`);
      expect(within(mail).getByText("From").nextElementSibling?.textContent).toBe("spaceappdv@gmail.com");
      expect(within(mail).getByText("To").nextElementSibling?.textContent).toBe("support@turso.tech");
      expect(within(mail).getByText("Subject").nextElementSibling?.textContent).toBe("Re: Your Turso database");
      expect(within(mail).getByText("Attachments").nextElementSibling?.textContent).toBe("invoice.pdf");
      // A long body folds; Show more opens all of it.
      expect(mail.querySelector(".ny-mail-body.is-folded")?.textContent).toContain("Line 20 of the reply.");
      fireEvent.click(within(mail).getByRole("button", { name: "Show more" }));
      expect(mail.querySelector(".ny-mail-body.is-folded")).toBeNull();
      expect(within(mail).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(screen.getAllByRole("button", { name: /^Go (now|to pane)$/ })[0]!);
      expect(seen.at(-1)?.notification?.link?.target).toBe(`review:${reviewId}`);
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });
});
