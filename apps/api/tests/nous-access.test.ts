// Nous reaches everything (operator order 2026-10-19, plan clipboard:ajcJqa3IW6Eh): the Research Council as the operator, text files
// of the agent workspace and of the owner's artifacts (read only, never secrets, never outside the root), and the connected Gmail
// accounts (read only).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Artifact, CouncilRun, Room } from "@space/contracts";
import { createNousFiles } from "../src/nous/files.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = { id: "room:alpha0001", name: "Alpha", kind: "WORKSPACE" } as Room;
const other = { id: "room:other0001", name: "Other", kind: "WORKSPACE" } as Room;
const base = mkdtempSync(join(tmpdir(), "nous-files-"));
const root = join(base, "agent-workspace");
const artifactRoot = join(base, "artifacts");
afterAll(() => rmSync(base, { recursive: true, force: true }));

mkdirSync(join(root, "active", "study", "final"), { recursive: true });
mkdirSync(join(root, "secrets"), { recursive: true });
mkdirSync(join(root, "active", "app", ".config"), { recursive: true });
writeFileSync(join(root, "active", "study", "final", "STUDY.md"), `# Study\n${"x".repeat(20_000)}\nAuthorization: Bearer abc.def.ghi\nend`);
writeFileSync(join(root, "secrets", "key.txt"), "secret");
writeFileSync(join(root, "active", "app", ".env"), "TOKEN=1");
writeFileSync(join(root, "active", "app", ".config", "settings.json"), "{}");
writeFileSync(join(root, "active", "app", "github-token.txt"), "ghp_x");
writeFileSync(join(root, "active", "app", "id_ed25519"), "key");
writeFileSync(join(root, "active", "app", "notes.md"), "notes");
writeFileSync(join(root, "active", "app", "blob.bin"), Buffer.from([1, 0, 2, 3]));
writeFileSync(join(base, "outside.txt"), "outside");
symlinkSync(join(base, "outside.txt"), join(root, "active", "app", "escape.txt"));
symlinkSync(join(root, "active", "app", "notes.md"), join(root, "active", "app", "inside-link.md"));
mkdirSync(join(artifactRoot, "user-uploads", "room_alpha0001", "2026-10-19"), { recursive: true });
writeFileSync(join(artifactRoot, "user-uploads", "room_alpha0001", "2026-10-19", "report.txt"), "Artifact report text");

const artifact = (id: string, roomId: string, filename: string): Artifact => ({ id, roomId, paneId: null, turnId: null, workflowId: null, kind: "EXPORT", mimeType: "text/plain",
  storageUri: `space-artifact://user-uploads/${roomId}/2026-10-19/${filename}`, sha256: "a".repeat(64), byteSize: 20, metadata: { originalFilename: filename },
  expiresAt: null, pinnedAt: null, deletedAt: null, createdAt: "2026-10-19T10:00:00.000Z" });
const artifacts = [artifact("artifact:mine0001", room.id, "report.txt"), artifact("artifact:theirs01", other.id, "report.txt")];
const files = createNousFiles({ root, artifactRoot, rooms: async () => [room],
  listArtifacts: async (_collection, roomId) => artifacts.filter((item) => item.roomId === roomId), getArtifact: async (id) => artifacts.find((item) => item.id === id)! });

function tools(extra: Partial<NousToolDeps> = {}) {
  return createNousTools({ rooms: async () => [room], listPanes: async () => [], files, ...extra } as unknown as NousToolDeps);
}

