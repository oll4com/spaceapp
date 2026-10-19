import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pane, Room, RoomAgentEvent, SpaceNotification } from "@space/contracts";
import { InMemoryNousRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession, signSessionWithTtl } from "../src/auth.js";
import { createNotificationService } from "../src/notifications/service.js";
import Fastify from "fastify";
import { postToWorkerWhenUp, registerNousMcpRoute, signNousToken, verifyNousToken } from "../src/nous/mcp.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyNousOutgoing, classifyNousPrompt } from "../src/nous/guardrails.js";
import { renderNousWorld } from "../src/nous/digest.js";
import { createNousService, nousHistory, NOUS_PERSONA, NousUnavailableError, type NousRunner, type NousServiceDeps } from "../src/nous/service.js";
import { createNousTools, nousControlRisk, nousToolDefinitions, type NousToolDeps, type NousToolOutcome } from "../src/nous/tools.js";
import { createNousMutes } from "../src/nous/mutes.js";
import { copilotDeps, nousLiveCounts, registerNous } from "../src/nous/wiring.js";
import { InMemoryDesignRepository } from "@space/db";
import { createDesignService } from "../src/design/service.js";
import { createRoomAgentAutopilot } from "../src/room-agent-autopilot.js";

describe("Nous's guardrails", () => {
  it("keeps releases, irreversible commands and sends to third parties for the operator", () => {
    expect(classifyNousOutgoing("Run space-queue promote now")?.category).toBe("RELEASE");
    expect(classifyNousOutgoing("then npm publish the launcher")?.category).toBe("RELEASE");
    expect(classifyNousOutgoing("space-version bump core patch")?.category).toBe("RELEASE");
    expect(classifyNousOutgoing("clean up with rm -rf dist")?.category).toBe("DESTRUCTIVE");
    expect(classifyNousOutgoing("Send the reply email to the client today")?.category).toBe("EXTERNAL");
    // Routine instructions pass, mentions included.
    expect(classifyNousOutgoing("Implement step 3 of the plan, never commit .env, then space-queue submit --worktree . --wait")).toBeNull();
    expect(classifyNousPrompt("Bash: npm publish --access public\nDo you want to proceed?\n❯ 1. Yes")?.category).toBe("RELEASE");
    expect(classifyNousPrompt("Edit apps/web/src/App.tsx?\n❯ 1. Yes  2. No")).toBeNull();
  });
});

const room = (id: string, name: string, owner = "user:operator"): Room =>
  ({ id, name, kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room);
const pane = (id: string, roomId: string, paneName: string, extra: Partial<Pane> = {}): Pane =>
  ({ id, roomId, paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false, ...extra } as unknown as Pane);

function toolFixture(screen = "Continue? (y/n)") {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const ask = vi.fn(async (input: Parameters<NousToolDeps["ask"]>[0]) => ({ ...input, id: "nous_decision:abcdef123456", status: "OPEN" as const, answer: null, outcome: null, createdAt: new Date().toISOString(), answeredAt: null }));
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async (owner) => owner === "user:operator" ? [room("room:main0001", "Main")] : [room("room:other001", "Other", owner)],
    listPanes: async (roomId) => roomId === "room:main0001" ? [pane("pane:andy0001", roomId, "Andy")] : [],
    inspectPane: async () => ({ text: screen, state: "WAITING_FOR_INPUT", sessionId: "session:1", promptFingerprint: "fp-1", tasks: [] } as never),
    roomTool,
    plans: { list: async () => [], get: async () => null, update: vi.fn() as never },
    tasks: { list: async () => [], add: vi.fn() as never, update: vi.fn() as never, rebind: vi.fn() as never },
    clipboard: { list: async () => [], save: vi.fn() as never, complete: vi.fn() as never, remove: vi.fn(async () => {}) },
    memory: null,
    notifications: { list: async () => [], resolve: async () => true },
    releaseTrain: vi.fn(async () => "No release trains yet."),
    setNote: vi.fn(async () => {}),
    ask,
    withdraw: vi.fn(async () => true),
    copilots: { items: async () => [], answerQuestion: vi.fn() as never, state: vi.fn(async () => '{"run":{"status":"RUNNING"}}') },
    allowances: async () => ({ promote: false, warm: false }),
    answerPrompt: vi.fn(async () => ({})),
  };
  return { tools: createNousTools(deps), roomTool, ask, deps };
}
const ctx = { owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };

