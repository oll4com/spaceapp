import { describe, expect, it, vi } from "vitest";
import type { ChannelInboundMessage, DotProfile, Pane } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import type { ChannelIdentityRecord, ChannelOutboxRecord, ChannelsRepository, ChannelThreadRecord } from "@space/db";
import { createDotChannelService } from "../src/dot-channels.js";

const dots = ["Orbit", "Nova"].map((name, index) => ({ dotId: `dot:${String(index + 1).repeat(32)}`, name, slot: index + 1 }) as DotProfile);
type InboxRow = { threadId: string; eventId: string; text: string; requestKey: string; status: string };
function memoryRepo() {
  const codes = new Map<string, { owner: string; used: boolean }>();
  const identities: ChannelIdentityRecord[] = [], threads: ChannelThreadRecord[] = [];
  const events = new Set<string>(), inbox: InboxRow[] = [];
  const outbox: Array<ChannelOutboxRecord & { status: string; error?: string }> = [];
  let n = 0;
  const repo: ChannelsRepository = {
    createLinkCode: async (owner, code) => { codes.set(code, { owner, used: false }); },
    linkIdentity: async (code, identity) => {
      const entry = codes.get(code); if (!entry || entry.used) return null;
      const existing = identities.find((item) => item.provider === identity.provider && item.tenantId === identity.tenantId && item.externalUserId === identity.externalUserId);
      if (existing && existing.ownerUserId !== entry.owner) return "LINKED_ELSEWHERE";
      entry.used = true;
      if (existing) return existing;
      const record = { ...identity, identityId: `channel_identity:${String(++n).padStart(32, "0")}`, ownerUserId: entry.owner, createdAt: new Date().toISOString() };
      identities.push(record); return record;
    },
    burnLinkCode: async (code) => { const entry = codes.get(code); if (entry) entry.used = true; },
    identity: async (provider, tenantId, externalUserId) => identities.find((item) => item.provider === provider && item.tenantId === tenantId && item.externalUserId === externalUserId) ?? null,
    identities: async (owner) => identities.filter((item) => item.ownerUserId === owner),
    identityById: async (id) => identities.find((item) => item.identityId === id) ?? null,
    updateReplyAddress: async (id, address) => { identities.find((item) => item.identityId === id)!.replyAddress = address; },
    unlink: async (owner, id) => { const index = identities.findIndex((item) => item.identityId === id && item.ownerUserId === owner); if (index < 0) return false; identities.splice(index, 1); return true; },
    markEvent: async (provider, eventId) => { const key = `${provider}:${eventId}`; if (events.has(key)) return false; events.add(key); return true; },
    thread: async (provider, tenantId, conversationId, threadKey) => threads.find((item) => item.provider === provider && item.tenantId === tenantId
      && item.conversationId === conversationId && item.threadKey === threadKey) ?? null,
    createThread: async (input) => {
      const existing = threads.find((item) => item.provider === input.provider && item.conversationId === input.conversationId && item.threadKey === input.threadKey);
      if (existing) return existing;
      const at = new Date(Date.now() - 1000).toISOString();
      const record = { ...input, threadId: `channel_thread:${String(++n).padStart(32, "0")}`, replyInThread: false, lastDeliveredRunId: null, createdAt: at, updatedAt: at };
      threads.push(record); return record;
    },
    updateThread: async (id, patch) => { Object.assign(threads.find((item) => item.threadId === id)!, patch); },
    threads: async (owner) => threads.filter((item) => item.ownerUserId === owner),
    threadById: async (id) => threads.find((item) => item.threadId === id) ?? null,
    threadForSession: async (sessionId, provider) => threads.find((item) => item.sessionId === sessionId && item.provider === provider) ?? null,
    latestThreadForIdentity: async (id) => threads.filter((item) => item.identityId === id).at(-1) ?? null,
    activeThreads: async () => threads.filter((item) => item.sessionId),
    queueInbox: async (threadId, eventId, text, requestKey) => {
      if (inbox.some((item) => item.threadId === threadId && item.eventId === eventId)) return false;
      inbox.push({ threadId, eventId, text, requestKey, status: "PENDING" }); return true;
    },
    openInbox: async (threadId) => inbox.filter((item) => item.threadId === threadId && (item.status === "PENDING" || item.status === "SENT")) as never,
    markInbox: async (threadId, eventId, status) => { inbox.find((item) => item.threadId === threadId && item.eventId === eventId)!.status = status; },
    enqueue: async (input) => { if (outbox.some((item) => item.sourceKey === input.sourceKey)) return false; outbox.push({ ...input, identityId: input.identityId ?? null, outboxId: `channel_out:${++n}`, attempts: 0, status: "PENDING" }); return true; },
    due: async () => outbox.filter((item) => item.status === "PENDING"),
    delivered: async (id) => { outbox.find((item) => item.outboxId === id)!.status = "SENT"; },
    retry: async (id, error, max) => { const item = outbox.find((entry) => entry.outboxId === id)!; item.attempts += 1; item.error = error; if (item.attempts >= max) item.status = "FAILED"; },
    pruneEvents: async () => 0,
    dispose: async () => undefined
  };
  return { repo, codes, identities, threads, inbox, outbox };
}