describe("Nous files (space_files_list, space_files_read)", () => {
  it("lists the workspace without secret-looking names and reads text in slices, redacted", async () => {
    const nous = tools();
    const listed = await nous.execute("space_files_list", { path: "active/app" }, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.result).toContain("notes.md");
    expect(listed.result).toContain("escape.txt · link");
    for (const hidden of [".env", ".config", "github-token.txt", "id_ed25519"]) expect(listed.result).not.toContain(hidden);
    expect((await nous.execute("space_files_list", {}, ctx)).result).not.toContain("secrets");

    const first = await nous.execute("space_files_read", { path: `${root}/active/study/final/STUDY.md` }, ctx);
    expect(first.ok).toBe(true);
    expect(first.result).toMatch(/characters 0-11500 of \d+; the rest with offset 11500/);
    expect(first.result.length).toBeLessThanOrEqual(12_000);
    const last = await nous.execute("space_files_read", { path: "~/agent-workspace/active/study/final/STUDY.md", offset: 11_500 }, ctx);
    expect(last.result).toContain("(end)");
    expect(last.result).toContain("Bearer [REDACTED]");
    expect(last.result).not.toContain("abc.def.ghi");
    expect((await nous.execute("space_files_read", { path: "active/app/inside-link.md" }, ctx)).result).toContain("notes");
  });

  it("never reads secrets, paths outside the root, symlinks leading out, or binary files", async () => {
    const nous = tools();
    for (const path of ["secrets/key.txt", "active/app/.env", "active/app/.config/settings.json", "active/app/github-token.txt", "active/app/id_ed25519",
      "../outside.txt", "/etc/passwd", "active/app/escape.txt", "active/app/blob.bin"]) {
      const outcome = await nous.execute("space_files_read", { path }, ctx);
      expect(outcome.ok, path).toBe(false);
      expect(outcome.result).not.toMatch(/secret$|TOKEN=1|outside$|ghp_x/);
    }
    expect((await nous.execute("space_files_list", { path: "../" }, ctx)).ok).toBe(false);
  });

  it("reads only the owner's Agent Files and Media artifacts", async () => {
    const nous = tools();
    const listed = await nous.execute("space_files_list", { artifacts: "ROOM_MEDIA" }, ctx);
    expect(listed.result).toContain("artifact:mine0001 · report.txt");
    expect(listed.result).not.toContain("artifact:theirs01");
    expect((await nous.execute("space_files_read", { artifactId: "artifact:mine0001" }, ctx)).result).toContain("Artifact report text");
    expect((await nous.execute("space_files_read", { artifactId: "artifact:theirs01" }, ctx)).ok).toBe(false);
  });
});

describe("Nous Council and mail tools", () => {
  const run = { id: "council_run:abcdef123456", ownerUserId: owner, question: "Which database?", coordinatorModelId: "claude/claude-opus-5-5", status: "NEEDS_INPUT", stage: "PLAN",
    plan: null, estimate: null, qa: [{ questions: [{ id: "q1", text: "What load?" }], answers: {} }], changeRequests: [], evidence: [], answers: [], rounds: [], final: null,
    events: [{ at: "2026-10-19T10:00:00.000Z", text: "The coordinator asks 1 question." }], clipboardPlan: null, error: null,
    createdAt: "2026-10-19T10:00:00.000Z", updatedAt: "2026-10-19T10:00:00.000Z" } as unknown as CouncilRun;

  it("drives a Council run as the operator and shares nothing personal unless Nous writes it, without contact details", async () => {
    const council = { models: vi.fn(async () => ({ models: [{ id: "codex/gpt-5.6", displayName: "GPT 5.6", providerId: "codex", available: true, note: null }], defaultCoordinator: "claude/claude-opus-5-5" })),
      list: vi.fn(async () => [run]), get: vi.fn(async () => run), create: vi.fn(async () => run), answer: vi.fn(async () => run),
      approve: vi.fn(async () => run), createClipboardPlan: vi.fn(async () => run) };
    const nous = tools({ council: council as unknown as NousToolDeps["council"] });
    const started = await nous.execute("space_council_start", { question: "Which database?" }, ctx);
    expect(council.create).toHaveBeenCalledWith(owner, { question: "Which database?" });
    expect(started.result).toContain("q1: What load?");
    await nous.execute("space_council_answer", { run: run.id, answers: { q1: "10k writes a second" } }, ctx);
    expect(council.answer).toHaveBeenCalledWith(owner, run.id, { q1: "10k writes a second" });
    await nous.execute("space_council_approve", { run: run.id, members: ["codex/gpt-5.6", "claude/claude-opus-5-5"] }, ctx);
    expect(council.approve).toHaveBeenLastCalledWith(owner, run.id, { personalContext: "", members: ["codex/gpt-5.6", "claude/claude-opus-5-5"] });
    await nous.execute("space_council_approve", { run: run.id, personalContext: "Senior engineer, reach me at someone@example.com" }, ctx);
    expect(council.approve.mock.calls.at(-1)![2].personalContext).not.toContain("someone@example.com");
    expect((await nous.execute("space_council_runs", {}, ctx)).result).toContain(`${run.id} · NEEDS_INPUT`);
    await nous.execute("space_council_clipboard_plan", { run: run.id }, ctx);
    expect(council.createClipboardPlan).toHaveBeenCalledWith(owner, run.id);
    expect((await nous.execute("space_council_run", { run: "not-a-run" }, ctx)).ok).toBe(false);
  });

  it("searches and reads mail read only, redacted, across every connected account", async () => {
    const mail = {
      search: vi.fn(async () => ({ threads: [{ account: "op@example.com", threadId: "t1", messageId: "m1", from: { name: "GitHub", address: "noreply@github.com" }, subject: "Your code",
        snippet: "Code 123456", receivedAt: "2026-10-19T10:00:00.000Z", unread: true, starred: false, hasAttachment: false, messageCount: 1, labelIds: [] }], nextPageToken: null, errors: [] })),
      read: vi.fn(async () => ({ account: "op@example.com", threadId: "t1", subject: "Your code", messages: [{ from: { name: "GitHub", address: "noreply@github.com" },
        to: [{ name: "", address: "op@example.com" }], receivedAt: "2026-10-19T10:00:00.000Z", text: "Your code is 123456. Authorization: Bearer secret.token.value" }] }))
    };
    const nous = tools({ mail: mail as unknown as NousToolDeps["mail"] });
    const found = await nous.execute("space_mail_search", { q: "from:github newer_than:1d" }, ctx);
    expect(mail.search).toHaveBeenCalledWith(owner, { account: "all", q: "from:github newer_than:1d", labelId: "ALL", max: 10 });
    expect(found.result).toContain("op@example.com · t1");
    const read = await nous.execute("space_mail_read", { account: "op@example.com", threadId: "t1" }, ctx);
    expect(read.result).toContain("Your code is 123456");
    expect(read.result).not.toContain("secret.token.value");
    expect(mail.read).toHaveBeenCalledWith(owner, "op@example.com", "t1");
  });

  it("offers the new tools, all named space_, and none that sends, drafts or deletes mail", () => {
    const names = nousToolDefinitions({ copilots: true }).map((tool) => tool.name);
    for (const name of ["space_council_start", "space_council_runs", "space_council_run", "space_council_answer", "space_council_approve", "space_council_clipboard_plan",
      "space_files_list", "space_files_read", "space_mail_search", "space_mail_read"]) expect(names).toContain(name);
    expect(names.every((name) => name.startsWith("space_"))).toBe(true);
    expect(names.filter((name) => /^space_mail_(send|draft|trash|delete|label|archive|reply)/.test(name))).toEqual([]);
  });
});

