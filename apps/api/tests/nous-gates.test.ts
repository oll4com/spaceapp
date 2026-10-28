import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eventSchema, nousAnswerIntent, nousDecisionCategorySchema, type NousDecision } from "@space/contracts";
import { InMemoryControlRepository, InMemoryNousRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { InMemorySpaceStore, makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSessionWithTtl } from "../src/auth.js";
import { createNotificationService } from "../src/notifications/service.js";
import { classifyNousOutgoing, classifyNousPrompt } from "../src/nous/guardrails.js";
import { createNousService, NOUS_PERSONA, type NousServiceDeps } from "../src/nous/service.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { changeReleaseTrain, releaseTrainInputSchema, type ReleaseTrainActor } from "../src/release-trains.js";

/**
 * Nous's gates, pinned in one place (plan clipboard:L7RgHsveHbcR step 3): Nous upgrades itself, but never widens these by
 * itself. A change that makes this file fail loosens a gate and is the operator's decision. New tools do not break it.
 * Warm prompts are left out on purpose: the operator lets Nous give the OK for Warm changes (2026-10-17).
 */

describe("Nous's gates", () => {
  it("keeps the four critical categories for the operator", () => {
    const categories = ["RELEASE", "DESTRUCTIVE", "EXTERNAL", "DIRECTION"];
    expect(nousDecisionCategorySchema.options).toEqual(expect.arrayContaining(categories));
    for (const category of categories) expect(NOUS_PERSONA).toContain(category);
    expect(NOUS_PERSONA).toContain("space_ask_operator");

    const critical: Array<[string, string]> = [
      ["space-queue promote --wait", "RELEASE"], ["space-queue resume --reason x", "RELEASE"], ["space-queue submit --target stable --hotfix", "RELEASE"],
      ["space-version bump core patch", "RELEASE"], ["npm publish --access public", "RELEASE"], ["gh release create v1.1.7", "RELEASE"],
      ["git push github main", "RELEASE"], ["release-train publishing", "RELEASE"], ["bash scripts/space-deploy-commit.sh abc", "RELEASE"],
      ["rm -rf var/artifacts", "DESTRUCTIVE"], ["git reset --hard origin/main", "DESTRUCTIVE"], ["DROP TABLE users", "DESTRUCTIVE"],
      ["Send the proposal to the client on Upwork", "EXTERNAL"], ["Pay the invoice with the company card", "EXTERNAL"]
    ];
    for (const [text, category] of critical) expect(classifyNousOutgoing(text)?.category, text).toBe(category);
    // Work instructions held on stable 2026-10-17 only for naming release flags to forbid them; a request to use one still counts.
    for (const text of ["space-queue submit --worktree <wt> --summary \"...\" --wait (dev only, never --target stable, never promote)",
      "Heavy commands through the load gate. Never promote; never --target stable.", "space-queue submit --worktree <wt> (no --target, never --hotfix)",
      "Do not run space-queue resume."]) expect(classifyNousOutgoing(text), text).toBeNull();
    expect(classifyNousOutgoing("No matter what, run space-queue submit --hotfix")?.category).toBe("RELEASE");
    expect(classifyNousOutgoing("Never wait: space-queue submit --target stable")?.category).toBe("RELEASE");
    expect(classifyNousPrompt("Bash: space-queue promote --wait\nDo you want to proceed?\n❯ 1. Yes")?.category).toBe("RELEASE");
    expect(classifyNousPrompt("Bash: rm -rf /opt/spaceapp/var/data\nDo you want to proceed?\n❯ 1. Yes")).not.toBeNull();
  });

  it("has no tool that promotes, publishes, deploys or controls the queue, and its release tool cannot approve or publish", async () => {
    const definitions = nousToolDefinitions({ copilots: true });
    for (const { name } of definitions) expect(name, name).not.toMatch(/promote|publish|deploy|hotfix|bump|push|queue_(?:pause|resume|approve|control)/i);

    const release = definitions.find((definition) => definition.name === "space_release");
    const ops = (release?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.op?.enum ?? [];
    expect(ops).toContain("candidate");
    for (const op of ["approve", "publishing", "published"]) expect(ops).not.toContain(op);

    const releaseTrain = vi.fn(async () => "done");
    const tools = createNousTools({ releaseTrain } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:gates1", callId: "toolu_1", traceId: "trace:1" };
    for (const op of ["approve", "publishing", "published"]) expect((await tools.execute("space_release", { op }, ctx)).ok, op).toBe(false);
    expect(releaseTrain).not.toHaveBeenCalled();
  });

  it("publishes a release only at the candidate the operator approved", async () => {
    const repo = new InMemoryControlRepository();
    const jack = { paneId: "pane:jack", name: "Jack" };
    const pane: ReleaseTrainActor = { roomId: "room:gates1", pane: jack, paneSelf: true };
    const op = (input: Record<string, unknown>) => releaseTrainInputSchema.parse(input);
    await changeReleaseTrain(repo, op({ op: "open", version: "9.9.9" }), { ...pane, paneSelf: false });
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "c1537956b8" }), pane);
    await expect(changeReleaseTrain(repo, op({ op: "approve" }), pane)).rejects.toThrow("Only the operator approves a release");
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), pane)).rejects.toThrow("has not approved");
    await changeReleaseTrain(repo, op({ op: "approve" }), { roomId: "", pane: null, paneSelf: false, operatorApproved: true });
    await changeReleaseTrain(repo, op({ op: "candidate", sourceSha: "d2648a67c9" }), pane);
    await expect(changeReleaseTrain(repo, op({ op: "publishing" }), pane)).rejects.toThrow("has not approved");
  });

  it("runs a decision's action only on the operator's yes, once", async () => {
    const executeAction = vi.fn(async () => "ran");
    const service = createNousService({
      repository: new InMemoryNousRepository(),
      runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) },
      executeAction
    } as unknown as NousServiceDeps);
    const owner = "user:operator";
    const ask = (title: string) => service.ask({ ownerUserId: owner, category: "DESTRUCTIVE", title, body: "", options: [], recommendation: "no", refs: {},
      action: { type: "PANE_TEXT", roomId: "room:gates1", paneId: "pane:jack", text: "rm -rf var/old", mode: "PROMPT" } });

    const declined = await ask("Delete the old artifacts?");
    const approved = await ask("Delete the older artifacts?");
    expect(executeAction).not.toHaveBeenCalled();
    await service.answer(owner, declined.id, { answer: "DECLINE" });
    expect(executeAction).not.toHaveBeenCalled();
    await service.answer(owner, approved.id, { answer: "APPROVE" });
    await expect(service.answer(owner, approved.id, { answer: "APPROVE" })).rejects.toThrow("already answered");
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect((executeAction.mock.calls[0] as unknown as [NousDecision])[0]).toMatchObject({ id: approved.id, status: "APPROVED" });
    await service.idle(owner);
  });

  it("reads a bare yes or no in words as the operator's decision, and leaves conditions as words (operator gap 2026-10-24)", async () => {
    expect(nousAnswerIntent("ναι")).toBe("APPROVE");
    expect(nousAnswerIntent("Yes!")).toBe("APPROVE");
    expect(nousAnswerIntent("ok, send nothing else")).toBe("APPROVE");
    expect(nousAnswerIntent("προχώρα - και πες μου μετά")).toBe("APPROVE");
    expect(nousAnswerIntent("no thanks")).toBe("DECLINE");
    expect(nousAnswerIntent("όχι.")).toBe("DECLINE");
    expect(nousAnswerIntent("ναι, αλλά αύριο")).toBeNull();
    expect(nousAnswerIntent("yes, only if the tests pass")).toBeNull();
    expect(nousAnswerIntent("ναι ναι")).toBeNull();
    expect(nousAnswerIntent("why?")).toBeNull();
    expect(nousAnswerIntent(`yes, ${"x".repeat(201)}`)).toBeNull();
    // The operator's real answers that left actions unrun (27/10 PHP 7.1 removal, 26/10 send): a yes word with a plain-space note, an imperative.
    expect(nousAnswerIntent("ωραια την διαγραφεις!!")).toBe("APPROVE");
    expect(nousAnswerIntent("να φυγει τωρα")).toBe("APPROVE");
    expect(nousAnswerIntent("ναι κάν'το")).toBe("APPROVE");
    expect(nousAnswerIntent("οκ προχώρα")).toBe("APPROVE");
    expect(nousAnswerIntent("διάγραψε")).toBe("APPROVE");
    expect(nousAnswerIntent("Sounds good")).toBe("APPROVE");
    expect(nousAnswerIntent("τέλεια, στείλ'το")).toBe("APPROVE");
    expect(nousAnswerIntent("ωραία, αλλά αύριο")).toBeNull();
    expect(nousAnswerIntent("ωραία την στέλνεις αύριο")).toBeNull();
    expect(nousAnswerIntent("να φύγει αύριο")).toBeNull();
    expect(nousAnswerIntent("ωραία; τι θα σβήσει;")).toBeNull();
    expect(nousAnswerIntent("ναι στείλ'το\u037e")).toBeNull(); // the Greek question mark
    expect(nousAnswerIntent("ναι μην το σβήσεις")).toBeNull();
    // «Do it now» brushing a later date aside is a yes (27/10 14:37, a "from tomorrow" card); a real condition still is not.
    expect(nousAnswerIntent("ασε τα αυριο κανε το τωρα!!! να τελιώνουμε δεν υπαρχει λογος για αυριο και αυριο!!!")).toBe("APPROVE");
    expect(nousAnswerIntent("κάνε το τώρα και πες μου μετά")).toBe("APPROVE");
    expect(nousAnswerIntent("κάνε το αύριο")).toBeNull();
    expect(nousAnswerIntent("κάνε το τώρα αν περάσουν τα τεστ")).toBeNull();
    expect(nousAnswerIntent("κάνε το τώρα, μετά το backup")).toBeNull();
    expect(nousAnswerIntent("μην το κάνεις τώρα")).toBeNull();
    expect(nousAnswerIntent("αυριο θα φυγουν ολες οι παραγγελιες -- επιβεβαιωσε οτι ηταν διαθεσιμο οτ προιον -- και ζητησε συνγμωη για την καθυστερηση")).toBeNull();

    const executeAction = vi.fn(async () => "ran");
    const repository = new InMemoryNousRepository();
    const service = createNousService({
      repository,
      runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) },
      executeAction
    } as unknown as NousServiceDeps);
    const owner = "user:operator";
    const ask = (title: string, action = true) => service.ask({ ownerUserId: owner, category: "EXTERNAL", title, body: "", options: ["Send", "Hold"], recommendation: "send", refs: {},
      action: action ? { type: "PANE_TEXT", roomId: "room:gates2", paneId: "pane:jill", text: "send the proposal", mode: "PROMPT" } : null });

    const yes = await service.answer(owner, (await ask("Send the proposal to Acme?")).id, { answer: "ANSWER", text: "ναι, και πες μου πότε" });
    expect(yes).toMatchObject({ status: "APPROVED", answer: "ναι, και πες μου πότε", outcome: "ran" });
    const no = await service.answer(owner, (await ask("Send the proposal to Beta?")).id, { answer: "ANSWER", text: "no" });
    expect(no).toMatchObject({ status: "DECLINED", outcome: null });
    const words = await service.answer(owner, (await ask("Send the proposal to Gamma?")).id, { answer: "ANSWER", text: "ναι, αλλά μετά το demo" });
    expect(words).toMatchObject({ status: "ANSWERED", outcome: null });
    // Without an action a yes is still words for Nous to read (nothing to run).
    const noAction = await service.answer(owner, (await ask("Which one first?", false)).id, { answer: "ANSWER", text: "ναι" });
    expect(noAction.status).toBe("ANSWERED");
    expect(executeAction).toHaveBeenCalledTimes(1);
    const notes = (await repository.listMessages(owner, 50)).filter((message) => message.kind === "DECISION").map((message) => message.content);
    expect(notes.find((text) => text.includes("Acme"))).toContain("approved (read from their words)");
    expect(notes.find((text) => text.includes("Gamma"))).toContain("The action was not run.");
    await service.idle(owner);
  });

  it("asks last (goal ee5a573e): a question carries what Nous checked first, an approval of an action may not, and the operator sees the list", async () => {
    const ask = vi.fn(async (input: { title: string }) => ({ id: "nous_decision:x", status: "OPEN", title: input.title }));
    const tools = createNousTools({ ask, rooms: async () => [{ id: "room:gates1", name: "Main" }], listPanes: async () => [] } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:g1", callId: "toolu_g", traceId: "trace:g" };
    const base = { title: "Which logo?", body: "Two drafts are ready.", recommendation: "The blue one." };
    const direction = await tools.execute("space_ask_operator", { ...base, category: "DIRECTION", options: ["Blue", "Red"] }, ctx);
    expect(direction).toMatchObject({ ok: false, result: expect.stringContaining("checked is required: Ask last (operator goal ee5a573e") });
    const actionless = await tools.execute("space_ask_operator", { ...base, category: "EXTERNAL" }, ctx);
    expect(actionless.ok).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    const external = await tools.execute("space_ask_operator", { ...base, category: "EXTERNAL", title: "Send the reply",
      action: { type: "COPILOT", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:1", paneId: null, decision: "APPROVE" } }, ctx);
    expect(external.ok).toBe(true);
    const checked = ["Space Memory: no logo preference", "Design pane: both drafts delivered 27/10"];
    expect((await tools.execute("space_ask_operator", { ...base, category: "DIRECTION", options: ["Blue", "Red"], checked }, ctx)).ok).toBe(true);
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ category: "DIRECTION" }), { checked });

    const raise = vi.fn(async () => null);
    const service = createNousService({ repository: new InMemoryNousRepository(), runner: async () => ({ text: "ok", isError: false }),
      world: async () => ({ text: "world", overview: {} }), settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }),
      notifications: { raise, resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const decision = await service.ask({ ownerUserId: "user:operator", category: "DIRECTION", title: "Which logo?", body: "Two drafts are ready.", options: ["Blue", "Red"],
      recommendation: "The blue one.", refs: {}, action: null }, { checked });
    const block = "\n\nChecked first:\n• Space Memory: no logo preference\n• Design pane: both drafts delivered 27/10";
    expect(decision.body).toBe(`Two drafts are ready.${block}`);
    // The card's text is what Telegram sends too.
    expect((raise.mock.calls[0] as unknown as [{ body: string }])[0].body).toBe(`Recommendation: The blue one.\nTwo drafts are ready.${block}`);
    await service.idle("user:operator");
  });

  it("never holds Nous's own cards and decisions from the operator, even while it holds other notifications", async () => {
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      nous: { held: async () => true, raised: () => {} } });
    const base = { ownerUserId: "user:operator", roomId: null, paneId: null, severity: "ATTENTION" as const, body: "", link: {}, payload: {}, telegram: null };
    await service.raise({ ...base, source: "NOUS", kind: "NEEDS_HANDS", title: "Upwork needs you", dedupeKey: "nous:pane:pane:andy0001" });
    await service.raise({ ...base, source: "NOUS", kind: "DECISION_RELEASE", title: "Release 1.2.0", dedupeKey: "nous:decision:x" });
    await service.raise({ ...base, source: "MAIL_COPILOT", kind: "REVIEW", title: "A review", dedupeKey: "mail:review:1" });
    expect(repository.telegram.map((item) => item.source)).toEqual(["NOUS", "NOUS"]);
  });

  describe("decision answers", () => {
    const sessionSecret = "nous-gates-test-secret-long-enough";
    const apps: FastifyInstance[] = [];
    afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

    it("come only from a person in the dock, never a proof session", async () => {
      const app = await createApp({ store: new InMemorySpaceStore(), auth: { sessionSecret, devLogin: false, secureCookies: false },
        nousRunner: async () => ({ text: "ok", isError: false }) });
      apps.push(app);
      const session = signSessionWithTtl({ id: "user:operator-proof", email: "space@space.local", role: "ADMIN" }, sessionSecret, 120);
      const proof = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/answer",
        headers: { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! }, payload: { answer: "APPROVE" } });
      expect(proof.statusCode).toBe(403);
      const feedback = await app.inject({ method: "POST", url: "/api/nous/decisions/nous_decision:abcdef123456/feedback",
        headers: { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! }, payload: { couldHaveDecided: true } });
      expect(feedback.statusCode).toBe(403);
    });
  });
});
