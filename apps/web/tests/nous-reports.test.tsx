import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NousCryptoReport, NousJobReport } from "@space/contracts";
import { daysRun, NousCrypto } from "../src/features/nous/NousCrypto.js";
import { NousJobs } from "../src/features/nous/NousJobs.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Job applications and Crypto (operator 3/11 22:33 BKK): the summary on top, every row below; a row opens only when clicked (rule 3/11).
const jobs: NousJobReport = {
  generatedAt: "2026-11-03T10:00:00.000Z", timeZone: "Asia/Bangkok",
  funnel: { rows: 4, applied: 3, confirmed: 2, companies: 2, rejected: 1, invited: 1, passed: [1, 0, 0, 0], offers: 0, noReply: 0, pending: 1 },
  notSent: { FAILED: 1 },
  platforms: [{ platform: "Greenhouse", applied: 3, confirmed: 2, companies: 2, rejected: 1, invited: 1 }],
  weeks: [{ week: "2026-10-26", applied: 3, confirmed: 2, rejections: 1, invitations: 2 }],
  pending: [{ id: "task:s1", kind: "INTERVIEW", at: "2026-11-01T00:00:00.000Z", subject: "Interview with Snyk", from: "Luke", threadId: "t1", account: null, deadline: "2026-11-05T12:00:00.000Z", open: true, company: "Snyk" }],
  unmatched: [],
  companies: [
    { name: "Snyk", applicationIds: ["jobapp:snyk01"], rejections: [], offers: [], otherMails: [], outcome: "IN_PROCESS",
      stages: [{ id: "task:s0", kind: "TEST", at: "2026-10-28T00:00:00.000Z", subject: "Snyk coding test", from: "Snyk", threadId: "t0", account: null, deadline: null, open: false },
        { id: "task:s1", kind: "INTERVIEW", at: "2026-11-01T00:00:00.000Z", subject: "Interview with Snyk", from: "Luke", threadId: "t1", account: null, deadline: "2026-11-05T12:00:00.000Z", open: true }] },
    { name: "Mongodb", applicationIds: ["jobapp:mongo1", "jobapp:mongo2"], stages: [], offers: [], otherMails: [], outcome: "REJECTED",
      rejections: [{ id: "jobevt:r1", kind: "REJECTION", at: "2026-11-03T04:00:00.000Z", subject: "About your application to MongoDB", from: "no-reply@mongodb.com", threadId: null, account: "me@x.com" }] }
  ],
  applications: [
    { id: "jobapp:snyk01", company: "Snyk", role: "Staff Engineer", platform: "Ashby", url: "https://jobs.ashbyhq.com/snyk/1", status: "VERIFIED", appliedAt: "2026-10-27T00:00:00.000Z", createdAt: "2026-10-27T00:00:00.000Z", week: "2026-10-26" },
    { id: "jobapp:mongo1", company: "Mongodb", role: "Forward Deployed Engineer", platform: "Greenhouse", url: "https://x", status: "VERIFIED", appliedAt: "2026-10-28T00:00:00.000Z", createdAt: "2026-10-28T00:00:00.000Z", week: "2026-10-26" },
    { id: "jobapp:mongo2", company: "Mongodb", role: "SRE", platform: "Greenhouse", url: "https://x", status: "SUBMITTED", appliedAt: "2026-10-28T00:00:00.000Z", createdAt: "2026-10-28T00:00:00.000Z", week: "2026-10-26" },
    { id: "jobapp:fail01", company: "Oura", role: "Engineer", platform: "Greenhouse", url: "https://x", status: "FAILED", appliedAt: null, createdAt: "2026-10-28T00:00:00.000Z", week: null }
  ]
};
const crypto: NousCryptoReport = {
  source: { path: "/var/lib/spaceapp-user/agent-workspace/nous/crypto/final-table-draft.md", final: false, modifiedAt: "2026-11-03T14:50:00.000Z", title: "Draft" },
  notes: ["189 rows checked."],
  rows: [
    { id: "D28", method: "Stablecoin lending", category: "Staking / yield", success: "75/77 = 97.4 % (CI 91.0-99.3)", monthly: "1.8 per 1,000", capital: "1000", risk: "L", verdict: "PASS",
      verdictText: "PASS ≥70% (USD)", sources: [{ label: "registry", path: "/var/lib/spaceapp-user/agent-workspace/active/x/methods.md", line: 6 }], sourceText: "aave.com",
      registry: { where: "public-host", "test mode": "paper", started: "29/10", "h logged": "60", status: "WORKS" }, hours: 60, retestOf: null, retests: ["D28-n2"], reasons: [] },
    { id: "D28-n2", method: "Stablecoin lending retest", category: "Staking / yield", success: "pending", monthly: "–", capital: "1000", risk: "L", verdict: "PENDING",
      verdictText: "εκκρεμεί έως 03/11 23:12 BKK", sources: [], sourceText: "", registry: null, hours: null, retestOf: "D28", retests: [], reasons: [] },
    { id: "B01", method: "Cross-exchange arb", category: "Arbitrage", success: "25 %", monthly: "-0.2", capital: "0", risk: "M", verdict: "FAIL", verdictText: "FAIL", sources: [], sourceText: "",
      registry: { status: "FAILS (55 % and a negative mean)" }, hours: 60.4, retestOf: null, retests: [], reasons: ["Success rate below 70%", "Net result negative after costs"] }
  ],
  verdicts: { PASS: 1, FAIL: 1, INSUFFICIENT: 0, RESEARCH: 0, SKIP: 0, PENDING: 1, OTHER: 0 },
  categories: [{ category: "Staking / yield", total: 2, verdicts: { PASS: 1, PENDING: 1 } }, { category: "Arbitrage", total: 1, verdicts: { FAIL: 1 } }],
  reasons: [{ reason: "Success rate below 70%", ids: ["B01"] }, { reason: "Net result negative after costs", ids: ["B01"] }]
};