describe("Nous reads Job and Mail Copilot panes (space_copilot_state)", () => {
  it("returns a Job Copilot pane's run, events and applications and a Mail Copilot pane's run, events, actions and habits", async () => {
    const { copilotDeps } = await import("../src/nous/wiring.js");
    const job = { runView: vi.fn(async () => ({ status: "RUNNING" })), listEvents: vi.fn(async () => [{ type: "QUESTION" }]), listApplications: vi.fn(async () => [{ status: "SUBMITTED" }]) };
    const mail = { runView: vi.fn(async () => ({ status: "IDLE" })), listEvents: vi.fn(async () => [{ type: "MAIL_RECEIVED" }]), actionLog: vi.fn(async () => [{ action: "archive" }]),
      habitList: vi.fn(async () => Array.from({ length: 20 }, (_, index) => ({ sender: `s${index}` }))) };
    const deps = copilotDeps({ copilots: { job, mail } as never, store: {} as never }, async () => [])!;
    const jobPane = { id: "pane:job00001", mode: "JOB_APPLY" } as never;
    const mailPane = { id: "pane:mail0001", mode: "MAIL_COPILOT" } as never;
    expect(JSON.parse(await deps.state(owner, jobPane))).toEqual({ run: { status: "RUNNING" }, events: [{ type: "QUESTION" }], applications: [{ status: "SUBMITTED" }] });
    expect(job.listEvents).toHaveBeenCalledWith(owner, { paneId: "pane:job00001", limit: 10 });
    const mailState = JSON.parse(await deps.state(owner, mailPane));
    expect(mailState).toEqual(expect.objectContaining({ run: { status: "IDLE" }, actions: [{ action: "archive" }] }));
    expect(mailState.habits).toHaveLength(15);
    await expect(deps.state(owner, { id: "pane:term0001", mode: "TERMINAL" } as never)).rejects.toThrow(/Only copilot panes/);
  });
});