describe("Nous's world", () => {
  it("shows the server's load and tells Nous to wait when the server is busy", () => {
    const base = { rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-10-17T10:30:00.000Z" };
    // The thresholds and the smoothing are tested in nous-server-load.test.ts; the world shows the state's line.
    const server = { level: "CALM" as const, reasons: [], cpuPercent: 40, load1: 2.1, load5: 1.8, cores: 8, memAvailableBytes: 20 * 1024 ** 3, memTotalBytes: 32 * 1024 ** 3,
      swapPercent: 10, samples: 30, topCpu: [], topMemory: [], sampledAt: "2026-10-17T10:30:00.000Z" };
    expect(renderNousWorld({ ...base, server })).toContain("Server: CALM · CPU 40% · load 2.1/1.8 on 8 cores · RAM available 20 of 32 GiB · swap 10% (5 min average).");
    expect(renderNousWorld({ ...base, server: { ...server, level: "BUSY", reasons: ["CPU 80%"], cpuPercent: 80 } })).toContain("BUSY: start no new work in panes now");
  });

  it("shows the operator's allowances, so Nous promotes when it may (stable 2026-10-18: it asked for promotes it was allowed to run)", () => {
    const base = { rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-10-18T01:30:00.000Z" };
    expect(renderNousWorld({ ...base, allowances: { promote: true, warm: false } }))
      .toContain("Operator allowances (only the operator changes them, in Settings): May promote dev to stable ON · May approve Warm changes off.");
    expect(renderNousWorld(base)).not.toContain("Operator allowances");
    expect(NOUS_PERSONA).toContain("unless the world shows \"May promote dev to stable ON\"");
  });

  it("keeps its notes, newest first, when the world is too large", () => {
    const base = { rooms: [], notifications: [], plans: [], tasks: [], trains: "x".repeat(60_000), decisions: [], now: "2026-10-17T10:30:00.000Z" };
    const notes = [{ key: "plan-map", text: "A blocks B", updatedAt: "2026-10-17T10:00:00.000Z" },
      ...Array.from({ length: 6 }, (_, index) => ({ key: `old-${index}`, text: "y".repeat(3_900), updatedAt: `2026-10-16T0${index}:00:00.000Z` }))];
    const world = renderNousWorld({ ...base, notes: [...notes, { key: "operator-language", text: "Greek", updatedAt: "2026-10-15T00:00:00.000Z" }] });
    expect(world.length).toBeLessThanOrEqual(40_000);
    expect(world).toContain("## Your notes\n### operator-language\nGreek\n### plan-map\nA blocks B");
    expect(world).toMatch(/Older notes not shown \(fold them into newer ones, or delete them\): old-1, old-0$/);
  });
});

describe("Nous's tools", () => {
  it("acts in the operator's rooms through the Room Agent's tools, and only there", async () => {
    const f = toolFixture();
    await f.tools.execute("space_send_to_pane", { room: "main", panes: ["andy"], text: "Implement step 2 of the plan." }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("send_to_pane", { panes: ["pane:andy0001"], text: "Implement step 2 of the plan." },
      expect.objectContaining({ roomId: "room:main0001", actorId: "user:operator" }));
    const other = await f.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "hi" }, { ...ctx, owner: "user:someone" });
    expect(other).toMatchObject({ ok: false, result: expect.stringContaining('No room named "Main"') });
  });

  it("takes one pane where a tool expects a list of panes", async () => {
    const f = toolFixture();
    const sent = await f.tools.execute("space_send_to_pane", { room: "Main", pane: "Andy", text: "Next step." }, ctx);
    expect(sent.ok).toBe(true);
    expect(f.roomTool).toHaveBeenCalledWith("send_to_pane", { panes: ["pane:andy0001"], text: "Next step." }, expect.anything());
  });

  it("briefs copilot panes, which a CLI prompt does not reach", async () => {
    const f = toolFixture();
    f.deps.listPanes = async (roomId) => roomId === "room:main0001" ? [pane("pane:andy0001", roomId, "Andy", { mode: "FREELANCE_COPILOT" } as Partial<Pane>)] : [];
    const brief = vi.fn(async () => "The Freelance Copilot has the brief; it works on it in its next run.");
    const tools = createNousTools({ ...f.deps, copilots: { items: async () => [], answerQuestion: async () => "", brief } });
    expect((await tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Log in with Google." }, ctx)).result).toContain("space_copilot_brief");
    expect((await tools.execute("space_copilot_brief", { room: "Main", pane: "Andy", text: "Log in with Google." }, ctx)).ok).toBe(true);
    expect(brief).toHaveBeenCalledWith("user:operator", expect.objectContaining({ id: "pane:andy0001" }), "Log in with Google.");
  });

  it("briefs a Design pane as a design request, lists what waits on the operator and answers the designer's question", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Studio", initialPaneCount: 0 }, "trace:room", "user:operator");
    const designPane = store.createPane({ roomId: room.id, title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" });
    const design = createDesignService({ repository: new InMemoryDesignRepository(), store, roomOwner: async (roomId) => store.getRoom(roomId).ownerUserId ?? null, artifactRoot: tmpdir(), brandRoot: tmpdir() });
    const deps = copilotDeps({ copilots: { design }, store } as never, async () => [])!;
    const answer = await deps.brief("user:operator", designPane, "A LinkedIn banner for the 0.3 release");
    expect(answer).toContain("Design pane has the request");
    const [request] = await design.listRequests("user:operator", { limit: 5 });
    expect(request).toMatchObject({ requester: { kind: "NOUS", label: "Nous" }, designPaneId: designPane.id, formatIds: ["square"] });
    expect(JSON.parse(await deps.state("user:operator", designPane)).requests).toHaveLength(1);
    await design.takeNext("user:operator", designPane);
    await design.ask("user:operator", designPane, request!.id, "Dark or light?");
    expect(await deps.items("user:operator")).toEqual([expect.objectContaining({ copilot: "DESIGN", kind: "QUESTION", id: request!.id, detail: "Dark or light?" })]);
    await deps.answerQuestion("user:operator", { copilot: "DESIGN", questionId: request!.id, paneId: designPane.id, answer: "Dark" });
    expect((await design.request("user:operator", request!.id)).request.answer).toBe("Dark");
  });

  it("holds back critical text and tells Nous the exact decision to ask", async () => {
    const f = toolFixture();
    const held = await f.tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Now git push and npm publish." }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("space_ask_operator (category RELEASE)");
    expect(held.result).toContain('"type":"PANE_TEXT"');
    expect(f.roomTool).not.toHaveBeenCalled();
  });

  it("reports how the operator's requests ended and the plan points it recorded (plan clipboard:L7RgHsveHbcR)", async () => {
    const f = toolFixture();
    const requests = [{ summary: "Close finished panes", outcome: "SELF" }, { summary: "Recreate a room", outcome: "HELPER", missing: "create a room", correction: true }];
    expect(await f.tools.execute("space_nous_outcome", { requests }, ctx)).toMatchObject({ ok: true, outcomes: requests });
    expect((await f.tools.execute("space_nous_outcome", { requests: [{ summary: "x", outcome: "DONE" }] }, ctx)).ok).toBe(false);

    let progress = 40;
    const plan = () => ({ id: "clipboard:plan000001", source: "PLAN", title: "Plan", progressPercentage: progress, executionStatus: "IN_PROGRESS", steps: [] }) as never;
    const tools = createNousTools({ ...f.deps, plans: { list: async () => [], get: async () => plan(), update: vi.fn(async () => { progress = 55; return plan(); }) } as never });
    expect(await tools.execute("space_plan_update", { plan: "clipboard:plan000001", progressPercentage: 55 }, ctx)).toMatchObject({ ok: true, planPoints: 15 });
    expect(await tools.execute("space_plan_update", { plan: "clipboard:plan000001", progressPercentage: 50 }, ctx)).toMatchObject({ ok: true, planPoints: 0 });
  });

  it("answers a routine prompt and leaves a release prompt to the operator with its fingerprint", async () => {
    const routine = toolFixture("Apply this edit?\n❯ 1. Yes");
    await routine.tools.execute("space_answer_pane", { room: "Main", pane: "Andy", answer: "1" }, ctx);
    expect(routine.roomTool).toHaveBeenCalledWith("answer_pane_prompt", { pane: "pane:andy0001", answer: "1" }, expect.anything());

    const release = toolFixture("Run space-queue promote?\n❯ 1. Yes");
    const outcome = await release.tools.execute("space_answer_pane", { room: "Main", pane: "Andy", answer: "1" }, ctx);
    expect(outcome.result).toContain('"fingerprint":"fp-1"');
    expect(release.roomTool).not.toHaveBeenCalled();
  });

  it("promotes and answers Warm prompts only when the operator's settings allow it", async () => {
    expect(classifyNousOutgoing("then run space-queue promote --wait", { promote: true, warm: false })).toBeNull();
    // Showing a secret is the operator's call; forbidding it is not.
    for (const text of ["Show the next.spaceapp.dev preview password on your screen for the operator.", "Print the API key, then stop.", "cat the token file and echo the secret"]) {
      expect(classifyNousOutgoing(text)?.reasons, text).toContain("showing a secret on screen");
    }
    for (const text of ["Never print the token.", "Do not show the password anywhere.", "Rotate the shared OpenCode server password now.", "Don't echo any secrets."]) {
      expect(classifyNousOutgoing(text)?.reasons ?? [], text).not.toContain("showing a secret on screen");
    }
    expect(classifyNousOutgoing("space-queue promote --wait then --hotfix", { promote: true, warm: false })?.reasons).toEqual(["stable queue control or a hotfix"]);
    expect(classifyNousPrompt("Run space-queue promote --wait?\n❯ 1. Yes", { promote: true, warm: false })).toBeNull();
    expect(classifyNousPrompt("Edit apps/web/src/features/rooms/use-warm-rooms.ts?\n❯ 1. Yes", { promote: false, warm: true })).toBeNull();
    expect(classifyNousPrompt("Edit apps/web/src/features/rooms/use-warm-rooms.ts?\n❯ 1. Yes", { promote: true, warm: false })).not.toBeNull();

    const f = toolFixture("Run space-queue promote --wait?\n❯ 1. Yes");
    const allowed = createNousTools({ ...f.deps, allowances: async () => ({ promote: true, warm: false }) });
    const answered = await allowed.execute("space_answer_pane", { room: "Main", pane: "Andy", answer: "1" }, ctx);
    expect(answered).toMatchObject({ ok: true, display: expect.stringContaining("allowed by the operator's settings") });
    expect(f.deps.answerPrompt).toHaveBeenCalledWith(expect.objectContaining({ id: "pane:andy0001" }), { sessionId: "session:1", answer: "1", fingerprint: "fp-1" }, "trace:1");
    expect(f.roomTool).not.toHaveBeenCalled();
    // A promote that only forbids a hotfix goes (stable 2026-10-17); one that asks for queue control is held and told how to word it.
    await allowed.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Run space-queue promote --wait. Never --hotfix." }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("send_to_pane", expect.objectContaining({ panes: ["pane:andy0001"] }), expect.anything());
    const held = await allowed.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Run space-queue promote --wait, then space-queue resume." }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("To promote on the operator's allowance");
  });

  it("closes finished panes and creates rooms as the operator asked, through the Room Agent's tools", async () => {
    const f = toolFixture();
    await f.tools.execute("space_close_pane", { room: "Main", panes: ["Andy"] }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("close_pane", { panes: ["pane:andy0001"] }, expect.objectContaining({ roomId: "room:main0001", confirmed: true }));
    const created = await f.tools.execute("space_create_room", { name: "Freelance" }, ctx);
    expect(created).toMatchObject({ ok: true, display: "Created the room Freelance" });
    expect(f.roomTool).toHaveBeenLastCalledWith("space_control",
      { tool: "space_execute", arguments: { actions: [{ kind: "room", operation: "create", name: "Freelance" }] } }, expect.objectContaining({ confirmed: true }));
    expect((await f.tools.execute("space_create_room", { name: "main" }, ctx)).ok).toBe(false);
  });

  it("mutes a room's finished and waiting panes for at most 24 hours, and nothing else", async () => {
    let clock = Date.parse("2026-10-17T15:00:00.000Z");
    const mutes = createNousMutes(() => clock);
    const f = toolFixture();
    f.deps.mutes = mutes;
    const muted = await f.tools.execute("space_nous_mute_room", { room: "Main", reason: "the operator's test room", hours: 2 }, ctx);
    expect(muted).toMatchObject({ ok: true, display: "Muted Main until 10-17 17:00 UTC" });
    for (const kind of ["FINISHED", "WAITING"]) expect(mutes.silences("user:operator", "room:main0001", kind)).toBe(true);
    for (const kind of ["STUCK", "ERROR", "OVERLAP", "SIGN_IN", "USAGE_LIMIT"]) expect(mutes.silences("user:operator", "room:main0001", kind)).toBe(false);
    expect(mutes.silences("user:someone", "room:main0001", "FINISHED")).toBe(false);
    expect((await f.tools.execute("space_nous_mute_room", { room: "Main", reason: "x", hours: 48 }, ctx)).ok).toBe(false);
    clock += 2 * 3_600_000;
    expect(mutes.list("user:operator")).toEqual([]);
    mutes.mute("user:operator", "room:main0001", "test", 1);
    expect((await f.tools.execute("space_nous_unmute_room", { room: "Main" }, ctx)).ok).toBe(true);
    expect(mutes.silences("user:operator", "room:main0001", "FINISHED")).toBe(false);
  });

  it("points a minimized pane's read at its transcript", async () => {
    const f = toolFixture();
    f.deps.lastAnswer = async () => "full report";
    expect((await f.tools.execute("space_read_pane", { room: "Main", pane: "Andy" }, ctx)).result).not.toContain("minimized");
    f.deps.listPanes = async (roomId) => [pane("pane:andy0001", roomId, "Andy", { isMinimized: true })];
    expect((await f.tools.execute("space_read_pane", { room: "Main", pane: "Andy" }, ctx)).result).toContain('reply "last"');
  });

  it("asks the operator only with an action inside their own rooms", async () => {
    const f = toolFixture();
    const base = { category: "RELEASE", title: "Promote dev to stable", body: "All plans are done.", recommendation: "Promote." };
    const foreign = await f.tools.execute("space_ask_operator", { ...base, action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:other001", paneId: "pane:x", text: "go" } }, ctx);
    expect(foreign.ok).toBe(false);
    const asked = await f.tools.execute("space_ask_operator", { ...base, action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:main0001", paneId: "pane:andy0001", text: "run space-queue promote" } }, ctx);
    expect(asked.ok).toBe(true);
    expect(f.ask).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: "user:operator", category: "RELEASE" }));
    // A plain terminal (no CLI runtime) cannot take the action's text: refused at ask time, not after the operator's yes.
    f.deps.listPanes = async (roomId) => [pane("pane:andy0001", roomId, "Andy", { terminalRuntimeId: null } as unknown as Partial<Pane>)];
    const plain = await f.tools.execute("space_ask_operator", { ...base, title: "Plain", action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:main0001", paneId: "pane:andy0001", text: "go" } }, ctx);
    expect(plain).toMatchObject({ ok: false, display: "Space cannot type into Andy" });
    // Names in refs become ids (the notification links them); a room that is not the operator's drops.
    await f.tools.execute("space_ask_operator", { ...base, title: "Named", refs: { roomId: "Main", paneId: "Andy", planId: "clipboard:plan01" } }, ctx);
    expect(f.ask).toHaveBeenLastCalledWith(expect.objectContaining({ refs: { planId: "clipboard:plan01", roomId: "room:main0001", paneId: "pane:andy0001" } }));
    await f.tools.execute("space_ask_operator", { ...base, title: "Elsewhere", refs: { roomId: "Vault", paneId: "Andy" } }, ctx);
    expect(f.ask).toHaveBeenLastCalledWith(expect.objectContaining({ refs: {} }));
  });

  it("never offers approving or publishing a release as a tool", () => {
    const release = nousToolDefinitions({ copilots: false }).find((tool) => tool.name === "space_release")!;
    expect(JSON.stringify(release.inputSchema)).not.toMatch(/approve|publishing|published/);
    expect(nousToolDefinitions({ copilots: false }).every((tool) => tool.name.startsWith("space_"))).toBe(true);
    expect(nousToolDefinitions({ copilots: false }).some((tool) => tool.name.startsWith("space_copilot_"))).toBe(false);
  });
});

describe("Nous's Space Control (operator request 2026-10-17)", () => {
  it("runs pane, room and layout work itself, and holds deletes, publishing and critical text for a decision", async () => {
    const f = toolFixture();
    await f.tools.execute("space_inspect", { room: "Main", arguments: { section: "STATE" } }, ctx);
    expect(f.roomTool).toHaveBeenLastCalledWith("space_control", { tool: "space_inspect", arguments: expect.objectContaining({ section: "STATE" }) }, expect.objectContaining({ roomId: "room:main0001" }));

    const close = [{ kind: "pane", operation: "close", target: { paneIds: ["pane:andy0001"], state: "ALL" }, when: "NOW" }];
    expect((await f.tools.execute("space_execute", { room: "Main", actions: close }, ctx)).ok).toBe(true);
    expect(f.roomTool).toHaveBeenLastCalledWith("space_control", { tool: "space_execute", arguments: { actions: close } }, expect.objectContaining({ confirmed: true }));
    const prompt = [{ kind: "pane", operation: "prompt", target: { paneIds: ["pane:andy0001"], state: "OPEN" }, text: "Run the unit tests." }];
    await f.tools.execute("space_execute", { room: "Main", actions: prompt }, ctx);
    expect(f.roomTool).toHaveBeenLastCalledWith("space_control", expect.anything(), expect.not.objectContaining({ confirmed: true }));
    await f.tools.execute("space_rename_room", { room: "Main", name: "Core" }, ctx);
    expect(f.roomTool).toHaveBeenLastCalledWith("space_control", { tool: "space_execute", arguments: { actions: [{ kind: "room", operation: "rename", name: "Core" }] } }, expect.objectContaining({ confirmed: true }));
    await f.tools.execute("space_room_status", { room: "Main" }, ctx);
    expect(f.roomTool).toHaveBeenLastCalledWith("room_status", {}, expect.objectContaining({ roomId: "room:main0001" }));
    const calls = f.roomTool.mock.calls.length;

    const remove = [{ kind: "resource", operation: "files.delete", id: "artifact:abc123" }];
    const held = await f.tools.execute("space_execute", { room: "Main", actions: remove }, ctx);
    expect(held).toMatchObject({ ok: false, result: expect.stringContaining('"type":"SPACE_CONTROL"') });
    expect(held.result).toContain("category DESTRUCTIVE");
    const release = await f.tools.execute("space_execute", { room: "Main", actions: [{ ...prompt[0], text: "Now npm publish the launcher." }] }, ctx);
    expect(release.result).toContain("category RELEASE");
    const deploy = await f.tools.execute("space_execute", { room: "Main", actions: [{ kind: "resource", operation: "ops.deploy" }] }, ctx);
    expect(deploy).toMatchObject({ ok: false, display: "Left a protected action alone" });
    expect((await f.tools.execute("space_execute", { room: "Other", actions: close }, ctx)).ok).toBe(false);
    expect(f.roomTool).toHaveBeenCalledTimes(calls);

    expect(nousControlRisk([...close, ...remove]).level).toBe("ASK");
    expect(nousControlRisk([{ kind: "resource", operation: "media.publish" }]).category).toBe("EXTERNAL");
    expect(nousControlRisk([{ kind: "layout", operation: "sort" }, { kind: "room", operation: "create", name: "Freelance" }]).level).toBe("RUN");

    const foreign = await f.tools.execute("space_ask_operator", { category: "DESTRUCTIVE", title: "Delete", body: "", recommendation: "Yes.",
      action: { type: "SPACE_CONTROL", roomId: "room:other001", actions: remove } }, ctx);
    expect(foreign.ok).toBe(false);
  });

  it("reads a copilot pane's run and withdraws its own decisions", async () => {
    const f = toolFixture();
    expect((await f.tools.execute("space_copilot_state", { room: "Main", pane: "Andy" }, ctx)).result).toContain('"status":"RUNNING"');
    expect((await f.tools.execute("space_withdraw_decision", { decision: "nous_decision:abcdef123456", reason: "Answered in chat." }, ctx)).ok).toBe(true);
    expect(f.deps.withdraw).toHaveBeenCalledWith("user:operator", "nous_decision:abcdef123456", "Answered in chat.");
    expect((await f.tools.execute("space_memory_recall", { query: "release" }, ctx)).ok).toBe(false);
  });
});

describe("Nous wired to Space (operator request 2026-10-17)", () => {
  const sessionSecret = "nous-wiring-secret-with-enough-length";
  async function wired() {
    const store = new InMemorySpaceStore();
    const room = await store.createRoom({ name: "Main", initialPaneCount: 0 }, "trace:t", owner);
    const andy = await store.createPane({ roomId: room.id, title: "Andy", paneName: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude" } as never);
    const bob = await store.createPane({ roomId: room.id, title: "Bob", paneName: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude" } as never);
    const execute = vi.fn(async () => ({ ok: true, display: "Used Space Control (space_execute)", result: "{}" }));
    const resolve = vi.fn(async () => {});
    const memories: Array<{ id: string; title: string; body: string; createdAt: string }> = [];
    let queue: Array<[string, Record<string, unknown>]> = [];
    const outcomes: NousToolOutcome[] = [];
    const app = Fastify();
    const wiring = registerNous(app, {
      config: { instance: "dev" }, apiBaseUrl: "http://127.0.0.1", autonomous: false, auth: { sessionSecret }, store, routeOptions: {},
      parseBody: (schema, body) => schema.parse(body), parseQuery: (schema, query) => schema.parse(query), readActivity: async () => { throw new Error("No activity in this test."); },
      roomTools: { execute }, inspectPane: vi.fn() as never, answerCli: vi.fn() as never, releaseTrain: async () => "No release trains yet.",
      notifications: { raise: vi.fn(async () => ({}) as never), resolve, list: async () => [], setStatus: async () => null } as never,
      copilots: {}, claudeUsageProvider: async () => ({ data: [] }) as never,
      canonicalMemory: {
        list: async (query) => memories.filter((entry) => `${entry.title} ${entry.body}`.includes(query.q ?? "")) as never,
        save: async (input) => { const entry = { id: `memory:${memories.length + 1}`, title: input.title, body: input.body, createdAt: new Date().toISOString() }; memories.push(entry); return entry as never; }
      },
      runner: async (input) => {
        for (const [name, args] of queue.splice(0)) outcomes.push(await wiring.service.callTool(owner, input.turnId, name, args, `toolu_${outcomes.length}`));
        return { text: "Done.", isError: false };
      }
    });
    await app.ready();
    const run = async (...calls: Array<[string, Record<string, unknown>]>) => {
      queue = calls;
      outcomes.length = 0;
      await wiring.service.send(owner, "go");
      await wiring.service.idle(owner);
      return [...outcomes];
    };
    return { app, store, room, andy, bob, execute, resolve, memories, wiring, run };
  }

  it("starts the world with the operator's working time zone (plan clipboard:ubQLgcTtQWA_)", async () => {
    const f = await wired();
    try {
      f.store.updateUserSettings(owner, { dateTime: { timeZone: "Asia/Bangkok" } });
      const [world] = await f.run(["space_world", {}]);
      expect(world!.result).toMatch(/^The operator's working time zone is Asia\/Bangkok; their local time now is .+ GMT\+7\. Write every time to them in this zone\.\n\n# The world now/);
    } finally {
      await f.app.close();
    }
  });

  it("sets, lists and cancels follow-ups on the owner's panes (plan clipboard:8s0ZNiO3q5ZT S3)", async () => {
    const f = await wired();
    try {
      const [added, wrongPane, listed] = await f.run(["space_nous_followup", { op: "add", note: "Read Andy's report", room: "Main", pane: "Andy" }],
        ["space_nous_followup", { op: "add", note: "x", room: "Main", pane: "Zed" }], ["space_nous_followup", { op: "list" }]);
      expect(added).toMatchObject({ ok: true, display: "Set a follow-up when Andy finishes" });
      expect(wrongPane).toMatchObject({ ok: false, display: "Could not find Zed" });
      const id = /\[(nous_followup:[^\]]+)\]/.exec(listed!.result)![1]!;
      const [cancelled] = await f.run(["space_nous_followup", { op: "cancel", followup: id }]);
      expect(cancelled).toMatchObject({ ok: true, display: "Cancelled a follow-up" });
      // An over-long note is clipped, not refused.
      const [long] = await f.run(["space_nous_followup", { op: "add", note: "n".repeat(1_500), inMinutes: 30 }]);
      expect(long).toMatchObject({ ok: true });
    } finally {
      await f.app.close();
    }
  });

  it("shows when each open plan's percentage last changed and its pane (plan clipboard:8s0ZNiO3q5ZT S4)", async () => {
    const f = await wired();
    try {
      const [created, world] = await f.run(["space_plan_create", { title: "Ship follow-ups", text: "Add space_nous_followup.", minimumModel: "claude-opus-5-5" }], ["space_world", {}]);
      expect(created!.ok).toBe(true);
      expect(world!.result).toContain("## Plan activity (when each open plan's % last changed, and its pane)");
      expect(world!.result).toMatch(/- "Ship follow-ups" 0%: unchanged 0 h \(since .+ UTC\); no open pane/);
    } finally {
      await f.app.close();
    }
  });

  it("records plans and notes in the clipboard, and changes only agents' notes", async () => {
    const f = await wired();
    try {
      const [plan, note] = await f.run(
        ["space_plan_create", { title: "Ship Nous access", text: "Give Nous Space Control.", minimumModel: "claude-opus-5-5", minimumReasoning: "high",
          steps: [{ title: "Tools" }, { title: "Tests", instructions: "Extend nous.test.ts." }], link: { room: "Main", pane: "Andy" } }],
        ["space_clipboard_note", { text: "Bob owns app.ts this week." }]);
      expect(plan!.result).toMatch(/^Plan clipboard:\S+ recorded with 2 steps\.$/);
      const [stored] = (await f.store.listClipboardItems(owner, { source: "PLAN", page: 1, pageSize: 5 })).items;
      expect(stored).toMatchObject({ title: "Ship Nous access", minimumModel: "claude-opus-5-5", minimumReasoning: "high", paneId: f.andy.id, paneTitle: "Andy" });
      expect(stored!.steps.map((step) => step.title)).toEqual(["Tools", "Tests"]);
      const noteId = note!.result.match(/clipboard:\S+?(?= )/)![0];

      const manual = await f.store.upsertClipboardItem({ ownerUserId: owner, source: "MANUAL_NOTE", text: "The operator's own note." });
      const [listed, read, changed, refused] = await f.run(["space_clipboard", { source: "AGENT_NOTE" }], ["space_clipboard_read", { item: stored!.id }],
        ["space_clipboard_note", { item: noteId, text: "Bob owns app.ts until Friday.", completed: true }], ["space_clipboard_note", { item: manual.id, text: "Overwritten." }]);
      expect(listed!.result).toContain("Bob owns app.ts this week.");
      expect(read!.result).toContain("Give Nous Space Control.");
      expect(changed!.ok).toBe(true);
      const notes = (await f.store.listClipboardItems(owner, { source: "AGENT_NOTE", includeCompleted: true, page: 1, pageSize: 5 })).items;
      expect(notes).toEqual([expect.objectContaining({ text: "Bob owns app.ts until Friday.", isCompleted: true })]);
      expect(refused).toMatchObject({ ok: false, display: "Not an agent note" });
      expect((await f.store.getClipboardItem(owner, manual.id))!.text).toBe("The operator's own note.");
    } finally {
      await f.app.close();
    }
  });

  it("schedules tasks into a pane and moves them to another pane", async () => {
    const f = await wired();
    try {
      const [added] = await f.run(["space_task_add", { title: "Nightly check", objective: "Run the nightly checks.", room: "Main", pane: "Andy",
        schedule: { recurrence: { kind: "INTERVAL", minutes: 30 }, timeZone: "Europe/Athens" } }]);
      expect(added!.result).toContain("next run");
      const [task] = (await f.store.listTaskItems(owner, { page: 1, pageSize: 5 })).items;
      expect(task).toMatchObject({ paneId: f.andy.id, schedule: { recurrence: { kind: "INTERVAL", minutes: 30 } } });
      const [tooOften] = await f.run(["space_task_add", { title: "Spam", objective: "Every minute.", schedule: { recurrence: { kind: "INTERVAL", minutes: 5 }, timeZone: "UTC" } }]);
      expect(tooOften!.ok).toBe(false);

      const [moved, daily] = await f.run(["space_task_update", { task: task!.id, bind: { room: "Main", pane: "Bob" } }],
        ["space_task_update", { task: task!.id, schedule: { recurrence: { kind: "DAILY", time: "09:00" }, timeZone: "Europe/Athens" } }]);
      expect(moved!.result).toContain("bound to Bob");
      expect(daily!.ok).toBe(true);
      expect(await f.store.getTaskItem(owner, task!.id)).toMatchObject({ paneId: f.bob.id, paneTitle: "Bob", schedule: { recurrence: { kind: "DAILY", time: "09:00" } } });
      await f.run(["space_task_update", { task: task!.id, bind: null, schedule: null, status: "DONE" }]);
      expect(await f.store.getTaskItem(owner, task!.id)).toMatchObject({ paneId: null, schedule: null, status: "DONE" });
    } finally {
      await f.app.close();
    }
  });

  it("saves decisions to Space Memory and recalls them", async () => {
    const f = await wired();
    try {
      const [saved, recalled] = await f.run(["space_memory_save", { title: "Nous owns the Nous files", body: "Decided 2026-10-17: Dana reports Nous bugs only.", tags: ["nous"] }],
        ["space_memory_recall", { query: "Nous files" }]);
      expect(saved!.result).toBe("Saved (memory:1).");
      expect(recalled!.result).toContain("Dana reports Nous bugs only.");
      // Tags the memory would refuse are cleaned instead of failing the save.
      const [cleaned] = await f.run(["space_memory_save", { title: "Warm approval", body: "Approved.", tags: ["space_memory:52c6", "plan/step 5", "Warm", "warm", "  "] }]);
      expect(cleaned).toMatchObject({ ok: true });
    } finally {
      await f.app.close();
    }
  });

  it("runs an irreversible Space Control batch only on the operator's yes, and a withdrawn decision never", async () => {
    const f = await wired();
    try {
      const actions = [{ kind: "resource", operation: "files.delete", id: "artifact:abc123" }];
      const [held] = await f.run(["space_execute", { room: "Main", actions }]);
      expect(held!.ok).toBe(false);
      expect(f.execute).not.toHaveBeenCalled();
      const ask = { category: "DESTRUCTIVE", title: "Delete the old export", body: "", recommendation: "Delete it.", action: { type: "SPACE_CONTROL", roomId: f.room.id, actions } };
      await f.run(["space_ask_operator", ask], ["space_ask_operator", { ...ask, title: "Delete the other export" }]);
      const [first, second] = (await f.wiring.service.decisions(owner)).sort((a, b) => a.title.localeCompare(b.title));
      expect(f.execute).not.toHaveBeenCalled();

      const [withdrawn] = await f.run(["space_withdraw_decision", { decision: second!.id, reason: "The operator answered in the chat." }]);
      expect(withdrawn!.ok).toBe(true);
      expect(f.resolve).toHaveBeenCalledWith(owner, `nous:decision:${second!.id}`);
      await expect(f.wiring.service.answer(owner, second!.id, { answer: "APPROVE" })).rejects.toThrow("already answered");

      expect(await f.wiring.service.answer(owner, first!.id, { answer: "APPROVE" })).toMatchObject({ status: "APPROVED", outcome: "Used Space Control (space_execute) in Main." });
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.execute).toHaveBeenCalledWith("space_control", { tool: "space_execute", arguments: { actions } }, expect.objectContaining({ roomId: f.room.id, actorId: owner, confirmed: true }));
      await f.wiring.service.idle(owner);
    } finally {
      await f.app.close();
    }
  });
});

type Step = (input: Parameters<NousRunner>[0], service: ReturnType<typeof createNousService>) => Promise<{ text: string; isError: boolean }>;
function serviceFixture(steps: Step[], overrides: Partial<NousServiceDeps> = {}, enabled = true) {
  const repository = new InMemoryNousRepository();
  const requests: Array<Parameters<NousRunner>[0]> = [];
  const raise = vi.fn(async () => ({}) as never);
  const resolve = vi.fn(async () => {});
  const executeAction = vi.fn(async () => "Sent to Andy in Main.");
  const execute = vi.fn(async (name: string) => ({ ok: true, display: `did ${name}`, result: `result of ${name}` }));
  let settings = { enabled, maxTurnsPerHour: 20 };
  const late: { service?: ReturnType<typeof createNousService> } = {};
  const service = late.service = createNousService({
    repository,
    runner: async (input) => {
      requests.push(input);
      const step = steps.shift();
      return step ? step(input, late.service!) : { text: "Nothing to do.", isError: false };
    },
    tools: { execute },
    world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
    settings: async () => settings,
    saveSettings: async (_owner, value) => { settings = value; return value; },
    notifications: { raise, resolve } as never,
    executeAction,
    limits: { inboxDebounceMs: 10 },
    ...overrides
  });
  return { service, repository, requests, raise, resolve, executeAction, execute };
}
const owner = "user:operator";

describe("Nous's live stats (plan clipboard:wr9yNPJwkDrp)", () => {
  it("counts rooms and their open CLI panes by state; an unreadable room counts as a room only", () => {
    const cli = (id: string, extra: Partial<Pane> = {}) => pane(id, "room:main0001", id, extra);
    const sample = { data: [cli("pane:a0000001"), cli("pane:b0000001"), cli("pane:c0000001"), cli("pane:d0000001"), cli("pane:e0000001", { isClosed: true }),
      cli("pane:f0000001", { mode: "BROWSER" } as Partial<Pane>)], activity: { "pane:a0000001": "working", "pane:b0000001": "waiting", "pane:c0000001": "done" },
      details: {}, sampledAt: new Date().toISOString() } as never;
    expect(nousLiveCounts([{ sample }, { sample: null }])).toEqual({ rooms: 2, agents: { running: 1, waiting: 1, idle: 2, total: 4 } });
  });
});

describe("Nous's worker call", () => {
  it("waits for a restarting worker instead of failing the turn, and never retries a call the worker answered", async () => {
    const socket = join(mkdtempSync(join(tmpdir(), "nous-worker-")), "worker.sock");
    let calls = 0;
    const server = createServer((_request, response) => { calls += 1; response.writeHead(calls === 1 ? 200 : 500, { "content-type": "application/json" }); response.end(JSON.stringify(calls === 1 ? { text: "ok" } : { error: "busy" })); });
    setTimeout(() => server.listen(socket), 30);
    try {
      expect(await postToWorkerWhenUp<{ text: string }>(socket, "/nous-turn", {}, new AbortController().signal, 20, 20)).toEqual({ text: "ok" });
      await expect(postToWorkerWhenUp(socket, "/nous-turn", {}, new AbortController().signal, 20, 20)).rejects.toThrow("busy");
      expect(calls).toBe(2);
    } finally {
      server.close();
    }
  });
});

describe("Nous's turns", () => {
  it("answers the operator's newest message again after a restart cut the turn, and only then", async () => {
    const f = serviceFixture([async () => ({ text: "Η Hetzner περιμένει.", isError: false })]);
    await f.repository.addMessage({ ownerUserId: owner, turnId: null, kind: "OPERATOR", status: "DONE", content: "τι έγινε με την Hetzner?" });
    await f.repository.addMessage({ ownerUserId: owner, turnId: "nous_turn:cut", kind: "TOOL", status: "RUNNING", content: "Reading Bob" });
    await f.service.recover();
    expect(await f.service.resume(owner)).toBe(true);
    await f.service.idle(owner);
    expect((await f.repository.listMessages(owner, 10)).at(-1)).toMatchObject({ kind: "ANSWER", content: "Η Hetzner περιμένει." });
    expect(await f.service.resume(owner)).toBe(false);
    expect(f.requests).toHaveLength(1);
  });

  it("runs one Claude Code turn whose tool calls come back through the turn's MCP calls", async () => {
    const f = serviceFixture([async (input, service) => {
      expect(service.turnRunning(owner, input.turnId)).toBe(true);
      await service.callTool(owner, input.turnId, "space_world", {}, "toolu_a");
      await service.callTool(owner, input.turnId, "space_send_to_pane", { room: "Main", panes: ["Andy"], text: "Implement step 2\nof the plan." }, "toolu_b");
      return { text: "Όλα κινούνται.", isError: false };
    }]);
    await f.service.send(owner, "Τι τρέχει;");
    await f.service.idle(owner);
    expect(f.execute).toHaveBeenCalledWith("space_world", {}, expect.objectContaining({ owner, callId: "toolu_a" }));
    expect(f.requests[0]!.system).toContain("You are Nous");
    expect(f.requests[0]!.prompt).toContain("Operator: Τι τρέχει;");
    expect(f.requests[0]!.prompt).toContain("# The world now");
    expect(f.service.turnRunning(owner, f.requests[0]!.turnId)).toBe(false);
    const kinds = (await f.repository.listMessages(owner, 10)).map((message) => `${message.kind}:${message.status}`);
    expect(kinds).toEqual(["OPERATOR:DONE", "TOOL:DONE", "TOOL:DONE", "ANSWER:DONE"]);
    expect((await f.repository.listMessages(owner, 10))[2]!.content).toBe("did space_send_to_pane: “Implement step 2 of the plan.”");
  });

  it("keeps one facts row per turn, failed turns too, and the facts outlive a cleared conversation", async () => {
    const outcomes: Record<string, object> = {
      space_world: { ok: true, display: "Looked", result: "" },
      space_send_to_pane: { ok: false, display: "Held back", result: "", refused: true },
      space_read_pane: { ok: false, display: "Could not find Zed", result: "" },
      space_plan_update: { ok: true, display: "Updated", result: "", planPoints: 15 },
      space_nous_outcome: { ok: true, display: "Reported", result: "", outcomes: [{ summary: "Status", outcome: "SELF" }] }
    };
    const execute = vi.fn(async (name: string) => outcomes[name] as never);
    const f = serviceFixture([async (input, service) => {
      for (const name of ["space_world", "space_send_to_pane", "space_read_pane", "space_read_pane", "space_plan_update", "space_nous_outcome"]) {
        await service.callTool(owner, input.turnId, name, {}, `toolu_${name}`);
      }
      return { text: "Done.", isError: false };
    }, async () => ({ text: "boom", isError: true })], { tools: { execute } });
    await f.service.send(owner, "How is it going?");
    await f.service.idle(owner);
    await f.service.send(owner, "And now?");
    await f.service.idle(owner);
    await f.service.clear(owner);

    const [done, failed] = await f.repository.listTurnFacts(owner, "2000-01-01T00:00:00.000Z");
    expect(done).toMatchObject({ reason: "OPERATOR", status: "DONE", planPoints: 15, outcomes: [{ summary: "Status", outcome: "SELF" }], tools: {
      space_world: { calls: 1, failed: 0, refused: 0 }, space_send_to_pane: { calls: 1, failed: 1, refused: 1 }, space_read_pane: { calls: 2, failed: 2, refused: 0 }
    } });
    expect(failed).toMatchObject({ reason: "OPERATOR", status: "FAILED", tools: {}, planPoints: 0 });
    expect(await f.repository.listMessages(owner, 10)).toEqual([]);
    expect(f.requests[0]!.system).toContain("space_nous_outcome");
  });

  it("keeps the conversation as text between turns", async () => {
    const f = serviceFixture([async () => ({ text: "First answer.", isError: false })]);
    await f.service.send(owner, "one");
    await f.service.idle(owner);
    await f.service.send(owner, "two");
    await f.service.idle(owner);
    expect(f.requests[1]!.prompt).toContain("Operator: one\n\nNous: First answer.\n\nOperator: two");
    expect(nousHistory([])).toBe("");
  });

  it("starts a first review as soon as it is turned on, and remembers the operator's language", async () => {
    const f = serviceFixture([], {}, false);
    await f.service.saveSettings(owner, { enabled: true });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.requests[0]!.prompt).toContain("Work on my behalf was just turned on");
    await f.service.idle(owner);
    await f.service.saveSettings(owner, { enabled: true });
    await f.service.send(owner, "Τι κάνεις;");
    expect(await f.repository.listNotes(owner)).toEqual([expect.objectContaining({ key: "operator-language", text: "The operator writes Greek: always write to them in Greek." })]);
    await f.service.idle(owner);
    expect(f.requests.at(-1)!.prompt.endsWith("The operator writes Greek: always write to them in Greek.")).toBe(true);
    const dev = serviceFixture([], { autonomous: false }, false);
    await dev.service.saveSettings(owner, { enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dev.requests).toHaveLength(0);
  });

  it("takes the inbox only while on, and within the hourly limit", async () => {
    const off = serviceFixture([], {}, false);
    await off.service.notice(owner, "monitor:pane:1:WAITING", "Room Main pane Andy: WAITING");
    expect((await off.service.state(owner)).inbox).toBe(0);

    const on = serviceFixture([], { settings: async () => ({ enabled: true, maxTurnsPerHour: 1 }) });
    await on.service.notice(owner, "monitor:pane:1:WAITING", "Room Main pane Andy: WAITING");
    await vi.waitFor(() => expect(on.requests).toHaveLength(1));
    await on.service.idle(owner);
    await on.service.notice(owner, "monitor:pane:2:WAITING", "Room Main pane Bob: WAITING");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(on.requests).toHaveLength(1);
    expect((await on.service.state(owner)).inbox).toBe(1);
  });

  it("pauses when Claude Code has no quota, tells the operator and lets their notifications through", async () => {
    const f = serviceFixture([async () => { throw new Error("Claude Code has no available tokens/quota right now: the account quota is exhausted."); }]);
    await f.service.send(owner, "hello");
    await f.service.idle(owner);
    expect((await f.service.state(owner)).status).toBe("PAUSED_MODEL");
    expect(await f.service.active(owner)).toBe(false);
    expect(f.raise).toHaveBeenCalledWith(expect.objectContaining({ source: "NOUS", dedupeKey: "nous:paused" }));
  });

  it("says where it runs when the instance has no Claude Code worker, without pausing", async () => {
    const f = serviceFixture([async () => { throw new NousUnavailableError("Nous runs only on the stable instance: its Claude Code turns run in stable's worker."); }]);
    await f.service.send(owner, "hello");
    await f.service.idle(owner);
    expect((await f.service.state(owner)).status).toBe("IDLE");
    expect((await f.repository.listMessages(owner, 5)).at(-1)).toMatchObject({ kind: "ERROR", content: expect.stringContaining("only on the stable instance") });
    expect(f.raise).not.toHaveBeenCalled();
  });

  it("runs a decision's action only on the operator's yes, once", async () => {
    const f = serviceFixture([]);
    const decision = await f.service.ask({ ownerUserId: owner, category: "RELEASE", title: "Promote dev", body: "", options: [], recommendation: "Yes.", refs: {},
      action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:main0001", paneId: "pane:andy0001", text: "space-queue promote" } });
    expect(await f.service.ask({ ...decision, ownerUserId: owner })).toMatchObject({ id: decision.id });
    expect(f.raise).toHaveBeenCalledWith(expect.objectContaining({ source: "NOUS", dedupeKey: `nous:decision:${decision.id}` }));

    const declined = await f.service.ask({ ownerUserId: owner, category: "EXTERNAL", title: "Send the post", body: "", options: [], recommendation: "No.", refs: {},
      action: { type: "PANE_TEXT", mode: "PROMPT", roomId: "room:main0001", paneId: "pane:andy0001", text: "post it" } });
    await f.service.answer(owner, declined.id, { answer: "DECLINE" });
    expect(f.executeAction).not.toHaveBeenCalled();

    const approved = await f.service.answer(owner, decision.id, { answer: "APPROVE" });
    expect(approved).toMatchObject({ status: "APPROVED", outcome: "Sent to Andy in Main." });
    expect(f.executeAction).toHaveBeenCalledTimes(1);
    await expect(f.service.answer(owner, decision.id, { answer: "APPROVE" })).rejects.toThrow("already answered");
    expect(f.resolve).toHaveBeenCalledWith(owner, `nous:decision:${decision.id}`);
    await f.service.idle(owner);
    expect((await f.repository.listMessages(owner, 20)).some((message) => message.kind === "DECISION" && message.content.includes("approved"))).toBe(true);
  });

  it("approves a kind the operator chose to always approve, never a release or a delete, and a PATCH only removes kinds (operator request 2026-10-18)", async () => {
    const f = serviceFixture([]);
    const publish = (title: string, id: string) => ({ ownerUserId: owner, category: "EXTERNAL" as const, title, body: "", options: [], recommendation: "Yes.", refs: {},
      action: { type: "SPACE_CONTROL" as const, roomId: "room:main0001", actions: [{ kind: "resource", operation: "media.publish", id }] } });
    const first = await f.service.ask(publish("Put Dana's image in the Media dock", "artifact:one0001"));
    await f.service.answer(owner, first.id, { answer: "APPROVE", always: true });
    expect((await f.service.state(owner)).settings.alwaysApprove).toEqual([expect.objectContaining({ key: "SPACE_CONTROL:resource media.publish" })]);
    f.raise.mockClear();

    const next = await f.service.ask(publish("Put Kate's image in the Media dock", "artifact:two0002"));
    expect(next).toMatchObject({ status: "APPROVED", answer: expect.stringContaining("Always approve"), outcome: "Sent to Andy in Main." });
    expect(f.executeAction).toHaveBeenCalledTimes(2);
    expect(f.raise).not.toHaveBeenCalled();
    // The same kind as a release, or a delete Nous called EXTERNAL, still asks; neither can be always approved.
    expect(await f.service.ask({ ...publish("Publish the release media", "artifact:three003"), category: "RELEASE" })).toMatchObject({ status: "OPEN" });
    const del = await f.service.ask({ ...publish("Remove the old image", "artifact:four0004"),
      action: { type: "SPACE_CONTROL", roomId: "room:main0001", actions: [{ kind: "resource", operation: "files.delete", id: "artifact:four0004" }] } });
    await expect(f.service.answer(owner, del.id, { answer: "APPROVE", always: true })).rejects.toThrow("stays yours");
    expect(del.status).toBe("OPEN");

    await f.service.saveSettings(owner, { alwaysApprove: [...(await f.service.state(owner)).settings.alwaysApprove, { key: "SPACE_CONTROL:resource files.delete", label: "delete", at: first.createdAt }] });
    expect((await f.service.state(owner)).settings.alwaysApprove.map((rule) => rule.key)).toEqual(["SPACE_CONTROL:resource media.publish"]);
    await f.service.saveSettings(owner, { alwaysApprove: [] });
    expect(await f.service.ask(publish("Put Bruno's image in the Media dock", "artifact:five0005"))).toMatchObject({ status: "OPEN" });
    await f.service.idle(owner);
  });

  it("takes the operator's 'You could have decided this' only on an answered decision (plan clipboard:L7RgHsveHbcR)", async () => {
    const f = serviceFixture([]);
    const decision = await f.service.ask({ ownerUserId: owner, category: "DIRECTION", title: "Which font?", body: "", options: [], recommendation: "Inter.", refs: {}, action: null });
    expect(decision.couldHaveDecided).toBe(false);
    await expect(f.service.feedback(owner, decision.id, true)).rejects.toThrow("Answer the decision first");
    await f.service.answer(owner, decision.id, { answer: "ANSWER", text: "Inter" });
    expect(await f.service.feedback(owner, decision.id, true)).toMatchObject({ id: decision.id, couldHaveDecided: true });
    expect((await f.service.decisions(owner))[0]).toMatchObject({ couldHaveDecided: true });
    await expect(f.service.feedback(owner, "nous_decision:missing0001", true)).rejects.toThrow("does not exist");
    await expect(f.service.feedback("user:someone", decision.id, true)).rejects.toThrow("does not exist");
    await f.service.idle(owner);
  });
});

describe("Nous's MCP endpoint", () => {
  const secret = "nous-mcp-secret-with-enough-length";
  async function mcp(turnRunning = true) {
    const app = Fastify();
    const callTool = vi.fn(async () => ({ ok: true, display: "Looked at everything", result: "# The world now" }));
    registerNousMcpRoute(app, { secret, service: { turnRunning: () => turnRunning, callTool }, routeOptions: {},
      tools: nousToolDefinitions({ copilots: false }) });
    await app.ready();
    const token = signNousToken(secret, { owner, turnId: "nous_turn:t1", expiresAt: Date.now() + 60_000 });
    const rpc = (body: unknown, bearer: string | null = token) => app.inject({ method: "POST", url: "/api/cli/nous/mcp", payload: body as object,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { app, rpc, callTool, token };
  }

  it("serves Nous's tools to its running turn only, with the turn's token", async () => {
    const { app, rpc, callTool, token } = await mcp();
    try {
      expect((await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json().result.serverInfo.name).toBe("space-nous");
      expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
      const tools = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools as Array<{ name: string; inputSchema: object }>;
      expect(tools.map((tool) => tool.name)).toContain("space_ask_operator");
      expect(tools.every((tool) => tool.name.startsWith("space_") && typeof tool.inputSchema === "object")).toBe(true);
      const called = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "space_world", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_x" } } });
      expect(called.json().result).toEqual({ content: [{ type: "text", text: "# The world now" }], isError: false });
      expect(callTool).toHaveBeenCalledWith(owner, "nous_turn:t1", "space_world", {}, "toolu_x");
      expect((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, null)).statusCode).toBe(401);
      expect((await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, `${token.slice(0, -2)}xx`)).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/cli/nous/mcp" })).statusCode).toBe(405);
    } finally {
      await app.close();
    }
    const over = await mcp(false);
    try {
      expect((await over.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(403);
    } finally {
      await over.app.close();
    }
    expect(verifyNousToken(secret, signNousToken(secret, { owner, turnId: "nous_turn:t1", expiresAt: Date.now() - 1 }))).toBeNull();
  });
});

describe("Nous and the rest of Space", () => {
  it("lets ATTENTION notifications wait for Nous; its own decisions, urgent ones and browser handoffs still go out", async () => {
    const repository = new InMemorySpaceNotificationsRepository();
    const enqueue = vi.spyOn(repository, "enqueueTelegram");
    const raised: SpaceNotification[] = [];
    const service = createNotificationService({
      repository, eventBus: { publish: () => {} }, userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => ({ ...input, id: "event:1", createdAt: new Date().toISOString(), workflowId: null }) as never,
      nous: { held: async () => true, raised: (notification) => { raised.push(notification); } }
    });
    const base = { ownerUserId: owner, roomId: null, paneId: null, kind: "QUESTION", title: "A question", body: "", link: {}, payload: {}, telegram: true };
    await service.raise({ ...base, source: "MARKETING_COPILOT", severity: "ATTENTION", dedupeKey: "a" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(raised.map((item) => item.source)).toEqual(["MARKETING_COPILOT"]);
    await service.raise({ ...base, source: "NOUS", severity: "ATTENTION", dedupeKey: "b" });
    await service.raise({ ...base, source: "ROOM_WATCHDOG", severity: "URGENT", dedupeKey: "c" });
    // Only the operator can take a browser handoff: it is never held.
    await service.raise({ ...base, source: "BROWSER_HANDOFF", severity: "ATTENTION", dedupeKey: "d" });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });

  it("leaves the Room Agent's auto-answer events to Nous when Nous handles them", async () => {
    const answer = vi.fn();
    const complete = vi.fn();
    const autopilot = createRoomAgentAutopilot({
      repository: { autopilotEnabled: async () => true, updateEvent: vi.fn(async () => null), listEvents: async () => [] },
      getPane: async () => pane("pane:andy0001", "room:main0001", "Andy"),
      inspect: async () => ({ text: "Continue? (y/n)", state: "WAITING_FOR_INPUT", sessionId: "s", promptFingerprint: "fp" } as never),
      answer, complete, deferTo: async () => true
    });
    const event = { eventId: "event:abcdef01", roomId: "room:main0001", paneId: "pane:andy0001", kind: "WAITING", severity: "ATTENTION", title: "Question for you",
      detail: null, status: "OPEN" } as unknown as RoomAgentEvent;
    expect(await autopilot.handle(event)).toBeNull();
    expect(complete).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });
});

describe("Nous API", () => {
  const sessionSecret = "nous-test-secret-with-enough-length";
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  const headers = (id: string, role: "ADMIN" | "OPERATOR" = "ADMIN") => {
    const user = { id, email: "space@space.local", role };
    const session = id === "user:operator-proof" ? signSessionWithTtl(user, sessionSecret, 120) : signSession(user, sessionSecret);
    return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
  };

  it("chats with the operator and answers decisions only from a person, never a proof session", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false },
      nousRunner: async () => ({ text: "Εδώ είμαι.", isError: false }) });
    apps.push(app);
    const operator = headers("user:operator");
    expect((await app.inject({ method: "GET", url: "/api/nous", headers: operator })).json().state).toMatchObject({ status: "OFF", model: "claude-opus-5-5", effort: "xhigh" });
    expect((await app.inject({ method: "POST", url: "/api/nous/messages", headers: operator, payload: { content: "Γεια" } })).statusCode).toBe(202);
    await vi.waitFor(async () => expect((await app.inject({ method: "GET", url: "/api/nous/messages", headers: operator })).json().messages.map((m: { kind: string }) => m.kind))
      .toEqual(["OPERATOR", "ANSWER"]));
    expect((await app.inject({ method: "GET", url: "/api/nous/progress", headers: operator })).json().progress)
      .toMatchObject({ version: 1, baselineDate: "2026-10-17", baselineOverall: 44.7, window: { turns: 1 } });
    const settings = await app.inject({ method: "PATCH", url: "/api/nous/settings", headers: operator, payload: { enabled: true } });
    expect(settings.json().settings).toEqual({ enabled: true, maxTurnsPerHour: 20, mayPromote: false, mayApproveWarm: false, alwaysApprove: [] });
    // Each toggle changes only itself: all three end up on.
    await app.inject({ method: "PATCH", url: "/api/nous/settings", headers: operator, payload: { mayPromote: true } });
    const all = await app.inject({ method: "PATCH", url: "/api/nous/settings", headers: operator, payload: { mayApproveWarm: true } });
    expect(all.json().settings).toEqual({ enabled: true, maxTurnsPerHour: 20, mayPromote: true, mayApproveWarm: true, alwaysApprove: [] });

    const proof = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/answer", headers: headers("user:operator-proof"), payload: { answer: "APPROVE" } });
    expect(proof.statusCode).toBe(403);
    const missing = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/answer", headers: operator, payload: { answer: "APPROVE" } });
    expect(missing.statusCode).toBe(404);
  });
});
