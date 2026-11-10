import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsYouCardTexts, type SpaceNotification } from "@space/contracts";
import { NousNeedsYou } from "../src/features/nous/NousNeedsYou.js";
import { UiLanguageSettingsCard } from "../src/features/ui-language/UiLanguageSettingsCard.js";
import { announceAgentLanguage, announceUiLanguage, uiServerText, uiSourceLabel, uiText } from "../src/features/ui-language/ui-language.js";
import { CopilotRail } from "../src/features/copilot-kit/CopilotRail.js";
import { CompactSideSurfaceDrawer, DockLoading, InlineSideSurface } from "../src/features/docks/SideSurfaceFrame.js";
import type { SideSurfaces } from "../src/features/docks/useSideSurfaces.js";
import { UiText } from "../src/features/ui-language/UiText.js";
import { NotificationToastHost } from "../src/features/notifications/NotificationToastHost.js";
import { pushNotificationToast, resetNotificationStore } from "../src/features/notifications/notification-store.js";
import { NousDone } from "../src/features/nous/NousDone.js";
import { Activity } from "../src/features/ui-theme/app-icons.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
// @ts-expect-error The proof module is plain JavaScript.
import { readNeedsYouCards } from "./needs-you-cards.mjs";

// Operator 1/11 11:59 BKK: with Greek chosen, Needs you speaks Greek, not English by default; an option still goes to the server as asked.
const review = {
  id: "notification:emma", ownerUserId: "user:operator", roomId: "room:cleo00000001", paneId: "pane:emma00000001", source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED",
  severity: "ATTENTION", title: "Reply to the accountant", body: "Approve the reply", link: null, dedupeKey: null, status: "OPEN", createdAt: "2026-11-01T05:00:00.000Z",
  updatedAt: "2026-11-01T05:00:00.000Z", readAt: null, resolvedAt: null, ackedAt: null,
  payload: { ask: { question: "Να σταλεί η απάντηση;", options: ["Approve", "Decline"], recommended: "Approve", answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:x" } } }
} as unknown as SpaceNotification;

let calls: Array<{ url: string; method: string; body: unknown }> = [];
let saved: Record<string, unknown> = {};
let paneBoard: unknown = null;
beforeEach(() => {
  paneBoard = null;
  installSpaceRuntime(liveRuntime);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:lang", headerName: "x-space-csrf-token" });
    if (url === "/api/user-settings" && init?.method === "PATCH") return Response.json({ ...saved, ...JSON.parse(String(init.body)) });
    if (url === "/api/user-settings") return Response.json(saved);
    if (url.endsWith("/answer")) return Response.json({ display: "Approved." });
    if (url === "/api/nous/pane-board" && paneBoard) return Response.json({ board: paneBoard });
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("UI language (operator 1/11 11:59 BKK)", () => {
  it("Needs you in Greek: Space's own words and options are Greek, the option is sent as asked", async () => {
    saved = { voice: { language: "el" } };
    render(<NousNeedsYou requests={[review]} />);
    // Plan clipboard:ytwWl09xNH0Z: closed, a review is its title and «Δες και ενέκρινε»; answered here, its pane is only a link under Details.
    fireEvent.click(await screen.findByRole("button", { name: "Δες και ενέκρινε" }));
    const approve = screen.getByRole("button", { name: "Έγκριση (Προτείνεται)" });
    expect(screen.getByRole("button", { name: "Πήγαινε στο pane" }).closest(".ny-footer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Απόρριψη" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Να σταλεί η απάντηση;" })).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(calls.find((call) => call.url.endsWith("/answer"))?.body).toEqual({ option: "Approve" }));
  });

  it("a card agents wrote in English reads in Greek, explained once under its labels, with its original one click away (operator 1/11 23:09 BKK)", async () => {
    saved = { uiLanguage: "el" };
    announceUiLanguage("el"); announceAgentLanguage("el");
    const english = { ...review, id: "notification:monitoring", source: "MONITORING_COPILOT", kind: "MONITORING_REVIEW", title: "Monitoring Copilot needs you",
      body: "The backup frees 40 GB for tonight's run.\n1. Open https://pve.example.com/#v1\n2. Approve the delete",
      payload: { ask: { question: "Approve data delete on qm:105?", options: ["Approve", "Decline"], recommended: "Approve", answer: { kind: "COPILOT_DECISION", copilot: "MONITORING", item: "REVIEW", itemId: "monrev:1" } } } } as unknown as SpaceNotification;
    const card = { ...english, payload: { ...english.payload, translated: { language: "el", from: needsYouCardTexts(english).from, title: "Το Monitoring Copilot σε χρειάζεται",
      body: "Το αντίγραφο ελευθερώνει 40 GB για απόψε.\n1. Άνοιξε https://pve.example.com/#v1\n2. Ενέκρινε τη διαγραφή", question: "Να διαγραφούν δεδομένα στο qm:105;",
      options: ["Ενέκρινε", "Απόρριψε"] } } } as unknown as SpaceNotification;
    render(<NousNeedsYou requests={[card]} />);
    // Space's ids read as what they name (qm:105 is VM 105); the original keeps them as written.
    expect(await screen.findByRole("heading", { name: "Να διαγραφούν δεδομένα στο VM 105;" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Λεπτομέρειες" }));
    expect(screen.getByText("Τι χρειάζεται")).toBeTruthy();
    expect(screen.getByText("Βήματα")).toBeTruthy();
    expect(screen.getByText("Σύνδεσμοι")).toBeTruthy();
    expect(screen.getByText("Το αντίγραφο ελευθερώνει 40 GB για απόψε.")).toBeTruthy();
    expect(screen.queryByText(/Approve the delete/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Δες το πρωτότυπο" }));
    expect(screen.getByRole("heading", { name: "Approve data delete on qm:105?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Δες τη μετάφραση" }));
    fireEvent.click(screen.getByRole("button", { name: "Ενέκρινε (Προτείνεται)" }));
    await waitFor(() => expect(calls.find((call) => call.url.endsWith("/answer"))?.body).toEqual({ option: "Approve" }));
    // A copilot's card asks its body's first line, clipped: the line shows once, as the heading, and the why is the rest (stable 1/11: Security Copilot card).
    cleanup();
    const line = "db1 Postgres (secfind:r6Xk_dywyK4l, P1): pulled the same pinned tag again and recreated the container.";
    render(<NousNeedsYou requests={[{ ...english, id: "notification:security", body: `${line}\nCost: about 30 s of database downtime.`,
      payload: { ask: { question: `${line.slice(0, 60)}…`, options: ["Approve", "Decline"], recommended: "Approve", answer: { kind: "COPILOT_DECISION", copilot: "SECURITY", item: "REVIEW", itemId: "secrev:1" } } } } as unknown as SpaceNotification]} />);
    expect(await screen.findByRole("heading", { name: "db1 Postgres (εύρημα ασφαλείας, P1): pulled the same pinned tag again and recreated the container." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Λεπτομέρειες" }));
    expect(screen.getByText("Τι χρειάζεται").nextElementSibling?.textContent).toBe("Cost: about 30 s of database downtime.");
    // The Job Copilot's question card starts "Needs you: " and asks the rest of its line, clipped (stable 1/11 00:05 ICT): that line once, as the heading.
    cleanup();
    const asked = "Needs you: Heritage Holdings requires two answers: (1) your Bachelor's GPA and (2) the same for a Master's. Give the grade as on your diploma.";
    render(<NousNeedsYou requests={[{ ...english, id: "notification:job", source: "JOB_COPILOT", kind: "QUESTION", body: `${asked}\nAnswer 'skip' to decline it.`,
      payload: { ask: { question: `${asked.slice(11, 80)}…`, answer: { kind: "COPILOT_QUESTION", copilot: "JOB", questionId: "jq:1" } } } } as unknown as SpaceNotification]} />);
    expect(await screen.findByRole("heading", { name: asked })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Λεπτομέρειες" }));
    expect(screen.getByText("Τι χρειάζεται").nextElementSibling?.textContent).toBe("Answer 'skip' to decline it.");
    // A card whose text changed after it was translated shows its own text, never the old translation.
    cleanup();
    render(<NousNeedsYou requests={[{ ...card, body: "Something new" } as SpaceNotification]} />);
    expect(await screen.findByRole("heading", { name: "Approve data delete on VM 105?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Δες το πρωτότυπο" })).toBeNull();
  });

  it("an agent's card raised in the old layout (Needs:/Options:/Report:) says its ask and its why once, in Greek too (stable 1/11: 9e39e296, 232928ba)", async () => {
    saved = { uiLanguage: "el" };
    announceUiLanguage("el"); announceAgentLanguage("el");
    const words = { language: "el", why: "Τι χρειάζεται", steps: "Βήματα", original: "Δες το πρωτότυπο" };
    const checks = () => (readNeedsYouCards(words) as Array<Record<string, unknown>>).map(({ inLanguage, headingOnce, whyOnce, factLabelsOnce }) => ({ inLanguage, headingOnce, whyOnce, factLabelsOnce }));
    try {
      // Dana's shape: the summary clipped with "…", then "Needs:", then "Report:" and the whole report, which starts with the summary.
      const report = "Contra stopped at its phone check: the site wants a mobile number before it shows the profile form, and the Vault holds none.\nI tried the stored Google sign-in first; it reached the same page.";
      const dana = { ...review, id: "notification:dana-old", source: "AGENT", kind: "NEEDS_YOU", title: "Dana needs you",
        body: [`${report.slice(0, 70)}…`, "Needs: Which mobile number may I give Contra?", "Report:", report].join("\n"),
        payload: { ask: { question: "Which mobile number may I give Contra?", answer: { kind: "PANE" } } } } as unknown as SpaceNotification;
      const greekReport = "Το Contra σταμάτησε στον έλεγχο τηλεφώνου: ο ιστότοπος θέλει κινητό πριν δείξει τη φόρμα του προφίλ, και το Vault δεν έχει κανένα.\nΔοκίμασα πρώτα την αποθηκευμένη σύνδεση Google· έφτασε στην ίδια σελίδα.";
      const danaEl = { ...dana, payload: { ...dana.payload, translated: { language: "el", from: needsYouCardTexts(dana).from, title: "Η Dana σε χρειάζεται",
        body: [`${greekReport.slice(0, 70)}…`, "Χρειάζονται: Ποιο κινητό να δώσω στο Contra;", "Αναφορά:", greekReport].join("\n"), question: "Ποιο κινητό να δώσω στο Contra;", options: [] } } } as unknown as SpaceNotification;
      // Finn's shape: an intro, "Needs:" with a numbered list the question holds only the head of (" … (the whole ask is under Details)"), "Options: …".
      const items = ["1. Your legal name as on your ID.", "2. A payout method for the first invoice.", "3. Your hourly rate floor in EUR, shown to clients on every proposal."];
      const finn = { ...review, id: "notification:finn-old", source: "AGENT", kind: "NEEDS_YOU", title: "Finn needs you",
        body: ["The Braintrust profile is ready except three things only you can give.", `Needs: ${items[0]}`, items[1], items[2], "Options: Give them now | Later today | Skip Braintrust (recommended: Give them now)"].join("\n"),
        payload: { ask: { question: `${items[0]}\n${items[1]} … (the whole ask is under Details)`, options: ["Give them now", "Later today", "Skip Braintrust"], recommended: "Give them now", answer: { kind: "PANE" } } } } as unknown as SpaceNotification;
      const finnEl = { ...finn, payload: { ...finn.payload, translated: { language: "el", from: needsYouCardTexts(finn).from, title: "Ο Finn σε χρειάζεται",
        body: ["Το προφίλ στο Braintrust είναι έτοιμο εκτός από τρία πράγματα που δίνεις μόνο εσύ.", "Απαιτούνται: 1. Το νόμιμο όνομά σου όπως στην ταυτότητα.",
          "2. Τρόπος πληρωμής για το πρώτο τιμολόγιο.", "3. Η ελάχιστη ωριαία χρέωσή σου σε EUR, που βλέπουν οι πελάτες σε κάθε πρόταση.",
          "Επιλογές: Δώσ' τα τώρα | Αργότερα σήμερα | Παράλειψη Braintrust (προτεινόμενο: Δώσ' τα τώρα)"].join("\n"),
        question: "1. Το νόμιμο όνομά σου όπως στην ταυτότητα.\n2. Τρόπος πληρωμής για το πρώτο τιμολόγιο. … (όλο το αίτημα είναι στις Λεπτομέρειες)",
        options: ["Δώσ' τα τώρα", "Αργότερα σήμερα", "Παράλειψη Braintrust"] } } } as unknown as SpaceNotification;
      render(<NousNeedsYou requests={[danaEl, finnEl]} />);
      expect(await screen.findByRole("heading", { name: "Ποιο κινητό να δώσω στο Contra;" })).toBeTruthy();
      const danaCard = screen.getByRole("article", { name: "Η Dana σε χρειάζεται" });
      // One card open at a time (design §3.3): each is read while it is open.
      fireEvent.click(within(danaCard).getByRole("button", { name: "Λεπτομέρειες" }));
      expect(checks()).toEqual(Array(2).fill({ inLanguage: true, headingOnce: true, whyOnce: true, factLabelsOnce: true }));
      expect(danaCard.textContent!.split("Το Contra σταμάτησε").length - 1).toBe(1);
      expect(danaCard.textContent).not.toMatch(/Αναφορά:|Χρειάζονται:/);
      expect(screen.getByRole("heading", { name: "1. Το νόμιμο όνομά σου όπως στην ταυτότητα. 2. Τρόπος πληρωμής για το πρώτο τιμολόγιο. 3. Η ελάχιστη ωριαία χρέωσή σου σε EUR, που βλέπουν οι πελάτες σε κάθε πρόταση." })).toBeTruthy();
      const finnCard = screen.getByRole("article", { name: "Ο Finn σε χρειάζεται" });
      fireEvent.click(within(finnCard).getByRole("button", { name: "Λεπτομέρειες" }));
      expect(finnCard.textContent).not.toMatch(/Απαιτούνται|Επιλογές:|όλο το αίτημα/);
      expect(within(finnCard).queryByText("Βήματα")).toBeNull();
      expect(within(finnCard).getByText("Τι χρειάζεται").nextElementSibling?.textContent).toBe("Το προφίλ στο Braintrust είναι έτοιμο εκτός από τρία πράγματα που δίνεις μόνο εσύ.");
      expect(checks()).toEqual(Array(2).fill({ inLanguage: true, headingOnce: true, whyOnce: true, factLabelsOnce: true }));
      // The original reads the same way: each part once, no labels.
      fireEvent.click(within(finnCard).getByRole("button", { name: "Δες το πρωτότυπο" }));
      expect(screen.getByRole("heading", { name: items.join(" ") })).toBeTruthy();
      expect(checks().map(({ headingOnce, whyOnce }) => ({ headingOnce, whyOnce }))).toEqual(Array(2).fill({ headingOnce: true, whyOnce: true }));
      fireEvent.click(within(danaCard).getByRole("button", { name: "Λεπτομέρειες" }));
      fireEvent.click(within(danaCard).getByRole("button", { name: "Δες το πρωτότυπο" }));
      expect(screen.getByRole("heading", { name: "Which mobile number may I give Contra?" })).toBeTruthy();
      expect(screen.getByRole("article", { name: "Dana needs you" }).textContent).not.toMatch(/Report:|Needs:/);
      expect(checks().map(({ headingOnce, whyOnce }) => ({ headingOnce, whyOnce }))).toEqual(Array(2).fill({ headingOnce: true, whyOnce: true }));
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); }
  });

  it("a card's ids read as what they name and its 'since then' line is the board's Greek line, the toast reads the translation (operator 1/11 23:08 BKK)", async () => {
    saved = { uiLanguage: "el" };
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      const agent = { ...review, id: "notification:dana", source: "AGENT", kind: "NEEDS_YOU", paneId: "pane:dana00000001", title: "Dana needs you",
        body: "Freelancer.com asks for a birth date (flq:U-Ji6bd-RQ2e); Guru wants phone verification for plan clipboard:1cZ-YxU8zS2O.",
        payload: { ask: { question: "Which birth date and phone may I use?", answer: { kind: "PANE" } } } } as unknown as SpaceNotification;
      const at = "2026-11-01T06:00:00.000Z";
      paneBoard = { rooms: [{ roomId: "room:cleo00000001", name: "Cleo", panes: [{ paneId: "pane:dana00000001", roomId: "room:cleo00000001", name: "Dana", mode: "TERMINAL",
        runtimeId: "cli:claude", model: null, state: "working", plan: null, keptOpenForTask: null, prompt: null, notifications: [], decisionIds: [], copilotItems: [],
        report: { at, status: "PROGRESS", summary: "Moved on to Contra while the birth date waits" },
        summary: { line: "Προχωρά στο Contra όσο περιμένει την ημερομηνία γέννησης", waitsOn: "YOU", needsOperator: true, until: null, detail: null, source: "MODEL", model: "haiku", generatedAt: at } }] }],
        paused: null, callsToday: 1, settings: { language: "el" }, generatedAt: at };
      render(<NousNeedsYou requests={[agent]} />);
      fireEvent.click(await screen.findByRole("button", { name: "Λεπτομέρειες" }));
      expect(await screen.findByText(/Προχωρά στο Contra όσο περιμένει/)).toBeTruthy();
      expect(screen.queryByText(/Moved on to Contra/)).toBeNull();
      const why = screen.getByText("Τι χρειάζεται").nextElementSibling?.textContent ?? "";
      expect(why).toBe("Freelancer.com asks for a birth date (ερώτηση freelance); Guru wants phone verification for plan.");
      // The ids stay one click away.
      fireEvent.click(screen.getByRole("button", { name: "Δες το πρωτότυπο" }));
      expect(screen.getByText("Τι χρειάζεται").nextElementSibling?.textContent).toContain("flq:U-Ji6bd-RQ2e");
      expect(screen.getByText(/Moved on to Contra/)).toBeTruthy();
      cleanup();
      // A toast of a translated needs-you card reads in Greek.
      const card = { ...agent, payload: { ...agent.payload, translated: { language: "el", from: needsYouCardTexts(agent).from, title: "Η Dana σε χρειάζεται",
        body: "Το Freelancer.com ζητά ημερομηνία γέννησης.", question: "Ποια ημερομηνία γέννησης;", options: [] } } } as unknown as SpaceNotification;
      render(<NotificationToastHost />);
      pushNotificationToast(card);
      expect(await screen.findByText("Η Dana σε χρειάζεται")).toBeTruthy();
      expect(screen.getByText("Το Freelancer.com ζητά ημερομηνία γέννησης.")).toBeTruthy();
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); resetNotificationStore(null); }
  });

  it("fills a text's slots in either language and keeps English for text the table lacks", () => {
    expect(uiText("el", "Back to {where}", { where: "Cleo" })).toBe("Πίσω στο Cleo");
    expect(uiText("en", "Back to {where}", { where: "Cleo" })).toBe("Back to Cleo");
    expect(uiText("el", "A text nobody translated")).toBe("A text nobody translated");
  });

  it("the lines the server writes into a card read in Greek; the producer's own words stay", () => {
    const body = "• Pay the invoice (Recommended \"Approve\" by your rule [mem:1] \"Pay accountant\".) (Since your answer: the amount changed)\n\nSpace's account facts:\n• Vault: 1 login\n\nRecommended \"Approve\" by your last 6 answers.";
    expect(uiServerText("el", body)).toBe("• Pay the invoice (Προτείνεται «Έγκριση» από τον κανόνα σου [mem:1] «Pay accountant».) (Από την απάντησή σου: the amount changed)\n\nΣτοιχεία λογαριασμών του Space:\n• Vault: 1 login\n\nΠροτείνεται «Έγκριση» από τις τελευταίες 6 απαντήσεις σου.");
    expect(uiServerText("en", body)).toBe(body);
  });

  it("the copilot rails and Done speak Greek too (plan clipboard:32etNsBgtbI- step 3: every pane, not only Needs you)", async () => {
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      const done = { ...review, id: "notification:done1", source: "NOUS", kind: "REQUEST_DONE", title: "Done", body: "Done",
        payload: { request: "Φτιάξε το Go to pane", summary: "Ανοίγει το email.", where: "dev", verified: "Ελέγχθηκε στο dev με το νήμα Mercor." } } as unknown as SpaceNotification;
      render(<>
        <CopilotRail tabs={[{ id: "activity", label: "Activity", icon: Activity, available: true }]} active="activity" collapsed={false} onSelect={() => undefined}><div /></CopilotRail>
        <NousDone requests={[done]} onOpenPlan={() => undefined} onAcknowledged={() => undefined} />
      </>);
      expect(await screen.findByRole("tab", { name: "Δραστηριότητα" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Εντάξει" })).toBeTruthy();
      expect(screen.getByText("Ελέγχθηκε: Ελέγχθηκε στο dev με το νήμα Mercor.")).toBeTruthy();
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); }
  });

  it("the dock shell and the empty room follow the language (plan clipboard:32etNsBgtbI- step 5)", async () => {
    const docks = {
      mountInlineSideSurface: true, showInlineSideSurface: true, showOverlaySideSurface: true, retainCompactSideSurface: true,
      activeSideSurface: "nous", activeSideSurfaceLabel: "Nous", activeSideSurfaceDockTitle: "Nous", activeSideSurfaceCloseLabel: "Close nous",
      navigateDock: () => undefined, setIsDesktopSideSurfaceOpen: () => undefined, closeCompactSideSurface: () => undefined, compactSideSurfaceRef: { current: null }
    } as unknown as SideSurfaces;
    const shell = (<>
      <InlineSideSurface sideSurfaces={docks} launcherActions={[]} renderSurface={() => <DockLoading />} fallback={null} />
      <CompactSideSurfaceDrawer sideSurfaces={{ ...docks, activeSideSurface: "clipboard", activeSideSurfaceDockTitle: "Clipboard", activeSideSurfaceCloseLabel: "Close clipboard" }}
        launcherActions={[]} renderSurface={() => null} fallback={null} />
    </>);
    const { unmount } = render(shell);
    expect(screen.getByText("The mind of SpaceApp: one conversation over every room, pane, copilot and plan.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Close clipboard" }).length).toBe(2);
    unmount();
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      render(shell);
      expect(await screen.findByText("Ο νους του SpaceApp: μία συζήτηση πάνω από κάθε δωμάτιο, pane, copilot και πλάνο.")).toBeTruthy();
      expect(screen.getByText("Πρόχειρο")).toBeTruthy();
      expect(screen.getByText("Αποθηκευμένα κείμενα, σημειώσεις και πλάνα.")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Επόμενο dock" }).length).toBe(2);
      expect(screen.getByRole("button", { name: "Κλείσιμο: Πρόχειρο" })).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("Φόρτωση πάνελ…");
      // The empty room's words (App.tsx's room layers render them through UiText).
      render(<p><UiText text="Start your workspace" /> · <UiText text="Open CLI" /></p>);
      expect(screen.getByText("Ξεκίνα τον χώρο εργασίας σου · Άνοιξε CLI")).toBeTruthy();
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); }
  });

  it("a toast's and a Needs you card's source label follow the language (plan clipboard:32etNsBgtbI- step 6)", async () => {
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      resetNotificationStore("user:operator");
      const handoff = { ...review, id: "notification:handoff", source: "BROWSER_HANDOFF", kind: "HANDOFF_REQUESTED", title: "Sign in" } as unknown as SpaceNotification;
      pushNotificationToast(handoff);
      render(<><NotificationToastHost /><NousNeedsYou requests={[handoff]} /></>);
      const label = (await screen.findAllByText("Περιηγητής")).find((element) => element.classList.contains("notification-toast-source"));
      expect(label?.getAttribute("lang")).toBe("el");
      expect(screen.getByRole("button", { name: "Κλείσιμο ειδοποίησης" })).toBeTruthy();
      expect(document.querySelector(".ny-source")?.textContent).toBe("Περιηγητής");
      // The copilots keep their names in Settings, but a toast names its source in Greek («MAIL COPILOT» was seen on 1/11).
      pushNotificationToast({ ...review, id: "notification:mail", source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", title: "New mail" } as unknown as SpaceNotification);
      expect((await screen.findByText("Βοηθός αλληλογραφίας")).classList.contains("notification-toast-source")).toBe(true);
      expect(uiSourceLabel("el", "ROOM_AGENT")).toBe("Πράκτορας δωματίου");
      expect(uiSourceLabel("en", "MAIL_COPILOT")).toBe("Mail Copilot");
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); resetNotificationStore(null); }
  });

  it("Settings → Language: the interface and the agents' language are two choices, and Needs you follows each at once (operator 2/11 09:51 BKK)", async () => {
    saved = { uiLanguage: "el" };
    announceUiLanguage("el"); announceAgentLanguage("el");
    try {
      render(<><UiLanguageSettingsCard /><NousNeedsYou requests={[review]} /></>);
      // A uiLanguage saved before the split keeps both.
      const ui = await screen.findByRole("combobox", { name: "Γλώσσα περιβάλλοντος" }) as HTMLSelectElement;
      const agents = screen.getByRole("combobox", { name: "Γλώσσα των agents" }) as HTMLSelectElement;
      await waitFor(() => expect([ui.value, agents.value]).toEqual(["el", "el"]));
      expect([...ui.options].map((option) => option.textContent)).toEqual(["English", "Ελληνικά"]);
      // His choice: Space's labels in English, what agents write in Greek.
      fireEvent.change(ui, { target: { value: "en" } });
      await waitFor(() => expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ uiLanguage: "en", agentLanguage: "el" }));
      fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
      expect(screen.getByRole("button", { name: "Έγκριση (Recommended)" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Να σταλεί η απάντηση;" })).toBeTruthy();
      fireEvent.change(screen.getByRole("combobox", { name: "Agent language" }), { target: { value: "en" } });
      await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ agentLanguage: "en" }));
      expect(await screen.findByRole("button", { name: "Approve (Recommended)" })).toBeTruthy();
    } finally { announceUiLanguage("en"); announceAgentLanguage("en"); }
  });
});