describe("Nous reads Space Gateway detail (space_ops_gateway)", () => {
  it("lists accounts, keys without secrets and request metadata, read only", async () => {
    const { nousOpsGatewayText } = await import("../src/nous/ops-views.js");
    const admin = {
      listAccounts: vi.fn(async () => ({ data: [{ provider: "claude", label: "Claude 1", alias: null, email: "a@example.com", status: "ACTIVE", statusReason: null, primaryWindow: { usedPercent: 40 }, secondaryWindow: null, lastUsedAt: null }] })),
      listApiKeys: vi.fn(async () => ({ data: [{ name: "space-design", keyPrefix: "sgk_abcd", isActive: true, trafficClass: "BACKGROUND", enforcedModel: "gpt-image", allowedModels: [], limits: [], lastUsedAt: null }] })),
      listRequestLogs: vi.fn(async () => ({ data: [{ requestedAt: "2026-10-19T10:00:00.000Z", provider: "claude", model: "claude-haiku-5-5", status: "OK", errorCode: null, inputTokens: 1200, outputTokens: 80, costUsd: 0.01, latencyMs: 900 }] })),
      report: vi.fn(async () => ({ days: [] })), anthropicBilling: vi.fn(async () => ({ days: [] }))
    };
    const deps = { gatewayAdmin: admin as never };
    expect(await nousOpsGatewayText(deps, { view: "accounts" })).toContain("claude · Claude 1 <a@example.com> · ACTIVE");
    expect(await nousOpsGatewayText(deps, { view: "keys" })).toBe("- space-design (sgk_abcd…) · active · BACKGROUND · model gpt-image · last used never");
    expect(await nousOpsGatewayText(deps, { view: "logs", limit: 5 })).toContain("claude claude-haiku-5-5 · OK · in 1.2k out 80 · $0.01 · 900 ms");
    expect(admin.listRequestLogs).toHaveBeenCalledWith({ limit: 5 });
    await nousOpsGatewayText(deps, { view: "billing", days: 3 });
    expect(admin.anthropicBilling).toHaveBeenCalledWith(3);
    expect(await nousOpsGatewayText({}, { view: "keys" })).toMatch(/not available/);
  });
});

describe("Nous reads the Live conversation (space_live_history)", () => {
  it("reads the operator's Live turns, newest last, filtered and redacted", async () => {
    const read = vi.fn(async () => ({ items: [
      { roomId: room.id, roomName: "Alpha", role: "assistant", text: "Done.", createdAtMs: Date.parse("2026-10-19T10:01:00Z") },
      { roomId: room.id, roomName: "Alpha", role: "user", text: "Remind me about the dentist, Authorization: Bearer abc.def", createdAtMs: Date.parse("2026-10-19T10:00:00Z") },
      { roomId: room.id, role: "tool", text: "tool output", createdAtMs: Date.parse("2026-10-19T10:02:00Z") }] }));
    const nous = tools({ liveHistory: { read } });
    const all = await nous.execute("space_live_history", { room: "Alpha" }, ctx);
    expect(read).toHaveBeenCalledWith(owner, room.id, 200);
    expect(all.result.split("\n")).toEqual(["2026-10-19T10:00 [Alpha] Operator: Remind me about the dentist, Authorization: Bearer [REDACTED]", "2026-10-19T10:01 [Alpha] Live: Done."]);
    expect((await nous.execute("space_live_history", { contains: "DENTIST" }, ctx)).result.split("\n")).toHaveLength(1);
    expect((await tools().execute("space_live_history", {}, ctx)).ok).toBe(false);
  });
});

describe("Nous asks the Design pane for graphics (space_design_request)", () => {
  it("creates a request as Nous in the named room and reads its status", async () => {
    const design = { createRequest: vi.fn(async () => ({ request: { id: "design_request:abc123", status: "QUEUED", formatIds: ["square"] }, designPaneId: "pane:design001", runStarted: true })),
      request: vi.fn(async () => ({ request: { id: "design_request:abc123", status: "DELIVERED" }, assets: [{ artifactId: "artifact:img00001" }] })) };
    const nous = tools({ design: design as never });
    const asked = await nous.execute("space_design_request", { room: "Alpha", brief: "A launch card for the pane board", formats: ["square"] }, ctx);
    expect(design.createRequest).toHaveBeenCalledWith(owner, { kind: "NOUS", roomId: room.id, label: "Nous" }, { brief: "A launch card for the pane board", formatIds: ["square"], referenceArtifactIds: [] });
    expect(asked.result).toContain("design_request:abc123");
    expect((await nous.execute("space_design_request_status", { request: "design_request:abc123" }, ctx)).result).toContain("artifact:img00001");
  });
});