function serve(jobReport: NousJobReport = jobs) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("/api/nous/job-report")) return Response.json({ report: jobReport });
    if (url.startsWith("/api/nous/crypto-report")) return Response.json({ report: crypto });
    if (url.startsWith("/api/job-apply/events")) return Response.json({ events: [{ id: "jobevt:v1", type: "VERIFIED", message: "Confirmation page seen", createdAt: "2026-10-27T00:01:00.000Z" }] });
    return Response.json({});
  }));
  return urls;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the funnel, filters the applications and opens one with its company's mails and the copilot's events only when clicked", async () => {
  const urls = serve();
  render(<NousJobs active />);
  const chips = await screen.findByRole("group", { name: "Show applications" });
  expect(screen.getByText(/3 applications sent to 2 companies \(4 rows in all\)/)).toBeTruthy();
  const funnel = screen.getByRole("region", { name: "Funnel" });
  expect(within(funnel).getByTitle("Confirmed (verified): 2 (66.7% of sent)")).toBeTruthy();
  expect(within(funnel).getByTitle("Rejected us: 1 (50%)")).toBeTruthy();
  expect(within(funnel).getByTitle(/^Passed stage 1 \(derived\): 1 \(50% of companies · 100% of stage 1\)$/)).toBeTruthy();
  expect([...chips.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Sent3", "Rejected2", "Invited1", "Open test or interview1", "No reply0", "Not sent1", "All4"]);
  const snyk = screen.getByRole("button", { name: /Snyk/ });
  expect(snyk.textContent).toContain("Test or interview open · 2 stages");
  expect(screen.queryByText("Snyk coding test")).toBeNull();
  fireEvent.click(snyk);
  expect(snyk.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Snyk coding test")).toBeTruthy();
  expect(await screen.findByText("Confirmation page seen")).toBeTruthy();
  expect(urls).toContain("/api/job-apply/events?applicationId=jobapp%3Asnyk01&limit=500");
  fireEvent.click(within(chips).getByRole("button", { name: /^Rejected/ }));
  expect(screen.getAllByRole("button", { name: /Mongodb/ })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Snyk/ })).toBeNull();
});