type Run = { runId: string; status: string; responseMessageId: string; createdAt: string; errorMessage: string | null };
function fixture(options: { busy?: boolean; slack?: boolean } = {}) {
  const memory = memoryRepo();
  const runs = new Map<string, Run>();
  const messages = new Map<string, Array<{ messageId: string; content: string }>>();
  let sessions = 0;
  const slack = { post: vi.fn(async (_input: { channel: string; text: string; threadTs?: string | null }) => undefined), openDirect: vi.fn(async (user: string) => `D-${user}`) };
  const finishRun = (requestKey: string, content: string, status = "COMPLETED") => {
    const run = runs.get(requestKey)!; run.status = status;
    const sessionId = memory.threads[0]!.sessionId!;
    messages.set(sessionId, [...(messages.get(sessionId) ?? []), { messageId: run.responseMessageId, content }]);
  };
  const deps = {
    repo: memory.repo, slack: options.slack === false ? null : slack, teams: null,
    providers: [{ provider: "SLACK" as const, configured: true, reason: null }, { provider: "TEAMS" as const, configured: false, reason: "Not configured." }],
    store: {
      getSpaceAgentSession: vi.fn(async (sessionId: string) => ({ sessionId, isActive: true })),
      getLatestSpaceAgentRun: vi.fn(async () => [...runs.values()].at(-1) ?? null),
      getSpaceAgentSubmission: vi.fn(async (_pane: string, requestKey: string) => runs.get(requestKey) ?? null),
      listSpaceAgentMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? [])
    } as never,
    dots: { list: vi.fn(async () => dots) },
    pickRoom: vi.fn(async () => "room:1"),
    openPane: vi.fn(async (input: { title: string }) => ({ id: `pane:${sessions + 1}`, roomId: "room:1", title: input.title }) as Pane),
    startSession: vi.fn(async () => ({ sessionId: `session:${++sessions}` })),
    send: vi.fn(async (input: { content: string; requestKey: string }) => {
      if (options.busy) throw new SpaceConflictError("busy");
      runs.set(input.requestKey, { runId: `run:${runs.size + 1}`, status: "RUNNING", responseMessageId: `msg:${runs.size + 1}`, createdAt: new Date().toISOString(), errorMessage: null });
    }),
    pendingApprovals: vi.fn(async (_owner: string, _dot: string, _session: string) => [] as Array<{ invocationId: string; summary: string }>),
    goalFor: vi.fn(async (_owner: string, _dot: string, _session: string) => null as { goalId: string; status: string; statusReason: string | null; createdAt: string; updatedAt: string } | null),
    answerGoal: vi.fn(async () => undefined),
    appOrigin: "https://space.example",
    log: vi.fn()
  };
  return { service: createDotChannelService(deps), deps, memory, slack, runs, messages, finishRun };
}
const message = (extra: Partial<ChannelInboundMessage> = {}): ChannelInboundMessage => ({ provider: "SLACK", tenantId: "T1", eventId: `Ev${Math.random()}`,
  conversationId: "D1", threadKey: "direct", conversationKind: "DIRECT", externalUserId: "U1", replyAddress: "U1", displayName: "Maria", text: "hello", serviceUrl: null, ...extra });
