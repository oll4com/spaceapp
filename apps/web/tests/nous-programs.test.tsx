import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NousProgram } from "@space/contracts";
import { amountRange, approvedTotals, approvedUsed, monthlyTotal, nextDate, NousPrograms, programTags, programUsage, usedPercent } from "../src/features/nous/NousPrograms.js";
import { announceUiLanguage } from "../src/features/ui-language/ui-language.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Startup programs (operator 3/11 20:09 BKK, plan clipboard:17yLAnH5ZpyF): counts on top that filter, the total
// approved, search, one line per program under its parent (or project); details and the mail timeline open only on a click.
const base: NousProgram = { id: "x", page: "startup", parent: "NVIDIA", program: "x", project: "SpaceApp", url: null, status: "APPLIED", statusReason: null,
  appliedAt: null, decidedAt: null, expectedReplyBy: null, validUntil: null, amount: null, commitments: null, account: null, contacts: [], mails: [], nextAction: null,
  reapply: null, sources: [], notes: null, givesMoney: null, tags: [], whatItIs: null, howWeUse: null, benefits: [], tiers: [], createdAt: "2026-11-03T10:00:00.000Z", updatedAt: "2026-11-03T10:00:00.000Z" };
const programs: NousProgram[] = [
  { ...base, id: "nvidia-inception", program: "NVIDIA Inception", status: "APPROVED", givesMoney: true, url: "https://www.nvidia.com/startups/", amount: { text: "$10.000 AWS credits", value: 10000, currency: "USD" },
    commitments: "Keep the profile current", account: "ntheo@spaceapp.dev", decidedAt: "2026-10-22T09:00:00.000Z",
    whatItIs: "NVIDIA's program for AI startups", howWeUse: "AWS credits for SpaceApp's GPU tests; nothing from you",
    mails: [{ date: "2026-10-21T08:00:00.000Z", direction: "SENT", from: "ntheo@spaceapp.dev", to: ["inception@nvidia.com"], subject: "Inception application",
      gmailAccount: "ntheo@spaceapp.dev", threadId: "19a0b2c3d4" }] },
  { ...base, id: "nvidia-dli", program: "Deep Learning Institute", status: "IN_PROGRESS", givesMoney: false, amount: { text: "2 course credits", value: null, currency: null } },
  { ...base, id: "google-cloud", parent: "Google", program: "Google for Startups Cloud", status: "REJECTED", givesMoney: true, statusReason: "Founding team not verified",
    reapply: { needed: true, why: "Appeal #00317095 open", when: "2099-11-10T00:00:00.000Z" }, amount: { text: "€5.000", value: 5000, currency: "EUR" } },
  { ...base, id: "microsoft-hub", parent: "Microsoft", program: "Founders Hub", project: "Nous Pro", expectedReplyBy: "2026-10-01T00:00:00.000Z" }
];

