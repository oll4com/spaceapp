import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsYouHasPlace, type SpaceNotification } from "@space/contracts";
import { mailTextParts, NeedsYouCard, type NeedsYouBoardPane } from "../src/features/needs-you/NeedsYouCard.js";
import { NOUS_FOCUS_EVENT } from "../src/features/nous-focus/nous-focus-events.js";
import { consumePlanView, NOUS_DONE_OPEN_EVENT } from "../src/features/nous/nous-done-events.js";
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

  it("off Space: one answer, no Go anywhere, the steps under More, and his words in the field go as «There is a problem»", async () => {
    render(<NeedsYouCard variant="peek" item={card({})} />);
    expect(closedButtons()).toEqual(["Later", "Done, all good", "Details"]);
    expect(screen.queryByText("Open the Play Store.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByText("Open the Play Store.")).toBeNull();
    // Operator 27/11: the window's More and Less share one footer row instead of two stacked toggles.
    expect([...document.querySelector(".ny-footer")!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["More", "Less"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText("Open the Play Store.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Go/ })).toBeNull();
    // Plan clipboard:va__qa_eBMYr: Send shows once he has typed.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    const words = screen.getByRole("textbox", { name: "What went wrong?" });
    fireEvent.change(words, { target: { value: "The Play Store still shows 0.2.12" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answers).toEqual([{ text: "There is a problem: The Play Store still shows 0.2.12" }]));
    expect(await screen.findByText("Sent to Iris.")).toBeTruthy();
  });

  it("plan clipboard:va__qa_eBMYr: a question that holds its whole body (a lead-in + the body) says it once, with no What it needs", () => {
    render(<NeedsYouCard variant="row" item={card({ body: "Should the release wait for the phone test?", payload: { paneMode: "TERMINAL",
      ask: { question: "Release 0.2.13 is ready. Should the release wait for the phone test?", options: ["Yes", "No"], answer: { kind: "PANE" } } } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.queryByText("What it needs")).toBeNull();
    expect(screen.getAllByText(/Should the release wait/)).toHaveLength(1);
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
    // Off Space too: Done, or his own words, sent as the problem.
    render(<NeedsYouCard variant="row" item={card({})} open />);
    fireEvent.change(screen.getByRole("textbox", { name: "What went wrong?" }), { target: { value: "Installed 0.2.14 instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(answers.at(-1)).toEqual({ text: "There is a problem: Installed 0.2.14 instead" }));
  });

  it("here: the recommended answer is the one button, sent as the card's option; in a pane: Go to pane, only on his click", async () => {
    render(<NeedsYouCard variant="row" item={card({ payload: { paneMode: "TERMINAL", ask: { question: "Which colour?", options: ["Red", "Blue"], recommended: "Blue", answer: { kind: "PANE" } } } })} />);
    expect(closedButtons()).toEqual(["Details", "Blue", "1 more answer"]);
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

  it("operator 20/11 18:24 BKK (nous_msg:e519138e), 27/11 A: a card in a pane closes with one tap, answer 2 «I already did it», sent as «Done, all good»; generic answers under More", async () => {
    render(<NeedsYouCard variant="row" open item={card({ title: "Cody needs you", payload: { paneMode: "BROWSER", ask: { question: "Start now?", options: ["Go now", "Later today"], recommended: "Go now", answer: { kind: "PANE" } } } })} />);
    expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
    const opts = [...screen.getByRole("article").querySelectorAll(".ny-answers > button")].map((button) => button.textContent);
    expect(opts).toEqual(["Go to pane Recommended", "I already did it"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("region", { name: "Other answers" })).getByRole("button", { name: "Later today" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I already did it" }));
    // Not one of the ask's options, so it goes as his words, like a typed answer.
    await waitFor(() => expect(answers).toEqual([{ text: "Done, all good" }]));
    cleanup();
    // Off Space keeps its own «Done, all good», never both.
    render(<NeedsYouCard variant="row" open item={card({})} />);
    expect(screen.queryByRole("button", { name: "I already did it" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Completed" })).toBeNull();
  });

  it("22/11 review of e8ff210efc: Completed (⋯ menu) on a Mail Copilot flag closes it as «I handled it», never as words that start the copilot on the mail; a typed note goes with it", async () => {
    const mail = card({ source: "MAIL_COPILOT", kind: "NEEDS_USER", paneId: null, link: undefined, payload: { ask: { question: "What should Mail Copilot do with this mail?",
      options: ["I handled it", "Ignore it"], answer: { kind: "MAIL_FIX", account: "op@example.com", threadId: "thread-1" } } } });
    render(<NeedsYouCard variant="row" open item={mail} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Completed" }));
    await waitFor(() => expect(answers).toEqual([{ option: "I handled it" }]));
    cleanup();
    answers = [];
    render(<NeedsYouCard variant="row" open item={card({ title: "Cody needs you", payload: { paneMode: "BROWSER", ask: { question: "Start now?", options: ["Go now"], recommended: "Go now", answer: { kind: "PANE" } } } })} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "shipped at 3pm" } });
    fireEvent.click(screen.getByRole("button", { name: "I already did it" }));
    await waitFor(() => expect(answers).toEqual([{ text: "Done, all good: shipped at 3pm" }]));
  });

  it("operator 13/11 15:37 BKK (card 9ef2254f): Go on a plan's card goes to its plan's pane, else opens the plan: never a dead click", () => {
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    const opened: unknown[] = [];
    const onOpen = () => opened.push(consumePlanView());
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    window.addEventListener(NOUS_DONE_OPEN_EVENT, onOpen);
    const plan = (link: SpaceNotification["link"]) => card({ source: "NOUS", kind: "NEEDS_HANDS", paneId: null, dedupeKey: "nous:plan:clipboard:S6PyXKwpBrit", link, title: "Partner Advantage case",
      body: "Submit the Partner Advantage case", payload: { planId: "clipboard:S6PyXKwpBrit", ask: { question: "Submit it now?", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } } } });
    try {
      render(<NeedsYouCard variant="row" item={plan({ roomId: "room:bruno00001", paneId: "pane:hugo000001" })} />);
      fireEvent.click(screen.getByRole("button", { name: "Go to pane" }));
      expect(seen).toEqual([expect.objectContaining({ roomId: "room:bruno00001", paneId: "pane:hugo000001", immediate: true,
        notification: expect.objectContaining({ paneId: "pane:hugo000001", link: expect.objectContaining({ target: "activity" }) }) })]);
      cleanup();
      render(<NeedsYouCard variant="row" item={plan({ roomId: "room:bruno00001" })} />);
      fireEvent.click(screen.getByRole("button", { name: "Open plan" }));
      expect([seen.length, opened]).toEqual([1, ["clipboard:S6PyXKwpBrit"]]);
      // nous_msg:0fa7d370: a Nous card on no pane and no plan has nowhere to go, closed or in Details (its Go only reopened Needs you).
      cleanup();
      const general = { ...plan({ roomId: "room:bruno00001" }), dedupeKey: "nous:general" } as SpaceNotification;
      render(<NeedsYouCard variant="peek" item={{ ...general, payload: { ask: { question: "Submit it now?", answerKind: "text", answer: { kind: "NOUS" } } } }} />);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.queryByRole("button", { name: /Go to pane|Open plan/ })).toBeNull();
      cleanup();
      render(<NeedsYouCard variant="peek" item={{ ...general, payload: { ask: general.payload.ask } }} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("OFF_SPACE");
      expect(screen.queryByRole("button", { name: /Go to pane|Open plan/ })).toBeNull();
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
      window.removeEventListener(NOUS_DONE_OPEN_EVENT, onOpen);
    }
  });

  it("operator nous_msg:4b36b80e: a browser handoff card is one short question and a big Go to the page, to its own tab, the agent's steps behind Details", () => {
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
      expect(closedButtons()).toEqual(["Details", "Go to the page", "1 more answer"]);
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Go to the page" }));
      expect(seen).toEqual([expect.objectContaining({ roomId: "room:work000001", paneId: "pane:iris0000001", immediate: true })]);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      fireEvent.click(screen.getByRole("button", { name: "More" }));
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
    expect(closedButtons()).toEqual(["Details", "Go to the page", "1 more answer"]);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText(/Sign in as the job account/)).toBeTruthy();
  });

  it("a card answered here keeps its pane one click away in the ⋯ menu; a one-time code's field leads even on a pane card", () => {
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
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Go to pane" }));
      expect(seen).toEqual([expect.objectContaining({ paneId: "pane:iris0000001", immediate: true })]);
      cleanup();
      render(<NeedsYouCard variant="row" item={card({ source: "JOB_COPILOT", kind: "SIGN_IN", payload: { ask: { question: "The code from the mail", code: true, answer: { kind: "PANE" } } } })} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("PANE");
      expect(screen.getByRole("textbox", { name: "One-time code" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Go to pane" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.getAllByRole("textbox", { name: "One-time code" })).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      expect(screen.getByRole("menuitem", { name: "Go to pane" })).toBeTruthy();
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator 13/11 07:12 BKK (plan clipboard:T2uboz26Oh3q S2): a Nous card about a CLI pane names that pane in Details, its click opens it, and the closed card still has no Go", () => {
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      const relay = card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Bruno: pick a logo", body: "• Bruno asks which logo to keep (answers the Agent's question)",
        payload: { paneMode: "TERMINAL", ask: { question: "Which logo?", options: ["Logo A", "Logo B"], recommended: "Logo B", answer: { kind: "NOUS" } } } });
      const pane = { paneId: "pane:iris0000001", name: "Bruno", mode: "TERMINAL", roomName: "Work", lineLanguage: "en" } as NeedsYouBoardPane;
      render(<NeedsYouCard variant="row" item={relay} pane={pane} />);
      expect(screen.getByRole("article").dataset.needsYouPlace).toBe("HERE");
      expect(closedButtons()).toEqual(["Details", "Logo B", "1 more answer"]);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      expect(screen.queryByRole("button", { name: /Go/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Open Bruno" }));
      expect(seen).toEqual([expect.objectContaining({ roomId: "room:work000001", paneId: "pane:iris0000001", immediate: true })]);
      // NousFocus goes only where the card has a place: without a target a Nous card about a CLI pane had none, and the click only showed the peek.
      const sent = (seen[0] as { notification: SpaceNotification }).notification;
      expect(sent.link.target).toBe("activity");
      expect(needsYouHasPlace(sent, "TERMINAL")).toBe(true);
      expect(answers).toEqual([]);
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator 13/11 07:12 BKK (plan clipboard:T2uboz26Oh3q S3/S4): design variants are tiles; a picture opens a preview with Choose this, ←/→ and Download, Open in Design opens the request, and no id shows", async () => {
    const seen: Array<{ roomId: string; paneId: string; notification: SpaceNotification }> = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    vi.spyOn(liveRuntime.api, "artifactMetadata").mockImplementation(async (id: string) => {
      if (id === "artifact:gone000001") throw new Error("Artifact artifact:gone000001 was not found.");
      return { artifact: { id, filename: `${id.slice(9)}.${id.includes("cut") ? "mp4" : "png"}`, mimeType: id.includes("cut") ? "video/mp4" : "image/png", byteSize: 1, sha256: "a".repeat(64), createdAt: at,
        roomId: "room:studio00001", paneId: "pane:design00001", metadata: { source: "DESIGN", requestId: "dreq:banner0001" } }, image: null, embedded: {}, design: null };
    });
    try {
      const pick = card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Pick a banner", body: "Two banners are ready; last week's was artifact:gone000001.",
        payload: { paneMode: "TERMINAL", ask: { question: "Which banner?", options: ["Variant A (artifact:varA000001)", "Variant B: artifact:cutB000001", "Neither"],
          recommended: "Variant B: artifact:cutB000001", answer: { kind: "NOUS" } } } });
      render(<NeedsYouCard variant="row" item={pick} pane={{ paneId: "pane:iris0000001", name: "Bruno", mode: "TERMINAL", roomName: "Work", lineLanguage: "en" } as NeedsYouBoardPane} />);
      expect(closedButtons()).toEqual(["Details", "Variant B", "2 more answers"]);
      fireEvent.click(screen.getByRole("button", { name: "Details" }));
      const previewA = await screen.findByRole("button", { name: "Preview Variant A" });
      expect((await screen.findByRole("button", { name: "Preview Variant B" })).querySelector("video")).toBeTruthy();
      expect(await screen.findByText("No longer available")).toBeTruthy();
      expect(screen.getByRole("article").textContent).not.toMatch(/artifact:/);
      expect(screen.getAllByRole("button", { name: /^(?:Variant [AB]|Neither)/ }).map((button) => button.textContent)).toEqual(["Variant A", "Variant B Recommended", "Neither"]);

      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Design" }));
      expect(seen.at(-1)).toMatchObject({ roomId: "room:studio00001", paneId: "pane:design00001", notification: { link: { target: "request:dreq:banner0001" } } });
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      expect(screen.getByRole("menuitem", { name: "Open Bruno" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));

      previewA.focus();
      fireEvent.click(previewA);
      let dialog = await screen.findByRole("dialog", { name: "Preview Variant A" });
      expect(within(dialog).getByText("1 / 2 · varA000001.png")).toBeTruthy();
      expect(within(dialog).getByRole("link", { name: "Download varA000001.png" }).getAttribute("download")).toBe("varA000001.png");
      fireEvent.keyDown(dialog, { key: "ArrowRight" });
      dialog = await screen.findByRole("dialog", { name: "Preview Variant B" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
      dialog = await screen.findByRole("dialog", { name: "Preview Variant A" });
      fireEvent.keyDown(dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(previewA);

      fireEvent.click(screen.getByRole("button", { name: "Preview Variant B" }));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "Preview Variant B" })).getByRole("button", { name: "Choose this" }));
      await waitFor(() => expect(answers).toEqual([{ option: "Variant B: artifact:cutB000001" }]));
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("plan clipboard:T2uboz26Oh3q S9: an open card tabs header (⋯, Less) → tiles → answers → his words; the preview opens on Choose this, a held Enter does not answer, ←/→ is announced", async () => {
    vi.spyOn(liveRuntime.api, "artifactMetadata").mockImplementation(async (id: string) => ({ artifact: { id, filename: `${id.slice(9)}.png`, mimeType: "image/png", byteSize: 1,
      sha256: "a".repeat(64), createdAt: at, roomId: null, paneId: null, metadata: {} }, image: null, embedded: {}, design: null }));
    const pick = card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Pick a banner", body: "Two banners are ready.",
      payload: { paneMode: "TERMINAL", ask: { question: "Which banner?", options: ["Variant A (artifact:varA000001)", "Variant B (artifact:varB000001)", "Neither"],
        recommended: "Variant B (artifact:varB000001)", answer: { kind: "NOUS" } } } });
    render(<NeedsYouCard variant="row" item={pick} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const previewA = await screen.findByRole("button", { name: "Preview Variant A" });
    await screen.findByRole("button", { name: "Preview Variant B" });
    // Document order (jsdom answers a selector list grouped by selector): the order Tab walks.
    const order = [...screen.getByRole("article").querySelectorAll<HTMLElement>("*")].filter((node) => node.matches("button:not(:disabled), a[href], input, textarea, summary"))
      .map((control) => control.getAttribute("aria-label") ?? control.textContent);
    expect(order).toEqual(["More actions", "Less", "Preview Variant A", "Variant A", "Preview Variant B", "Variant B Recommended", "Neither", "Your answer"]);

    previewA.focus();
    fireEvent.click(previewA);
    const dialog = await screen.findByRole("dialog", { name: "Preview Variant A" });
    const choose = within(dialog).getByRole("button", { name: "Choose this" });
    await waitFor(() => expect(document.activeElement).toBe(choose));
    expect(fireEvent.keyDown(choose, { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(choose, { key: "Enter" })).toBe(true);
    fireEvent.keyDown(choose, { key: "ArrowRight" });
    await screen.findByRole("dialog", { name: "Preview Variant B" });
    expect(dialog.querySelector("[aria-live='polite']")?.textContent).toBe("2 / 2 · Variant B");
    expect(document.activeElement).toBe(choose);
    fireEvent.keyDown(choose, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(previewA);
    expect(answers).toEqual([]);
  });

  it("plan clipboard:T2uboz26Oh3q S7: the recommended answer comes first on a row of its own with a Recommended badge in its name, no suffix", () => {
    const ask = card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Release window", body: "The queue is empty.",
      payload: { paneMode: "TERMINAL", ask: { question: "Release tonight or tomorrow?", options: ["Tomorrow", "Tonight", "Never"], recommended: "Tonight", answer: { kind: "NOUS" } } } });
    render(<NeedsYouCard variant="row" item={ask} />);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const buttons = [...screen.getByRole("article").querySelectorAll(".ny-answers > button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Tonight Recommended", "Tomorrow", "Never"]);
    expect([buttons[0]!.classList.contains("is-recommended"), Boolean(buttons[0]!.querySelector(".ny-badge svg"))]).toEqual([true, true]);
    expect(screen.getByRole("button", { name: "Tonight Recommended" })).toBe(buttons[0]);
    expect(screen.getByRole("article").textContent).not.toContain("(Recommended)");
  });

  it("plan clipboard:T2uboz26Oh3q S8: a review shows its draft with the channel, an urgent card says so, and a closed card's files fold to a count", () => {
    const decide = { question: "Post it?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MARKETING", item: "REVIEW", itemId: "mkrev:post000001" } };
    render(<NeedsYouCard variant="row" open item={card({ source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", title: "Post for LinkedIn", body: "Ready.",
      payload: { ask: decide, review: { id: "mkrev:post000001", channel: "LINKEDIN", text: "SpaceApp 1.0 is out." } } })} />);
    const review = screen.getByRole("article");
    expect(review.getAttribute("data-needs-you-layout")).toBe("REVIEW");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(within(screen.getByRole("region", { name: "Draft" })).getByRole("heading").textContent).toBe("Draft · LinkedIn");
    expect(screen.getByRole("region", { name: "Draft" }).textContent).toContain("SpaceApp 1.0 is out.");
    cleanup();

    const files = ["a.png", "b.png", "c.png"].map((name, index) => ({ artifactId: `artifact:file0000000${index}`, name, folder: "Images", mime: "image/png" }));
    render(<NeedsYouCard variant="row" item={card({ source: "SECURITY_COPILOT", kind: "SECURITY_REVIEW", severity: "URGENT", title: "Patch openssl on pve1",
      payload: { ask: { ...decide, answer: { kind: "COPILOT_QUESTION" } }, files } })} />);
    const urgent = screen.getByRole("article");
    expect([urgent.getAttribute("data-needs-you-layout"), urgent.classList.contains("layout-security"), urgent.querySelector(".ny-urgent")?.textContent]).toEqual(["SECURITY", true, "Urgent"]);
    fireEvent.click(screen.getByRole("button", { name: "3 files" }));
    expect(["a.png", "b.png", "c.png"].map((name) => Boolean(screen.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })))).toEqual([true, true, true]);
  });

  it("plan clipboard:T2uboz26Oh3q S5: what changed since the operator's earlier answer is the card's Since then, not words in its text", () => {
    render(<NeedsYouCard variant="row" open item={card({ source: "NOUS", kind: "NEEDS_HANDS", title: "Allowances", body: "• The allowance switches.\n\nChecked first:\n• Settings: two are off",
      payload: { items: [{ text: "The allowance switches.", since: "two switches are still off after the reload" }],
        ask: { question: "Turn them on now?", options: ["Yes", "No"], recommended: "Yes", answer: { kind: "NOUS" } } } })} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText("Since then").nextElementSibling?.textContent).toBe("two switches are still off after the reload");
  });

  it("nous_msg:832a500e: a card about one plan shows the pane's later report under Since then only when it is about that plan", () => {
    const pane = (planId: string | null) => ({ paneId: "pane:iris0000001", name: "Bruno", mode: "TERMINAL", roomName: "Work", lineLanguage: "en", summary: { source: "FALLBACK" },
      report: { at: "2099-01-01T00:00:00.000Z", status: "PROGRESS", summary: "Moved on to the other plan", planId } }) as unknown as NeedsYouBoardPane;
    const item = card({ payload: { ...card({}).payload, planId: "clipboard:planOne00001" } });
    const { rerender } = render(<NeedsYouCard variant="row" open item={item} pane={pane("clipboard:planTwo00001")} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByText("Since then")).toBeNull();
    for (const planId of ["clipboard:planOne00001", null]) {
      rerender(<NeedsYouCard variant="row" open item={item} pane={pane(planId)} />);
      expect(screen.getByText("Since then").nextElementSibling?.textContent).toContain("Moved on to the other plan");
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
      fireEvent.click(await screen.findByRole("button", { name: "More" }));
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
      fireEvent.click(screen.getByRole("button", { name: /^Go to pane/ }));
      expect(seen.at(-1)?.notification?.link?.target).toBe(`review:${reviewId}`);
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("plan clipboard:va__qa_eBMYr §3: a hands card's first answer follows its place now: ran out asks again then goes, a closed page is told, a closed pane or a moved-on agent closes", async () => {
    const seen: unknown[] = [];
    const onFocus = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    const hands = card({ title: "Cody needs you", body: "Sign in", payload: { paneMode: "BROWSER", ask: { question: "Sign in?", options: ["Go now"], recommended: "Go now", answer: { kind: "PANE" } } } });
    try {
      render(<NeedsYouCard variant="row" item={hands} live={{ state: "EXPIRED", line: "The handoff ran out.", at }} />);
      expect(screen.getByRole("article").querySelector(".ny-live.is-warn")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Go and ask for it again" }));
      await waitFor(() => expect(answers).toEqual([{ text: "I am here now: offer the browser handoff again." }]));
      await waitFor(() => expect(seen).toEqual([expect.objectContaining({ paneId: "pane:iris0000001", immediate: true })]));
      cleanup();
      render(<NeedsYouCard variant="row" item={hands} live={{ state: "PAGE_GONE", line: "The page is no longer open." }} />);
      expect(screen.getByText("The page is no longer open.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Tell the agent" }));
      await waitFor(() => expect(answers.at(-1)).toEqual({ text: "The page is no longer open: open it again and tell me when it is ready." }));
      cleanup();
      for (const [state, label] of [["PANE_CLOSED", "Close without answering"], ["MOVED_ON", "It no longer needs me"]] as const) {
        const onDismiss = vi.fn(async () => true);
        render(<NeedsYouCard variant="row" item={hands} onDismiss={onDismiss} live={{ state, line: "pane:iris0000001 reported done" }}
          panes={new Map([["pane:iris0000001", { name: "Cody" }]])} />);
        if (state === "MOVED_ON") expect(screen.getByText("The agent moved on: Cody reported done")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: label }));
        fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Close without answering?" })).getByRole("button", { name: "Close without answering" }));
        expect(await screen.findByText("Closed without answering")).toBeTruthy();
        expect(onDismiss).toHaveBeenCalledTimes(1);
        cleanup();
      }
      expect(seen).toHaveLength(1);
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("operator 27/11 C: the ⋯ menu's Close without answering confirms first, then dismisses the card's notification; Cancel leaves it waiting", async () => {
    const dismissed: string[] = [];
    vi.spyOn(liveRuntime.api, "dismissNotification").mockImplementation(async (id: string) => { dismissed.push(id); return {} as never; });
    render(<NeedsYouCard variant="row" open item={card({ payload: { paneMode: "TERMINAL", ask: { question: "Which colour?", options: ["Red", "Blue"], answer: { kind: "PANE" } } } })} />);
    const close = () => { fireEvent.click(screen.getByRole("button", { name: "More actions" })); fireEvent.click(screen.getByRole("menuitem", { name: "Close without answering" })); };
    close();
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Close without answering?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(dismissed).toEqual([]);
    close();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Close without answering" }));
    expect(await screen.findByText("Closed without answering")).toBeTruthy();
    expect([dismissed, answers]).toEqual([["notification:card00000001"], []]);
  });

  it("nous_msg:5bcbe4b0: a mail's \"label ( tracking URL )\" links read as their labels, bare URLs as short hosts, and blank runs collapse", async () => {
    const track = (n: number) => `https://link.email.upwork.com/ls/click?upn=u001.${"Qx7".repeat(160)}${n}`;
    const text = `View your message and send a reply.\n\u200c \n \n\n\n\nFind Work ( ${track(1)} )\n\nUnread message from Israel G. about Rate AI code-review answers\n\n\n`
      + `Uma\u2122 ( ${track(2)} ) | Ad Products ( ${track(3)} )\nOr open ${track(4)}.\n`;
    const message = { id: "m1", threadId: "1a1f09f7711a8773", from: { name: "Upwork", address: "donotreply@upwork.com" }, to: [{ name: null, address: "spaceappdv@gmail.com" }], cc: [], replyTo: [],
      subject: "You have unread messages", receivedAt: at, rfcMessageId: null, references: null, labelIds: [], unread: true, starred: false, text, html: null, blockedImages: false, attachments: [] };
    vi.spyOn(liveRuntime.api, "mailThread").mockResolvedValue({ thread: { account: "spaceappdv@gmail.com", threadId: "1a1f09f7711a8773", subject: message.subject, messages: [message] } } as never);
    render(<NeedsYouCard variant="row" open item={card({ source: "NOUS", title: "Bob needs you", body: "Accept the paid 1h Upwork trial?", link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "thread:spaceappdv@gmail.com:1a1f09f7711a8773" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const body = (await screen.findByRole("region", { name: "Mail" })).querySelector(".ny-mail-body")!;
    expect(body.textContent!.match(/\S{61,}/g)).toBeNull();
    expect(body.textContent).toBe("View your message and send a reply.\n\nFind Work\n\nUnread message from Israel G. about Rate AI code-review answers\n\nUma\u2122 | Ad Products\nOr open link.email.upwork.com/ls/click.");
    const links = within(body as HTMLElement).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")])).toEqual([
      ["Find Work", track(1), "_blank", "noopener noreferrer"], ["Uma\u2122", track(2), "_blank", "noopener noreferrer"],
      ["Ad Products", track(3), "_blank", "noopener noreferrer"], ["link.email.upwork.com/ls/click", track(4), "_blank", "noopener noreferrer"]]);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(mailTextParts("See https://oll4.com/pricing now")).toEqual(["See ", { label: "oll4.com/pricing", href: "https://oll4.com/pricing" }, " now"]);
    expect(mailTextParts("javascript:alert(1) ( javascript:alert(1) )")).toEqual(["javascript:alert(1) ( javascript:alert(1) )"]);
  });

  it("nous_msg:5bcbe4b0: a Gmail text part with \\r\\n line ends, deep indents and &nbsp; (micro1 20/11) reads collapsed", () => {
    const text = "Hi again, NIKOLAOS,\r\n\r\n            Thanks again for signing up to work with micro1 and sharing your resume.\r\n\r\n\r\n"
      + "            Click the button below to start your 30-minute interview.\r\n\r\n\r\n\r\n\r\n\r\n\r\n                &nbsp;\r\n\r\n"
      + "                Take the interview\r\n\r\n                &nbsp;\r\n\r\n\r\n\r\n                Note: Desktop only, mobile won&#39;t work &amp; more\r\n\r\n\r\n\r\n\r\n"
      + "            Best,\rmicro1 team\r\n";
    expect(mailTextParts(text)).toEqual(["Hi again, NIKOLAOS,\n\nThanks again for signing up to work with micro1 and sharing your resume.\n\n"
      + "Click the button below to start your 30-minute interview.\n\nTake the interview\n\nNote: Desktop only, mobile won't work & more\n\nBest,\nmicro1 team"]);
    expect(mailTextParts("a&lt;b&gt; &quot;c&quot; &#x41;&#0;&#99999999;")).toEqual(["a<b> \"c\" A&#0;&#99999999;"]);
  });

  it("a mail with a long blank run inside a line trims in linear time and keeps inner spaces (review of d36483ed04)", () => {
    const started = performance.now();
    expect(mailTextParts(`a${" ".repeat(200_000)}b \u00a0\nc`)).toEqual([`a${" ".repeat(200_000)}b\nc`]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("nous_msg:5bcbe4b0: a text part that is mostly URLs gives way to the sanitized HTML, read as text with its links", async () => {
    const url = `https://link.email.upwork.com/ls/click?upn=${"Zz9".repeat(150)}`;
    const message = { id: "m1", threadId: "t1", from: { name: "Upwork", address: "donotreply@upwork.com" }, to: [], cc: [], replyTo: [], subject: "Unread", receivedAt: at, rfcMessageId: null,
      references: null, labelIds: [], unread: true, starred: false, text: `Hi ( ${url} ) ( ${url} )`, blockedImages: false, attachments: [],
      html: `<style>p{color:red}</style><table><tr><td><p>Unread   message from\n  Israel G.</p><p><a href="${url}">Reply now</a></p><img src="x.png"></td></tr></table>` };
    vi.spyOn(liveRuntime.api, "mailThread").mockResolvedValue({ thread: { account: "a@b.co", threadId: "t1", subject: "Unread", messages: [message] } } as never);
    render(<NeedsYouCard variant="row" open item={card({ source: "NOUS", link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "thread:a@b.co:t1" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const body = (await screen.findByRole("region", { name: "Mail" })).querySelector(".ny-mail-body")!;
    expect(body.textContent).toBe("Unread message from Israel G.\nReply now");
    expect(within(body as HTMLElement).getByRole("link", { name: "Reply now" }).getAttribute("href")).toBe(url);
    expect(body.querySelector("img, style")).toBeNull();
  });

// Operator 21/11 nous_msg:e9b4df3e: a card's mail in a third language reads translated, "Show original" shows it as sent.
describe("needs-you mail translated when raised", () => {
  it("shows the stored translation of the mail's subject and body, and the original on Show original", async () => {
    const original = { subject: "Vous êtes invité au portail candidat", text: "Bonjour, accédez à votre espace candidat.", at };
    const message = { id: "m1", threadId: "t1", from: { name: "Startup Talents", address: "noreply@talents.test" }, to: [], cc: [], replyTo: [], subject: original.subject, receivedAt: at,
      rfcMessageId: null, references: null, labelIds: [], unread: true, starred: false, text: original.text, html: null, blockedImages: false, attachments: [] };
    vi.spyOn(liveRuntime.api, "mailThread").mockResolvedValue({ thread: { account: "a@b.co", threadId: "t1", subject: original.subject, messages: [message] } } as never);
    render(<NeedsYouCard variant="row" open item={card({ source: "MAIL_COPILOT", link: { roomId: "room:work000001", paneId: "pane:iris0000001", target: "thread:a@b.co:t1" },
      payload: { mailTranslated: { language: "en", original, subject: "You are invited to the candidate portal", text: "Hello, open your candidate space." } } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const mail = await screen.findByRole("region", { name: "Mail" });
    await waitFor(() => expect(mail.textContent).toContain("You are invited to the candidate portal"));
    expect(mail.querySelector(".ny-mail-body")?.textContent).toBe("Hello, open your candidate space.");
    fireEvent.click(screen.getByRole("button", { name: "Show original" }));
    expect(mail.textContent).toContain(original.subject);
    expect(mail.querySelector(".ny-mail-body")?.textContent).toBe(original.text);
  });
});
});