it("counts the crypto methods by result and reason, and opens a method's registry facts only when clicked", async () => {
  serve();
  render(<NousCrypto active />);
  const chips = await screen.findByRole("group", { name: "Show methods" });
  expect(screen.getByText(/Draft of the final table/)).toBeTruthy();
  expect(screen.getByText("3 rows: 2 methods and 1 second checks")).toBeTruthy();
  expect(screen.getByTitle("Positive (pass ≥70%): 1 (33.3%)")).toBeTruthy();
  expect([...chips.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["All3", "Positive (pass ≥70%)1", "Pending1", "Failed1", "Second check2"]);
  const d28 = screen.getByRole("button", { name: /^D28 Stablecoin lending(?!.*retest)/ });
  expect(d28.textContent).toContain("second check D28-n2");
  expect(d28.textContent).toContain("2.5 d run");
  expect(screen.queryByText("public-host")).toBeNull();
  fireEvent.click(d28);
  expect(screen.getByText("public-host")).toBeTruthy();
  expect(screen.getByText("/var/lib/spaceapp-user/agent-workspace/active/x/methods.md:6")).toBeTruthy();
  // A reason lists its methods.
  fireEvent.click(screen.getByRole("button", { name: /Net result negative after costs/ }));
  expect(screen.getAllByRole("button", { name: /^(D28|B01) / }).map((button) => button.textContent?.slice(0, 3))).toEqual(["B01"]);
  expect(daysRun(null)).toBeNull();
  expect([daysRun(0.3), daysRun(0), daysRun(48)]).toEqual(["0.3 h", "0 d", "2 d"]);
});

// Opt in under space-load-gate, as the Nous tabs proof (nous-dock.test.tsx): JSDOM cannot measure. 4/11 double-check: on a 412 px phone the
// funnel's numbers and notes ("0% of companies · 0% of stage 1") ran past the right edge; a wide dock keeps them on the bar's line.
it.skipIf(process.env.SPACE_NOUS_TABS_BROWSER_PROOF !== "1").each([{ width: 390, dock: 0 }, { width: 412, dock: 0 }, { width: 1280, dock: 410 }, { width: 1280, dock: 1000 }])(
  "keeps every funnel number and note inside the page at $width px (dock $dock px)", async ({ width, dock }) => {
    // Stable's figures before the stage fix: the longest notes ("0.5% of companies · 36.8% of stage 1").
    serve({ ...jobs, funnel: { rows: 4668, applied: 3403, confirmed: 2916, companies: 1296, rejected: 196, invited: 19, passed: [7, 2, 0, 0], offers: 0, noReply: 1083, pending: 24 } });
    render(<NousJobs active />);
    const funnel = await screen.findByRole("region", { name: "Funnel" });
    const css = ["dock-kit/dock-kit.css", "nous/nous.css"].map((path) => readFileSync(resolve(__dirname, `../src/features/${path}`), "utf8")).join("\n");
    const srcdoc = `<style>*{box-sizing:border-box}body{margin:0;font:16px system-ui}${css}</style><section class="dock-panel nous-dock" style="padding:12px${dock ? `;width:${dock}px` : ""}">${funnel.outerHTML}</section>`;
    const base = "/var/lib/spaceapp-user/agent-workspace/active";
    mkdirSync(base, { recursive: true });
    const scratch = mkdtempSync(`${base}/nous-funnel-`);
    try {
      writeFileSync(`${scratch}/fixture.html`, `<iframe style="width:${width}px;height:844px;border:0"></iframe><pre id="result"></pre><script>
        const frame = document.querySelector('iframe');
        frame.onload = () => {
          const doc = frame.contentDocument, box = doc.querySelector('.nous-report-funnel').getBoundingClientRect(), bars = [...doc.querySelectorAll('.nous-report-bar')];
          const outside = bars.flatMap(bar => [...bar.children].filter(part => { const r = part.getBoundingClientRect(); return r.left < box.left - .5 || r.right > box.right + .5; })
            .map(part => bar.querySelector('.nous-report-bar-label').textContent + ': ' + part.tagName));
          const lines = bars.map(bar => bar.querySelector('small') ? Math.round(bar.querySelector('small').getBoundingClientRect().top - bar.querySelector('strong').getBoundingClientRect().top) : 0);
          document.querySelector('#result').textContent = JSON.stringify({ width: frame.contentWindow.innerWidth, bars: bars.length, outside, noteBelow: lines.some(gap => gap > 4),
            wraps: [...doc.querySelectorAll('.nous-report-bar small')].every(note => frame.contentWindow.getComputedStyle(note).whiteSpace === 'normal'),
            beyond: Math.round(Math.max(...bars.flatMap(bar => [...bar.children].map(part => part.getBoundingClientRect().right))) - box.right),
            overflow: doc.documentElement.scrollWidth > frame.contentWindow.innerWidth });
        };
        frame.srcdoc = ${JSON.stringify(srcdoc)};
      </script>`);
      const chrome = spawnSync("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        `--user-data-dir=${scratch}/profile`, "--virtual-time-budget=1000", "--dump-dom", `file://${scratch}/fixture.html`], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: scratch } });
      expect(chrome.error).toBeUndefined();
      expect(chrome.status, `${chrome.signal}: ${chrome.stderr.slice(-1500)}`).toBe(0);
      const measured = JSON.parse(new DOMParser().parseFromString(chrome.stdout, "text/html").querySelector("#result")!.textContent!);
      // Narrow: the note moves under its bar and wraps (the first fix sat before the rules it overrides, so nowrap won and only this font fit);
      // wide (1000 px): it stays on the bar's line.
      expect(measured).toMatchObject({ width, bars: 11, outside: [], overflow: false, noteBelow: dock !== 1000, wraps: dock !== 1000 });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });

// Operator 5/11 10:56 BKK (nous_msg:ecc74fc3c0c34ec88b12585a): filters combine with the search, and a company tested and then rejected is Rejected only.
it("combines the search with the filters: the chip counts and the list both read the searched rows", async () => {
  const test = { id: "task:a0", kind: "TEST" as const, at: "2026-10-27T00:00:00.000Z", subject: "Agoda assessment", from: "HackerRank", threadId: "t2", account: null, deadline: null, open: false };
  const rejection = { id: "jobevt:a1", kind: "REJECTION" as const, at: "2026-10-31T00:00:00.000Z", subject: "Agoda - Thank you", from: "Agoda", threadId: null, account: null };
  const agoda = (id: string, role: string) => ({ ...jobs.applications[1]!, id, company: "Agoda", role });
  serve({ ...jobs, companies: [...jobs.companies, { name: "agoda", applicationIds: ["jobapp:ag1", "jobapp:ag2"], stages: [test], rejections: [rejection], offers: [], otherMails: [], outcome: "REJECTED" }],
    applications: [...jobs.applications, agoda("jobapp:ag1", "Backend Engineer"), agoda("jobapp:ag2", "Data Engineer")] });
  render(<NousJobs active />);
  const chips = await screen.findByRole("group", { name: "Show applications" });
  const counts = () => [...chips.querySelectorAll("button")].map((button) => button.textContent);
  expect(counts()).toEqual(["Sent5", "Rejected4", "Invited1", "Open test or interview1", "No reply0", "Not sent1", "All6"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "agoda" } });
  expect(counts()).toEqual(["Sent2", "Rejected2", "Invited0", "Open test or interview0", "No reply0", "Not sent0", "All2"]);
  fireEvent.click(within(chips).getByRole("button", { name: /^Invited/ }));
  expect(screen.queryAllByRole("button", { name: /Agoda/ })).toHaveLength(0);
  fireEvent.click(within(chips).getByRole("button", { name: /^Rejected/ }));
  expect(screen.getAllByRole("button", { name: /Agoda/ })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Mongodb/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "agoda data" } });
  expect(screen.getAllByRole("button", { name: /Agoda/ })).toHaveLength(1);
  // The status and outcome texts are searched too.
  fireEvent.change(screen.getByRole("searchbox", { name: "Search applications" }), { target: { value: "test or interview" } });
  expect(counts()).toEqual(["Sent1", "Rejected0", "Invited1", "Open test or interview1", "No reply0", "Not sent0", "All1"]);
});