async function linked(f: ReturnType<typeof fixture>, extra: Partial<ChannelInboundMessage> = {}) {
  const { code } = await f.service.linkCode("user:1");
  await f.service.handleInbound(message({ text: `link ${code}`, ...extra }));
  return code;
}
const group = { conversationKind: "GROUP" as const, conversationId: "C1", threadKey: "5.5" };

describe("Slack and Teams with Dots", () => {
  it("links only with a fresh code in a direct message, cancels codes typed in shared chats and never moves a linked account", async () => {
    const f = fixture();
    await f.service.handleInbound(message({ text: "hello" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/not linked to Space/) }));
    const exposed = (await f.service.linkCode("user:1")).code;
    await f.service.handleInbound(message({ text: `link ${exposed}`, ...group }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/cancelled that code/) }));
    await f.service.handleInbound(message({ text: `link ${exposed}`, externalUserId: "U-thief", replyAddress: "U-thief" }));
    expect(f.memory.identities).toHaveLength(0);
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/not valid or has expired/) }));
    const { code } = await f.service.linkCode("user:1");
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await f.service.handleInbound(message({ text: `link ${code.toLowerCase()}` }));
    expect(f.memory.identities).toMatchObject([{ ownerUserId: "user:1", externalUserId: "U1" }]);
    const other = (await f.service.linkCode("user:2")).code;
    await f.service.handleInbound(message({ text: `link ${other}` }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/already linked to another Space user/) }));
    expect(f.memory.identities[0]!.ownerUserId).toBe("user:1");
  });

  it("starts one Dot conversation per thread, ignores retries and keeps other people out of the owner's thread", async () => {
    const f = fixture();
    await linked(f);
    const first = message({ text: "Nova: plan the week", eventId: "Ev-1" });
    await Promise.all([f.service.handleInbound(first), f.service.handleInbound({ ...first, eventId: "Ev-1b", text: "and next week" })]);
    await f.service.handleInbound(first);
    expect(f.deps.openPane).toHaveBeenCalledTimes(1);
    expect(f.deps.openPane).toHaveBeenCalledWith({ owner: "user:1", roomId: "room:1", title: "Nova · Slack" });
    expect(f.memory.threads).toHaveLength(1);
    expect(f.deps.send).toHaveBeenCalledTimes(1);
    expect(f.deps.send).toHaveBeenCalledWith(expect.objectContaining({ content: "(Slack) plan the week", requestKey: expect.stringMatching(/^channel-[a-f0-9]{40}$/) }));
    expect(f.memory.inbox.map((item) => item.status)).toEqual(["SENT", "PENDING"]);
    await f.service.handleInbound(message({ text: "Orbit: switch", eventId: "Ev-2" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "This thread is with Nova. Start a new thread to talk to Orbit." }));
    f.memory.identities.push({ identityId: `channel_identity:${"9".repeat(32)}`, provider: "SLACK", tenantId: "T1", externalUserId: "U2", ownerUserId: "user:2",
      displayName: null, replyAddress: "U2", createdAt: new Date().toISOString() });
    await f.service.handleInbound(message({ text: "show me", externalUserId: "U2", replyAddress: "U2", eventId: "Ev-3" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/linked to someone else's Dot/) }));
  });

  it("answers in order, delivers every result even when two finish between sweeps, and only for requests made in the thread", async () => {
    const f = fixture();
    await linked(f);
    await f.service.handleInbound(message({ text: "first", eventId: "Ev-a" }));
    await f.service.handleInbound(message({ text: "second", eventId: "Ev-b" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Orbit is finishing something; your message is next." }));
    const [a, b] = f.memory.inbox;
    f.finishRun(a!.requestKey, "Answer one");
    await f.service.sweep();
    expect(b!.status).toBe("SENT");
    f.finishRun(b!.requestKey, "Answer two");
    // Work started in Space in the same pane is never posted to the channel.
    f.runs.set("space-ui-request", { runId: "run:ui", status: "COMPLETED", responseMessageId: "msg:ui", createdAt: new Date().toISOString(), errorMessage: null });
    await f.service.sweep();
    const posted = f.slack.post.mock.calls.map(([input]) => input.text);
    expect(posted).toEqual(expect.arrayContaining(["Orbit: Answer one", "Orbit: Answer two"]));
    expect(posted.indexOf("Orbit: Answer one")).toBeLessThan(posted.indexOf("Orbit: Answer two"));
    expect(f.memory.inbox.map((item) => item.status)).toEqual(["DELIVERED", "DELIVERED"]);
    expect(f.memory.outbox.some((item) => item.sourceKey === "result:run:ui")).toBe(false);
  });

  it("tells the user when a message cannot be taken for good, and when processing fails", async () => {
    const f = fixture();
    await linked(f);
    f.deps.send.mockRejectedValueOnce(new SpaceConflictError("Finish the pending request before sending."));
    await f.service.handleInbound(message({ text: "do it", eventId: "Ev-x" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Orbit could not take that message: Finish the pending request before sending." }));
    expect(f.memory.inbox[0]!.status).toBe("DROPPED");
    f.deps.pickRoom.mockRejectedValueOnce(new Error("database unavailable"));
    await f.service.handleInbound(message({ text: "Nova: hi", eventId: "Ev-y", threadKey: "7.7", conversationId: "D2" }));
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Something went wrong with that message. Please send it again." }));
  });

  it("returns results privately in shared conversations unless the owner says reply here", async () => {
    const f = fixture();
    await linked(f);
    await f.service.handleInbound(message({ text: "Orbit: summarize", ...group, eventId: "Ev-g" }));
    f.finishRun(f.memory.inbox[0]!.requestKey, "Here is the summary.");
    expect(await f.service.sweep()).toMatchObject({ queued: 2, delivered: 2 });
    expect(f.slack.post).toHaveBeenCalledWith({ channel: "D-U1", text: "Orbit: Here is the summary." });
    expect(f.slack.post).toHaveBeenCalledWith({ channel: "C1", threadTs: "5.5", text: "Orbit sent the answer to its owner directly." });
    expect(await f.service.sweep()).toMatchObject({ queued: 0, delivered: 0 });
    await f.service.handleInbound(message({ text: "reply here", ...group, eventId: "Ev-h" }));
    await f.service.handleInbound(message({ text: "Orbit: more", ...group, eventId: "Ev-i" }));
    f.finishRun(f.memory.inbox[1]!.requestKey, "Second.");
    await f.service.sweep();
    expect(f.slack.post).toHaveBeenLastCalledWith({ channel: "C1", threadTs: "5.5", text: "Orbit: Second." });
  });

  it("asks for approvals and Goal answers once, reports a finished Goal, and retries failed deliveries", async () => {
    const f = fixture();
    await linked(f);
    await f.service.handleInbound(message({ text: "Orbit: book it", eventId: "Ev-a" }));
    const created = new Date().toISOString();
    f.deps.pendingApprovals.mockResolvedValue([{ invocationId: "dot_tool:1", summary: "Send an email to a@b.c" }]);
    f.deps.goalFor.mockResolvedValue({ goalId: "dot_goal:1", status: "BLOCKED", statusReason: "Which city?", createdAt: created, updatedAt: created });
    f.slack.post.mockRejectedValueOnce(new Error("rate limited"));
    await f.service.sweep();
    expect(f.memory.outbox.map((item) => [item.kind, item.status])).toEqual([["APPROVAL", "PENDING"], ["QUESTION", "SENT"]]);
    expect(f.memory.outbox[0]!.body).toMatch(/waiting for your approval: Send an email to a@b.c\nApprove or decline it in Space. https:\/\/space.example/);
    await f.service.sweep();
    expect(f.memory.outbox.map((item) => item.status)).toEqual(["SENT", "SENT"]);
    await f.service.handleInbound(message({ text: "Athens", eventId: "Ev-b" }));
    expect(f.deps.answerGoal).toHaveBeenCalledWith("user:1", dots[0]!.dotId, "dot_goal:1", "Athens");
    f.deps.goalFor.mockResolvedValue({ goalId: "dot_goal:1", status: "COMPLETED", statusReason: null, createdAt: created, updatedAt: created });
    await f.service.sweep();
    expect(f.slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Orbit finished its Goal. The details are in Space. https://space.example" }));
  });

  it("never runs two sweeps at once", async () => {
    const f = fixture();
    await linked(f);
    await f.service.handleInbound(message({ text: "Orbit: hi", eventId: "Ev-s" }));
    let release!: () => void;
    f.deps.pendingApprovals.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const first = f.service.sweep();
    await vi.waitFor(() => expect(f.deps.pendingApprovals).toHaveBeenCalled());
    expect(await f.service.sweep()).toEqual({ queued: 0, delivered: 0 });
    release(); await first;
  });

  it("lets a Dot message its owner directly or post into its linked thread", async () => {
    const f = fixture();
    await linked(f);
    await f.service.handleInbound(message({ text: "Orbit: hi", eventId: "Ev-t" }));
    const sessionId = f.memory.threads[0]!.sessionId!;
    expect(await f.service.toolSend({ sessionId }, "user:1", "channel.slack.send", { text: "Done!" })).toMatchObject({ status: "COMPLETED", result: { where: "direct" } });
    expect(f.slack.post).toHaveBeenLastCalledWith({ channel: "D-U1", text: "Done!" });
    expect(await f.service.toolSend({ sessionId }, "user:1", "channel.slack.send", { text: "Thread", where: "thread" })).toMatchObject({ status: "COMPLETED" });
    expect(await f.service.toolSend({ sessionId: "other" }, "user:1", "channel.slack.send", { text: "x", where: "thread" })).toMatchObject({ status: "BLOCKED" });
    expect(await f.service.toolSend({ sessionId }, "user:2", "channel.slack.send", { text: "x" })).toMatchObject({ status: "BLOCKED" });
    expect(await f.service.toolSend({ sessionId }, "user:1", "channel.slack.send", { text: "" })).toMatchObject({ status: "BLOCKED" });
    expect(await f.service.available("user:1")).toEqual(["channel:slack"]);
  });
  it("sends a Dot's own message to its owner in Slack once, as plain text with Space's link, even without a thread", async () => {
    const f = fixture();
    const notice = { sourceKey: "dot-notice:dot:1:abc", dotName: "Orbit", content: "Your bill <is> due & <!channel> <https://evil.example|here>\n\nFrom: a@b.c",
      link: { label: "Open email", url: "https://mail.google.com/mail/?authuser=me%40gmail.com#all/m1" } };
    // Nothing is queued before the owner links Slack.
    expect(await f.service.notifyOwner("user:1", notice)).toBe(false);
    await linked(f);
    f.slack.post.mockClear();
    expect(await f.service.notifyOwner("user:1", notice)).toBe(true);
    expect(await f.service.notifyOwner("user:1", notice)).toBe(false);
    expect(f.memory.threads).toHaveLength(0);
    expect(f.memory.outbox).toMatchObject([{ threadId: null, identityId: f.memory.identities[0]!.identityId, kind: "NOTICE", target: "DIRECT" }]);
    await f.service.sweep();
    expect(f.slack.post).toHaveBeenCalledTimes(1);
    expect(f.slack.post).toHaveBeenLastCalledWith({ channel: "D-U1",
      text: "Orbit: Your bill &lt;is&gt; due &amp; &lt;!channel&gt; &lt;https://evil.example|here&gt;\n\nFrom: a@b.c\n<https://mail.google.com/mail/?authuser=me%40gmail.com#all/m1|Open email>" });
    expect(f.memory.outbox[0]!.status).toBe("SENT");
    // An account unlinked before delivery gets nothing; Space without a Slack app queues nothing.
    expect(await f.service.notifyOwner("user:1", { ...notice, sourceKey: "dot-notice:dot:1:def" })).toBe(true);
    f.memory.identities.splice(0, 1);
    await f.service.sweep();
    expect(f.memory.outbox[1]).toMatchObject({ status: "FAILED", error: "The account was unlinked." });
    const noApp = fixture({ slack: false });
    await linked(noApp);
    expect(await noApp.service.notifyOwner("user:1", notice)).toBe(false);
  });
});
