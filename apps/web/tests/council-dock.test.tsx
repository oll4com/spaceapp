import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilModelsResponse, CouncilRun } from "@space/contracts";
import { CouncilDock } from "../src/features/council/CouncilDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const at = "2026-10-14T12:00:00.000Z";
const catalog: CouncilModelsResponse = {
  coordinatorDefault: "claude/claude-opus-5-5",
  webSearch: true,
  models: [
    { id: "codex/gpt-6-astra", displayName: "GPT-6 Astra", providerId: "codex", available: true, note: null },
    { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5", providerId: "claude", available: true, note: null },
    { id: "claude/claude-fable-5-1", displayName: "Claude Fable 5.1", providerId: "claude", available: true, note: null },
    { id: "antigravity/gemini-3.8-flash-medium", displayName: "Gemini 3.8 Flash (Medium)", providerId: "antigravity", available: true, note: null }
  ]
};
const base: CouncilRun = {
  id: "council_run:abcdef123456", ownerUserId: "user:operator", question: "How can I make 100 euros in one day?", coordinatorModelId: "claude/claude-opus-5-5",
  status: "AWAITING_APPROVAL", stage: "PLAN", estimate: { calls: 12, minutes: 6 }, qa: [], changeRequests: [], evidence: [], answers: [], rounds: [], final: null,
  events: [{ at, text: "The plan is ready for your approval." }], error: null, createdAt: at, updatedAt: at,
  plan: {
    understanding: "Nikos wants realistic same-day income in Athens.", personalContext: "Developer in Athens.", reviewRounds: 1, agreementTarget: 0.67,
    members: [{ modelId: "codex/gpt-6-astra", reason: "web research" }, { modelId: "claude/claude-opus-5-5", reason: "reasoning" }, { modelId: "claude/claude-fable-5-1", reason: "second view" }],
    criteria: [{ id: "feasibility", label: "Feasible today" }, { id: "risk", label: "Low risk" }], searchQueries: ["same day gig work Athens"]
  }
};

function serve(run: CouncilRun | null, onPost: (url: string, body: any) => CouncilRun = () => run!) {
  const posts: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:council", headerName: "x-space-csrf-token" });
    if (url === "/api/council/models") return Response.json(catalog);
    if (url === "/api/council/runs" && method === "GET") return Response.json({ runs: run ? [{ id: run.id, question: run.question, status: run.status, stage: run.stage, createdAt: at, updatedAt: at }] : [] });
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posts.push({ url, body });
      return Response.json({ run: onPost(url, body) }, { status: url === "/api/council/runs" ? 201 : 200 });
    }
    return Response.json({ run });
  }));
  return posts;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Council dock", () => {
  it("tells other roles that the Council is for administrators and operators", () => {
    render(<CouncilDock canRun={false} />);
    expect(screen.getByText("The Council is available to administrators and operators")).toBeTruthy();
  });

  it("turns the Council's notifications off and back on from its settings", async () => {
    serve(null);
    const served = vi.mocked(fetch).getMockImplementation()!;
    const saved: Array<{ perSource: Record<string, unknown> }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "/api/user-settings") return served(input, init);
      if (init?.method === "PATCH") { saved.push(JSON.parse(String(init.body)).notifications); return Response.json({}); }
      return Response.json({ notifications: null });
    });
    render(<CouncilDock canRun />);
    fireEvent.click(await screen.findByRole("button", { name: "Council settings" }));
    const toggle = await screen.findByRole("switch", { name: "Council notifications" }) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.perSource.COUNCIL).toEqual({ inApp: false, desktop: false, telegram: false });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[1]?.perSource.COUNCIL).toEqual({ inApp: true });
  });

  it("asks a question with the default coordinator", async () => {
    const posts = serve(null, (_url, body) => ({ ...base, status: "PLANNING", plan: null, estimate: null, question: body.question }));
    render(<CouncilDock canRun />);
    await screen.findByText(/No questions yet/);
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "How can I make 100 euros in one day?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the council" }));
    await screen.findByText(/is preparing the plan/);
    expect(posts).toEqual([{ url: "/api/council/runs", body: { question: "How can I make 100 euros in one day?" } }]);
  });

  it("shows the plan, lets you edit what is shared, the models and the rounds, and approves it", async () => {
    const posts = serve(base, () => ({ ...base, status: "RUNNING", stage: "RESEARCH" }));
    render(<CouncilDock canRun />);
    await screen.findByText("Nikos wants realistic same-day income in Athens.");
    expect(screen.getByText(/Sent to: codex, claude/)).toBeTruthy();
    expect(screen.getByText(/About 12 model calls, about 6 minutes/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/What will be shared about you/), { target: { value: "Developer in Athens, free today." } });
    fireEvent.click(screen.getByRole("button", { name: /Claude Fable 5.1/ }));
    fireEvent.change(screen.getByLabelText("Add a model"), { target: { value: "antigravity/gemini-3.8-flash-medium" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Review rounds" })).getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve & run" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/council/runs/council_run%3Aabcdef123456/approve", body: {
      members: ["codex/gpt-6-astra", "claude/claude-opus-5-5", "antigravity/gemini-3.8-flash-medium"], personalContext: "Developer in Athens, free today.", reviewRounds: 2
    } });
    await screen.findByRole("button", { name: "Stop" });
  });

  it("sends the answers to the coordinator's questions", async () => {
    const asking: CouncilRun = { ...base, status: "NEEDS_INPUT", plan: null, estimate: null, qa: [{ questions: [{ id: "q1", text: "Which city do you live in?" }], answers: {} }] };
    const posts = serve(asking, () => ({ ...asking, status: "PLANNING" }));
    render(<CouncilDock canRun />);
    fireEvent.change(await screen.findByLabelText("Which city do you live in?"), { target: { value: "Athens" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/council/runs/council_run%3Aabcdef123456/answers", body: { answers: { q1: "Athens" } } }]));
  });

  it("shows the agreed Top 3, the final answer and who said what only in Details", async () => {
    const done: CouncilRun = {
      ...base, status: "COMPLETED", stage: "DONE",
      evidence: [{ title: "Wolt couriers", url: "https://wolt.com/couriers", finding: "Paid per delivery." }],
      answers: [{ modelId: "codex/gpt-6-astra", status: "DONE", text: "Deliver food with Wolt.", claims: [], error: null, ms: 9_000 }],
      rounds: [{ round: 1, merged: "Courier shift or selling items.", positions: [{ id: "P1", title: "Courier shift", summary: "", support: 2 }],
        reviews: [{ modelId: "codex/gpt-6-astra", status: "DONE", scores: [{ positionId: "P1", score: 9, verdict: "agree", issue: "" }], corrections: [], missing: [], error: null }],
        ranking: [{ positionId: "P1", mean: 9, agreeShare: 1, spread: 0, reviewers: 1, qualified: true }] }],
      final: { text: "## Answer\nDo a **courier shift** today.", top: [{ positionId: "P1", title: "Courier shift", mean: 9, agree: 1, reviewers: 1 }] }
    };
    serve(done);
    render(<CouncilDock canRun />);
    fireEvent.click(await screen.findByRole("button", { name: /How can I make 100 euros/ }));
    const top = await screen.findByRole("list", { name: "Top 3" });
    expect(within(top).getByText("Courier shift")).toBeTruthy();
    expect(within(top).getByText("9.0/10 · 1 of 1 agree")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Models" })).getByText("GPT-6 Astra")).toBeTruthy();
    expect(screen.getByText("courier shift").tagName).toBe("STRONG");
    expect(screen.getByRole("button", { name: "Another review round" })).toBeTruthy();
    const details = screen.getByText("Details: who said what").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByRole("link", { name: "Wolt couriers" }).getAttribute("href")).toBe("https://wolt.com/couriers");
    expect(within(details).getAllByText("GPT-6 Astra").length).toBeGreaterThan(0);
  });

  it("asks the coordinator for a plan in the clipboard and shows where it was saved", async () => {
    const done: CouncilRun = { ...base, status: "COMPLETED", stage: "DONE", final: { text: "## Answer\nDo a courier shift.", top: [] } };
    const posts = serve(done, () => ({ ...done, clipboardPlan: { status: "WRITING", itemId: null, title: null, error: null } }));
    render(<CouncilDock canRun />);
    fireEvent.click(await screen.findByRole("button", { name: /How can I make 100 euros/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create plan" }));
    expect((await screen.findByRole("button", { name: "Writing the plan…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts).toEqual([{ url: "/api/council/runs/council_run%3Aabcdef123456/clipboard-plan", body: null }]);
    expect((screen.getByRole("button", { name: "Another review round" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