function serve(list = programs) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("/api/nous/programs")) return Response.json({ programs: list });
    if (url === "/api/admin/gateway/pool-models") return Response.json({ data: [{ provider: "NVIDIA", models: ["meta/llama-3.3-70b-instruct", "qwen/qwen3-coder"], error: null },
      { provider: "AGENTROUTER", models: null, error: "AgentRouter answered HTTP 401 to its model list." }], fetchedAt: "2026-11-07T00:00:00.000Z" });
    return Response.json({});
  }));
  return urls;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("counts, filters, searches and groups the page's programs, and opens a program only when clicked", async () => {
  const urls = serve();
  render(<NousPrograms page="startup" active />);
  const counts = await screen.findByRole("group", { name: "Show programs" });
  expect(urls).toContain("/api/nous/programs?page=startup");
  expect([...counts.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["All4", "Approved1", "In progress1", "Waiting1", "Rejected1", "To re-apply1", "Other0"]);
  // Only approved amounts with a number count: Google's €5.000 was rejected; NVIDIA's AWS credits are not cash.
  expect(document.querySelector(".nous-programs-total")!.textContent).toMatch(/^Approved in totalCash: \$0Credits & perks \(not cash\): \$10,000$/);
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google", "Microsoft", "NVIDIA"]);
  const google = within(screen.getByRole("region", { name: "Google" })).getByRole("button");
  expect(google.textContent).toContain("Re-apply");
  expect(google.getAttribute("aria-expanded")).toBe("false");
  expect(within(screen.getByRole("region", { name: "Microsoft" })).getByRole("button").textContent).toContain("Reply overdue since");
  // Nothing open until clicked.
  expect(screen.queryByText("Open in Gmail")).toBeNull();
  const inception = within(screen.getByRole("region", { name: "NVIDIA" })).getByRole("button", { name: /NVIDIA Inception/ });
  fireEvent.click(inception);
  expect(inception.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Keep the profile current")).toBeTruthy();
  // R73 (operator 4/11 15:09 BKK): what it is and how we use it lead the opened card.
  expect([...document.querySelectorAll(".nous-program-body > dl:first-child dt")].map((label) => label.textContent)).toEqual(["What it is", "How we use it"]);
  expect(screen.getByText("AWS credits for SpaceApp's GPU tests; nothing from you")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open in Gmail" }).getAttribute("href")).toBe("https://mail.google.com/mail/u/?authuser=ntheo%40spaceapp.dev#all/19a0b2c3d4");
  expect(screen.getByRole("link", { name: "Program page" }).getAttribute("rel")).toBe("noopener noreferrer");
  fireEvent.click(within(counts).getByRole("button", { name: /^Rejected/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google"]);
  fireEvent.click(within(counts).getByRole("button", { name: /^All/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search programs" }), { target: { value: "founders" } });
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Microsoft"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search programs" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "By project" }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Nous Pro", "SpaceApp"]);
});

// Affiliate (operator 14/11 00:07 BKK, nous_msg:de448bc711204fdb832cf926): the same page on its own rows, with what each approval gives.
it("reads the Affiliate page's own rows, shows the network and commission on the line and every approval fact once opened, without the grant types", async () => {
  const banggood: NousProgram = { ...base, id: "banggood-affiliate", page: "affiliate", parent: "Banggood", program: "Banggood Affiliate", project: null, status: "APPROVED",
    commitments: "No brand bidding", affiliate: { network: "Direct", publisherId: "BG111421424", commission: "Up to 8%", cookieDays: 30,
      trackingLink: "https://www.banggood.com/?p=YJ0321", couponFeed: "Coupon feed in the dashboard", payout: "PayPal, $50 minimum", signIn: "vault_item:6OAgXDcmj74EV27JrFjuuA" } };
  const urls = serve([banggood, { ...base, id: "webgains", page: "affiliate", parent: "Webgains", program: "Webgains", project: null, affiliate: { network: "Webgains",
    publisherId: null, commission: null, cookieDays: null, trackingLink: null, couponFeed: null, payout: null, signIn: null } }]);
  render(<NousPrograms page="affiliate" active />);
  const line = await screen.findByRole("button", { name: /Banggood Affiliate/ });
  expect(urls).toContain("/api/nous/programs?page=affiliate");
  expect(urls).not.toContain("/api/admin/gateway/pool-models");
  expect(screen.queryByRole("group", { name: "Program types" })).toBeNull();
  expect(line.textContent).toContain("Direct · Up to 8%");
  expect(line.querySelector(".nous-program-tag")).toBeNull();
  fireEvent.click(line);
  const facts = document.querySelector<HTMLElement>('.nous-program-body dl[aria-label="Affiliate"]')!;
  expect([...facts.querySelectorAll("dt")].map((label) => label.textContent)).toEqual(["Network", "Publisher ID", "Commission", "Cookie days", "Tracking link", "Coupons and feed",
    "Payout", "Sign-in (Vault)"]);
  expect(within(facts).getByText("vault_item:6OAgXDcmj74EV27JrFjuuA")).toBeTruthy();
  expect(screen.getByText("No brand bidding")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search programs" }), { target: { value: "BG111421424" } });
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Banggood"]);
});

// Operator 7/11 16:19 BKK (nous_msg:8cb6b284): every approved row shows the whole grant's indicative value, from the same worth() as the totals.
it("shows an approved row's indicative value from its amount or its monthly benefits, and no chip without a number", async () => {
  const line = { what: "Pro plan", account: null, perMonth: null, total: null, used: null, remaining: null, usageAt: null, validUntil: null, status: "ACTIVE" as const,
    source: null, notes: null, allocations: [] };
  serve([programs[0]!, programs[2]!,
    { ...base, id: "composio", parent: "Composio", program: "Composio Pro", status: "APPROVED", amount: { text: "6 months of Pro", value: null, currency: null },
      decidedAt: "2026-11-01T00:00:00.000Z", validUntil: "2027-05-01T00:00:00.000Z", benefits: [{ ...line, perMonth: { text: "$29", value: 29, currency: "USD" } }] },
    { ...base, id: "dli", parent: "NVIDIA", program: "DLI", status: "APPROVED", benefits: [{ ...line, what: "Course codes", total: { text: "20 course codes", value: 20, currency: null } }] }]);
  render(<NousPrograms page="startup" active />);
  const worth = async (name: RegExp) => (await screen.findByRole("button", { name })).querySelector(".nous-program-worth");
  const inception = await worth(/NVIDIA Inception/);
  expect(inception?.textContent).toBe("≈ $10,000");
  expect(inception?.getAttribute("title")).toBe("Indicative value of the whole grant");
  expect(screen.getByText("$10.000 AWS credits")).toBeTruthy();
  expect((await worth(/Composio Pro/))?.textContent).toBe("≈ $174");
  // A count is not dollars, and a rejected €5.000 is no approved value.
  expect(await worth(/DLI/)).toBeNull();
  expect(await worth(/Google for Startups Cloud/)).toBeNull();
});

it("speaks Greek when the interface language is Greek", async () => {
  serve();
  try {
    act(() => announceUiLanguage("el"));
    render(<NousPrograms page="startup" active />);
    const counts = await screen.findByRole("group", { name: "Εμφάνιση προγραμμάτων" });
    expect(within(counts).getByRole("button", { name: /^Να ξανασταλούν/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ανά κορμό" })).toBeTruthy();
  } finally { act(() => announceUiLanguage("en")); }
});

it("shows an empty page with how it fills", async () => {
  serve([]);
  render(<NousPrograms page="startup" active />);
  expect(await screen.findByText("No programs yet")).toBeTruthy();
});

it("sums approved amounts per currency in two lines, cash and credits, a recurring benefit for its months, and picks the soonest date ahead", () => {
  const usd = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  const eur = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
  const seat = { what: "Premium seats", account: null, perMonth: { text: "$18", value: 18, currency: "USD" }, total: null, used: null, remaining: null, usageAt: null,
    validUntil: "2027-05-01T00:00:00.000Z", status: "ACTIVE" as const, source: null, notes: null, allocations: [] };
  const list: NousProgram[] = [...programs,
    { ...base, id: "eu-grant", parent: "EU", program: "Founders grant", status: "APPROVED", tags: ["cash-grants"], amount: { text: "€50,000 non-dilutive", value: 50000, currency: "EUR" } },
    // The registry's own words: Claude for Startups is AI tokens, never cash, whatever its tags say.
    { ...base, id: "anthropic-claude-for-startups", parent: "Anthropic", program: "Claude for Startups", status: "APPROVED", tags: ["ai-tokens", "cash-grants", "dev-tools", "perks"],
      amount: { text: "$7,000 a year API credits ($500/month Team + $1,000 once)", value: 7000, currency: "USD" } },
    { ...base, id: "tailscale", parent: "Tailscale", program: "Tailscale for Startups", status: "APPROVED", tags: ["cash-grants", "perks"], decidedAt: "2026-11-01T00:00:00.000Z",
      amount: { text: "Premium plan free", value: null, currency: null }, benefits: [seat] },
    { ...base, id: "bounty", parent: "OpenAI", program: "Security Bug Bounty", status: "REJECTED", tags: ["cash-grants"], amount: { text: "$20,000", value: 20000, currency: "USD" } }];
  // 10,000 (NVIDIA) + 7,000 (Claude) + 18 × 6 months (Tailscale's seats, 1 Nov to 1 May); the rejected bounty is out.
  expect(approvedTotals(list)).toMatchObject({ cash: eur(50000), credits: usd(17108) });
  expect(approvedTotals([...list.slice(0, -2), { ...list.at(-2)!, decidedAt: null }]).credits).toBe(usd(17216));
  expect(approvedTotals([])).toMatchObject({ cash: null, credits: null });
  // Operator 7/11 (nous_msg:f4e5cdfaffa440a8bd7ad0d6): an approval whose credit is not applied yet counts, each currency on its own, cents kept.
  const cents = (value: number, currency: string) => new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  const pending = approvedTotals([{ ...base, id: "upcloud", parent: "UpCloud", program: "UpCloud for Startups", status: "APPROVED", nextAction: "Credit not applied yet",
    amount: { text: "€5,000 cloud credits", value: 5000, currency: "EUR" } }, { ...base, id: "small", parent: "OpenAI", program: "API credits", status: "APPROVED",
    amount: { text: "$52.78 API credits", value: 52.78, currency: "usd" } }]);
  expect([pending.cash, pending.credits]).toEqual([null, `${eur(5000)} · ${cents(52.78, "USD")}`]);
  const now = Date.parse("2026-11-03T12:00:00Z");
  expect(nextDate({ ...base, expectedReplyBy: "2026-11-20T00:00:00.000Z", validUntil: "2026-11-10T00:00:00.000Z" }, now)).toEqual({ label: "Valid until", at: "2026-11-10T00:00:00.000Z" });
  expect(nextDate({ ...base, expectedReplyBy: "2026-11-01T00:00:00.000Z" }, now)).toMatchObject({ label: "Reply overdue since", overdue: true });
  expect(nextDate({ ...base, status: "APPROVED", expectedReplyBy: "2026-11-20T00:00:00.000Z" }, now)).toBeNull();
});

it("shows what a program gave, line by line, and its tiers with what comes if approved, only once opened", async () => {
  const claude = { ...base, id: "claude", parent: "Anthropic", program: "Claude for Startups", status: "APPROVED" as const, nextAction: "Ask for the next grant",
    amount: { text: "$1,000", value: 1000, currency: "USD" },
    benefits: [
      { what: "API credits", account: "crew@spaceapp.dev", perMonth: null, total: { text: "$1,000", value: 1000, currency: "USD" }, used: { text: "$250", value: 250, currency: "USD" },
        remaining: null, usageAt: "2026-11-03T00:00:00.000Z", validUntil: "2027-10-09T00:00:00.000Z", status: "ACTIVE" as const, source: "mail 9/10", notes: null,
        allocations: [{ project: "spaceapp.dev", percent: 75, purpose: "Nous" }, { project: "oll4.com", percent: 25, purpose: null }] },
      { what: "Team plan seat", account: "dev@spaceapp.dev", perMonth: { text: "$30", value: 30, currency: "USD" }, total: null, used: null, remaining: null, usageAt: null,
        validUntil: null, status: "NOT_VERIFIED" as const, source: null, notes: null, allocations: [] }
    ],
    tiers: [
      { name: "Registered", status: "REACHED" as const, requires: null, gives: "Portal access", amount: null, source: null },
      { name: "Select", status: "PENDING" as const, requires: "Technical assessment", gives: "Co-sell", amount: { text: "$5,000 credits", value: 5000, currency: "USD" }, source: null }
    ] };
  serve([claude]);
  render(<NousPrograms page="startup" active />);
  const head = await screen.findByRole("button", { name: /Claude for Startups/ });
  expect(head.textContent).toContain("2 benefits");
  expect(screen.queryByRole("region", { name: "What we got" })).toBeNull();
  fireEvent.click(head);
  const got = screen.getByRole("region", { name: "What we got" });
  expect(within(got).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent)).toEqual(["API credits", "Team plan seat"]);
  expect(within(got).getAllByRole("listitem")[0]!.textContent).toContain("Account crew@spaceapp.dev");
  expect(within(got).getByText("Source: mail 9/10")).toBeTruthy();
  expect(within(got).getAllByRole("listitem")[0]!.textContent).toContain("Usage used $250 · as of");
  expect(within(got).getByText("25% used")).toBeTruthy();
  expect(document.querySelector(".nous-programs-total")!.textContent).toMatch(/Credits & perks \(not cash\): \$1,000 · Used 25% \(\$250(\.00)?\)$/);
  expect(within(got).getByText("Not verified")).toBeTruthy();
  expect(within(got).getByTitle("Nous").textContent).toBe("spaceapp.dev 75%");
  const tiers = screen.getByRole("region", { name: "Tiers and next step" });
  expect(tiers.textContent).toContain("Ask for the next grant");
  expect(tiers.querySelector(".nous-program-if-approved")?.textContent).toBe("If approved: Select — Co-sell ($5,000 credits)");
});

it("sums active monthly values and works out usage from what is left", () => {
  const line = { what: "x", account: null, perMonth: { text: "$30", value: 30, currency: "USD" }, total: { text: "$100", value: 100, currency: "USD" }, used: null,
    remaining: { text: "$40", value: 40, currency: "USD" }, usageAt: null, validUntil: null, status: "ACTIVE" as const, source: null, notes: null, allocations: [] };
  expect(usedPercent(line)).toBe(60);
  expect(usedPercent({ ...line, remaining: null })).toBeNull();
  const approved = (value: number, used: number | null, currency = "USD") => ({ ...base, status: "APPROVED" as const, amount: { text: "x", value, currency },
    benefits: used === null ? [] : [{ ...line, total: { text: "t", value, currency }, used: { text: "u", value: used, currency } }] });
  expect(approvedUsed([approved(12_668, 499.6), approved(4_000, 0), { ...approved(1_000, 1_000), status: "REJECTED" as const }]))
    .toBe(`3%${" "}(${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(499.6)})`);
  expect(approvedUsed([approved(100, null)])).toBeNull();
  expect(monthlyTotal([line, line, { ...line, status: "EXPIRED" }])).toBe(new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(60));
});

it("counts the type chips among the selected status, dims the empty ones and keeps the chosen type when the status changes (operator 7/11, nous_msg:e7255379)", async () => {
  serve([...programs, { ...base, id: "eu-grant", parent: "EU", program: "Founders grant", status: "APPROVED", tags: ["cash-grants"], amount: { text: "€50,000 non-dilutive", value: 50000, currency: "EUR" } }]);
  render(<NousPrograms page="startup" active />);
  const counts = await screen.findByRole("group", { name: "Show programs" });
  const types = screen.getByRole("group", { name: "Program types" });
  const chips = () => [...types.querySelectorAll("button")].map((button) => `${button.textContent}${button.disabled ? " (dimmed)" : ""}`);
  expect(screen.queryByText(/money/i)).toBeNull();
  expect(chips()).toEqual(["Cash1", "AI tokens0 (dimmed)", "Servers/Cloud2", "Dev tools0 (dimmed)", "Perks2", "Choose0 (dimmed)"]);
  fireEvent.click(within(counts).getByRole("button", { name: /^Approved/ }));
  expect(chips()).toEqual(["Cash1", "AI tokens0 (dimmed)", "Servers/Cloud1", "Dev tools0 (dimmed)", "Perks0 (dimmed)", "Choose0 (dimmed)"]);
  fireEvent.click(within(types).getByRole("button", { name: /^Servers\/Cloud/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["NVIDIA"]);
  fireEvent.click(within(counts).getByRole("button", { name: /^Rejected/ }));
  // The type stays chosen; the list is both, the status counts follow the type.
  expect(within(types).getByRole("button", { name: /^Servers\/Cloud/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google"]);
  expect(chips()).toEqual(["Cash0 (dimmed)", "AI tokens0 (dimmed)", "Servers/Cloud1", "Dev tools0 (dimmed)", "Perks0 (dimmed)", "Choose0 (dimmed)"]);
  expect(within(counts).getByRole("button", { name: /^Approved/ }).textContent).toBe("Approved1");
});

it("lists an approval still awaiting completion under Approved and Waiting, badged approved, counted once (operator 11/11, nous_msg:a5e13d01)", async () => {
  serve([...programs, { ...base, id: "nvidia-partner-aws-10k", program: "AWS Activate $10,000", status: "APPROVED", awaitingCompletion: true,
    amount: { text: "$10,000 AWS credits", value: 10000, currency: "USD" } }]);
  render(<NousPrograms page="startup" active />);
  const counts = await screen.findByRole("group", { name: "Show programs" });
  expect([...counts.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["All5", "Approved2", "In progress1", "Waiting2", "Rejected1", "To re-apply1", "Other0"]);
  expect(document.querySelector(".nous-programs-total")!.textContent).toContain("$20,000");
  const shown = () => [...document.querySelectorAll(".nous-program-name")].map((name) => name.firstChild!.textContent);
  fireEvent.click(within(counts).getByRole("button", { name: /^Waiting/ }));
  expect(shown()).toEqual(["Founders Hub", "AWS Activate $10,000"]);
  const aws = screen.getByRole("button", { name: /AWS Activate/ });
  expect(aws.textContent).toContain("Approved · waiting for completion");
  expect(aws.textContent).not.toContain("Waiting for a reply");
  fireEvent.click(within(counts).getByRole("button", { name: /^Approved/ }));
  expect(shown()).toEqual(["NVIDIA Inception", "AWS Activate $10,000"]);
  expect(screen.getByRole("button", { name: /NVIDIA Inception/ }).textContent).not.toContain("waiting for completion");
});

it("filters by a grouped tag with the status chips, and badges each line (operator 6/11 21:42 BKK, nous_msg:f0287998)", async () => {
  const openai = { ...base, id: "openai-credits", parent: "OpenAI", program: "Startup credits", status: "APPROVED" as const, givesMoney: true, tags: ["ai-tokens", "cash-grants"],
    amount: { text: "$2,500 API credits", value: 2500, currency: "USD" } };
  serve([...programs, openai]);
  render(<NousPrograms page="startup" active />);
  const counts = await screen.findByRole("group", { name: "Show programs" });
  // The files' tags first; a line without them reads its words (AWS, Cloud: Servers/Cloud; none of the four: Perks). OpenAI's API credits are not cash.
  const chip = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label.replace(/[/]/g, "\\$&")}\\d`) });
  expect(["Cash", "AI tokens", "Servers/Cloud", "Dev tools", "Perks"].map((label) => chip(label).textContent))
    .toEqual(["Cash0", "AI tokens1", "Servers/Cloud2", "Dev tools0", "Perks2"]);
  const line = (name: RegExp) => screen.getByRole("button", { name });
  expect([...line(/Startup credits/).querySelectorAll(".nous-program-tag:not([class*=is-usage])")].map((badge) => badge.textContent)).toEqual(["AI tokens"]);
  expect([...line(/NVIDIA Inception/).querySelectorAll(".nous-program-tag:not([class*=is-usage])")].map((badge) => badge.textContent)).toEqual(["Servers/Cloud"]);
  fireEvent.click(chip("Servers/Cloud"));
  expect(chip("Servers/Cloud").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google", "NVIDIA"]);
  expect(within(counts).getByRole("button", { name: /^All/ }).textContent).toBe("All2");
  // The totals follow the tag: OpenAI's approved $2,500 is out.
  expect(document.querySelector(".nous-programs-total")!.textContent).toMatch(/\$10,000$/);
  fireEvent.click(within(counts).getByRole("button", { name: /^Rejected/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google"]);
  fireEvent.click(within(counts).getByRole("button", { name: /^All/ }));
  fireEvent.click(chip("AI tokens"));
  expect(chip("Servers/Cloud").getAttribute("aria-pressed")).toBe("false");
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["OpenAI"]);
  fireEvent.click(chip("AI tokens"));
  expect(screen.getAllByRole("region")).toHaveLength(4);
  expect(programTags({ ...base, program: "Sentry for Startups", whatItIs: "Error monitoring SaaS" })).toEqual(["dev-tools"]);
  expect(programTags({ ...base, program: "Founders grant", amount: { text: "€50,000 non-dilutive", value: 50000, currency: "EUR" } })).toEqual(["cash-grants"]);
  // Operator 7/11 (nous_msg:02ad746e): Codex and the Gateway pools are AI tokens only, a cloud provider Servers/Cloud only, Cash only money paid.
  expect(programTags({ ...base, id: "openai-codex-oss", parent: "OpenAI", program: "Open Source Developer Grant", tags: ["ai-tokens", "cash-grants", "perks"] })).toEqual(["ai-tokens"]);
  expect(programTags({ ...base, id: "agentrouter-free-credits", parent: "AgentRouter", program: "Sign-up credits" })).toEqual(["ai-tokens"]);
  expect(programTags({ ...base, parent: "UpCloud", program: "UpCloud for Startups", tags: ["server-access", "dev-tools", "perks"] })).toEqual(["server-access"]);
  expect(programTags({ ...base, parent: "Kiro AI / AWS", program: "Kiroween 2026 Hackathon", tags: ["server-access", "cash-grants"], amount: { text: "$20,000 Cash and AWS Compute Credits", value: 20000, currency: "USD" } })).toEqual(["server-access", "cash-grants"]);
  expect(programTags({ ...base, program: "Inception", tags: ["cash-grants", "perks"], amount: { text: "Membership (no cash value)", value: null, currency: null } })).toEqual(["perks"]);
  expect(programTags({ ...base, program: "Partner Network", tags: ["cash-grants", "perks"], amount: { text: "Registered Partner: no credits or funding", value: 0, currency: "USD" } })).toEqual(["perks"]);
  expect(programTags({ ...base, program: "Cybersecurity Grant Program", tags: ["cash-grants"], amount: { text: "$10,000 in API credits", value: 10000, currency: "USD" } })).toEqual(["perks"]);
  expect(programTags({ ...base, program: "GenAI Bug Bounty", tags: ["ai-tokens", "cash-grants"], amount: { text: "Low $500, Severe $15,000", value: 15000, currency: "USD" } }))
    .toEqual(["ai-tokens", "cash-grants"]);
});

it("marks the programs worth joining with Choose on top of their type, and the totals follow its chip (operator 13/11, plan clipboard:mmmeF0-e3x4G)", async () => {
  // choose rides along the type paths that ignore stored tags (a cloud provider, the AI-token programs) and never replaces a type.
  expect(programTags({ ...base, parent: "UpCloud", program: "UpCloud for Startups", tags: ["server-access", "perks", "choose"] })).toEqual(["server-access", "choose"]);
  expect(programTags({ ...base, id: "codex-x", parent: "OpenAI", program: "Codex", tags: ["choose"] })).toEqual(["ai-tokens", "choose"]);
  expect(programTags({ ...base, program: "Sentry for Startups", whatItIs: "Error monitoring SaaS", tags: ["choose"] })).toEqual(["dev-tools", "choose"]);
  const pick = (id: string, value: number, tags: string[]) => ({ ...base, id, parent: id, program: `${id} credits`, status: "APPROVED" as const, tags,
    amount: { text: `$${value} credits`, value, currency: "USD" } });
  serve([pick("chosen", 4000, ["ai-tokens", "choose"]), pick("other", 6000, ["dev-tools"])]);
  render(<NousPrograms page="startup" active />);
  fireEvent.click(await screen.findByRole("button", { name: /^Choose1/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["chosen"]);
  expect([...screen.getByRole("button", { name: /chosen credits/ }).querySelectorAll(".nous-program-tag:not([class*=is-usage])")].map((badge) => badge.textContent)).toEqual(["AI tokens", "Choose"]);
  expect(document.querySelector(".nous-programs-total")!.textContent).toMatch(/\$4,000$/);
});

it("shows on an AI-token program's line the Space Gateway pool its credits feed, and that pool's supported models once opened (7/11)", async () => {
  serve([...programs, { ...base, id: "nvidia-nim", program: "NVIDIA NIM", status: "APPROVED", tags: ["ai-tokens"] },
    { ...base, id: "agentrouter-free-credits", parent: "AgentRouter", program: "AgentRouter credits", status: "APPROVED", tags: ["ai-tokens"] }]);
  render(<NousPrograms page="startup" active />);
  const nim = await screen.findByRole("button", { name: /NVIDIA NIM/ });
  await within(nim).findByText("Space Gateway · 2 models");
  expect(screen.queryByText("qwen/qwen3-coder")).toBeNull();
  fireEvent.click(nim);
  expect(screen.getByText("Supported models (2)")).toBeTruthy();
  expect(screen.getByText("qwen/qwen3-coder")).toBeTruthy();
  const relay = screen.getByRole("button", { name: /AgentRouter credits/ });
  expect(within(relay).getByText("Space Gateway").getAttribute("title")).toBe("AgentRouter answered HTTP 401 to its model list.");
  fireEvent.click(relay);
  expect(screen.getByText(/AgentRouter answered HTTP 401 to its model list\./, { selector: "p" })).toBeTruthy();
  // Rows no pool spends show none.
  expect(within(screen.getByRole("button", { name: /Deep Learning Institute/ })).queryByText(/Space Gateway/)).toBeNull();
});

it("badges each line with the company that applied and filters by it with the type and status chips (operator 16/11, nous_msg:52aab269)", async () => {
  serve(programs.map((program) => program.id === "nvidia-inception" || program.id === "google-cloud" ? { ...program, company: "INTRATRADE" } : program));
  render(<NousPrograms page="startup" active />);
  const companies = await screen.findByRole("group", { name: "Applying companies" });
  expect([...companies.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["INTRATRADE2"]);
  expect(screen.getByRole("button", { name: /NVIDIA Inception/ }).querySelector(".nous-program-tag.is-company")!.textContent).toBe("INTRATRADE");
  expect(screen.getByRole("button", { name: /Deep Learning Institute/ }).querySelector(".nous-program-tag.is-company")).toBeNull();
  fireEvent.click(within(companies).getByRole("button", { name: /^INTRATRADE/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google", "NVIDIA"]);
  fireEvent.click(within(screen.getByRole("group", { name: "Show programs" })).getByRole("button", { name: /^Rejected/ }));
  expect(screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"))).toEqual(["Google"]);
});

// Operator 26/11 10:14 BKK (nous_msg:36bdf34f): which programs we use, and amount ranges that can be picked together.
type Line = NousProgram["benefits"][number];
const usd = (value: number) => ({ text: `$${value}`, value, currency: "USD" });
const line = (status: Line["status"], used: number | null, more: Partial<Line> = {}): Line => ({ what: "Credits", account: null, perMonth: null,
  total: usd(100), used: used === null ? null : usd(used), remaining: null, usageAt: null, validUntil: null, status, source: null, notes: null, allocations: [], ...more });

it("derives whether a program is in use from its benefit lines, and Unknown when nothing says", () => {
  const approved = { ...base, status: "APPROVED" as const };
  expect(programUsage(base)).toBe("unused");
  expect(programUsage(approved)).toBe("unknown");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", 0.02)] })).toBe("used");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", null, { remaining: usd(90) })] })).toBe("used");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", null, { allocations: [{ project: "SpaceApp", percent: null, purpose: null }] })] })).toBe("used");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", 0)] })).toBe("unused");
  expect(programUsage({ ...approved, benefits: [line("EXPIRED", null)] })).toBe("unused");
  expect(programUsage({ ...approved, benefits: [line("USED_UP", 100)] })).toBe("used");
  // Operator 26/11 (nous_msg:2d0eb603): "not in use" only from evidence; a line not measured, still pending or awaiting completion is unknown.
  expect(programUsage({ ...approved, benefits: [line("PENDING", 0)] })).toBe("unknown");
  expect(programUsage({ ...approved, awaitingCompletion: true })).toBe("unknown");
  expect(programUsage({ ...approved, awaitingCompletion: true, benefits: [line("ACTIVE", 5)] })).toBe("used");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", 0), line("ACTIVE", null)] })).toBe("unknown");
  // A verified usage wins over the lines.
  const checked = { evidence: "UpCloud server fi-hel2 running", checkedAt: "2026-11-26T00:00:00.000Z" };
  expect(programUsage({ ...approved, awaitingCompletion: true, usage: { state: "USED", ...checked } })).toBe("used");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", 3)], usage: { state: "UNUSED", ...checked } })).toBe("unused");
  expect(programUsage({ ...base, usage: { state: "USED", ...checked } })).toBe("unused");
  expect(programUsage({ ...approved, benefits: [line("NOT_VERIFIED", null)] })).toBe("unknown");
  expect(programUsage({ ...approved, benefits: [line("ACTIVE", null)] })).toBe("unknown");
});

it("buckets a program's value into the amount ranges at their edges", () => {
  const worth = (value: number | null, currency: string | null = "USD") => amountRange({ ...base, amount: { text: "x", value, currency } });
  expect([10_001, 10_000, 5_000, 4_999, 1_000, 999, 0].map((value) => worth(value))).toEqual(["over10k", "5k-10k", "5k-10k", "1k-5k", "1k-5k", "under1k", "under1k"]);
  expect(worth(6_000, "EUR")).toBe("5k-10k");
  expect(worth(null)).toBeNull();
  expect(worth(20, null)).toBeNull();
  expect(amountRange({ ...base, benefits: [line("ACTIVE", 0, { total: usd(700) }), line("ACTIVE", 0, { total: usd(700) })] })).toBe("1k-5k");
});

it("filters by usage and by any picked amount ranges together with the other chips, with counts and a usage badge on each line", async () => {
  serve([...programs, { ...base, id: "claude", parent: "Anthropic", program: "Claude for Startups", status: "APPROVED", amount: usd(7000),
    benefits: [line("ACTIVE", 1468.28, { total: usd(7000) })] }]);
  render(<NousPrograms page="startup" active />);
  const usage = await screen.findByRole("group", { name: "Program usage" });
  const amounts = screen.getByRole("group", { name: "Program amounts" });
  const chips = (group: HTMLElement) => [...group.querySelectorAll("button")].map((button) => button.textContent);
  const shown = () => screen.getAllByRole("region").map((group) => group.getAttribute("aria-label"));
  expect(chips(usage)).toEqual(["In use1", "Not in use3", "Usage unknown1"]);
  expect(chips(amounts)).toEqual(["> 10,0000", "5,000–10,0003", "1,000–5,0000", "< 1,0000"]);
  expect(screen.getByRole("button", { name: /Claude for Startups/ }).querySelector(".is-usage-used")?.textContent).toBe("In use");
  fireEvent.click(within(amounts).getByRole("button", { name: /^5,000–10,000/ }));
  fireEvent.click(within(amounts).getByRole("button", { name: /^< 1,000/ }));
  expect(shown().sort()).toEqual(["Anthropic", "Google", "NVIDIA"]);
  expect(chips(usage)).toEqual(["In use1", "Not in use1", "Usage unknown1"]);
  fireEvent.click(within(usage).getByRole("button", { name: /^In use/ }));
  expect(shown()).toEqual(["Anthropic"]);
  expect(chips(amounts)).toEqual(["> 10,0000", "5,000–10,0001", "1,000–5,0000", "< 1,0000"]);
  fireEvent.click(within(usage).getByRole("button", { name: /^In use/ }));
  fireEvent.click(within(amounts).getByRole("button", { name: /^5,000–10,000/ }));
  fireEvent.click(within(amounts).getByRole("button", { name: /^< 1,000/ }));
  expect(shown()).toHaveLength(4);
});
