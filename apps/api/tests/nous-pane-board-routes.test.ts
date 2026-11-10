// Nous's pane board routes (plan clipboard:Y9cgKVHFaHrr): the board for ADMIN/OPERATOR only (a USER gets 403), Refresh from a
// person only, and one reply per pane: a CLI prompt through Nous's answer path (a critical prompt goes to Nous instead), a copilot
// question through the copilot as the operator, anything else as the operator's message to Nous with the pane's refs.
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { NousMessage, Pane, Room } from "@space/contracts";
import { InMemorySpaceStore, SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { ZodError } from "zod";
import { createApp } from "../src/app.js";
import { randomBytes } from "node:crypto";
import { createCsrfToken, signMobileSession, signSession, signSessionWithTtl } from "../src/auth.js";
import { MOBILE_INVOKE_HEADER, mobileInvokeSecret } from "../src/mobile/gate.js";
import { renderOperatorMessages } from "../src/nous/service.js";
import { registerNousPaneBoardRoutes, type PaneBoardRouteDeps } from "../src/nous/pane-board-routes.js";
import { parseBody, parseQuery } from "../src/route-parsing.js";
import { configureQueueOperatorGrants, takePaneQueueGrant } from "../src/queue-operator-grants.js";

const sessionSecret = "nous-board-secret-with-enough-length";
const headers = (id: string, role: "ADMIN" | "OPERATOR" | "USER" = "ADMIN") => {
  const user = { id, email: `${id.replace(/\W/g, "")}@space.local`, role };
  const session = id === "user:operator-proof" ? signSessionWithTtl(user, sessionSecret, 120) : signSession(user, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
};

describe("Nous pane board routes", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("holds the pane's promote grant for the operator's own reply asking to promote, never a proof session's or a mobile app's (2026-10-21, 2026-10-31)", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false }, nousRunner: async () => ({ text: "ok", isError: false }), paneBoardRunner: vi.fn(async () => "[]") });
    apps.push(app);
    configureQueueOperatorGrants(sessionSecret);
    const operator = headers("user:operator");
    await app.inject({ method: "GET", url: "/api/nous", headers: operator });
    const room = await store.createRoom({ name: "Clara", initialPaneCount: 0 }, undefined, "user:operator");
    const pane = await store.createPane({ roomId: room.id, title: "Cody", paneName: "Cody", mode: "TERMINAL" });
    const reply = (who: Record<string, string>, text: string) => app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: who, payload: { text } });
    expect((await reply(headers("user:operator-proof"), "κάνε promote")).statusCode).toBe(200);
    expect(takePaneQueueGrant(pane.id, "promote")).toBeNull();
    // A mobile app's device session is the operator, but a phone's "promote it" grants nothing (Nous Pro review P0-1, 2026-10-31).
    const appToken = signSession({ id: "user:operator", email: "useroperator@space.local", role: "ADMIN" }, sessionSecret, Date.now(), { app: "nous" });
    const phone = { cookie: `space_session=${appToken}`, "x-space-csrf-token": createCsrfToken(appToken, sessionSecret)! };
    expect((await reply(phone, "promote it")).json()).toMatchObject({ routed: "NOUS" });
    expect(takePaneQueueGrant(pane.id, "promote")).toBeNull();
    expect((await reply(operator, "κάνε promote")).json()).toMatchObject({ routed: "NOUS" });
    expect(takePaneQueueGrant(pane.id, "promote")).toEqual(expect.any(String));
  });

  it("a paired phone's answer to a prompt or copilot question goes to Nous, marked from the phone, and types nothing (Nous Pro 1b-4b, review P1-1/P1-3)", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false }, nousRunner: async () => ({ text: "ok", isError: false }), paneBoardRunner: vi.fn(async () => "[]") });
    apps.push(app);
    const operator = headers("user:operator");
    await app.inject({ method: "GET", url: "/api/nous", headers: operator });
    const room = await store.createRoom({ name: "Clara", initialPaneCount: 0 }, undefined, "user:operator");
    const pane = await store.createPane({ roomId: room.id, title: "Cody", paneName: "Cody", mode: "TERMINAL" });
    const token = signMobileSession({ id: "user:operator", email: "useroperator@space.local", role: "ADMIN" }, sessionSecret,
      { sid: randomBytes(32).toString("hex"), app: "nous", device: "appdev:phone0001", scopes: ["read", "act"] });
    const phone = { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, sessionSecret)!, [MOBILE_INVOKE_HEADER]: mobileInvokeSecret(app)! };
    const answer = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: phone, payload: { text: "yes", target: { kind: "PROMPT" } } });
    expect(answer.json()).toMatchObject({ routed: "NOUS", display: expect.stringContaining("types nothing") });
    const messages = (await app.inject({ method: "GET", url: "/api/nous/messages", headers: operator })).json().messages as Array<{ content: string; meta: Record<string, unknown> }>;
    const fromPhone = messages.find((message) => message.content.includes("My answer from my phone"));
    expect(fromPhone?.meta).toMatchObject({ person: true, mobile: { device: "appdev:phone0001", scopes: ["read", "act"] } });
    expect(renderOperatorMessages([fromPhone as unknown as NousMessage], "UTC")).toContain("(from a paired phone: the phone rule applies)");
    // A copilot question from the phone goes to Nous too.
    const copilot = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: phone,
      payload: { text: "go ahead", target: { kind: "COPILOT_QUESTION", copilot: "MAIL", questionId: "mailq:1" } } });
    expect(copilot.json()).toMatchObject({ routed: "NOUS" });
  });

  it("serves the operator's board by room and keeps USERs out", async () => {
    const store = new InMemorySpaceStore();
    const paneBoardRunner = vi.fn(async () => "[]");
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false }, nousRunner: async () => ({ text: "ok", isError: false }), paneBoardRunner });
    apps.push(app);
    const operator = headers("user:operator");
    await app.inject({ method: "GET", url: "/api/nous", headers: operator });
    const room = await store.createRoom({ name: "Board Room", initialPaneCount: 0 }, undefined, "user:operator");
    const pane = await store.createPane({ roomId: room.id, title: "Andy", paneName: "Andy", mode: "TERMINAL" });
    const board = await app.inject({ method: "GET", url: "/api/nous/pane-board", headers: operator });
    expect(board.statusCode).toBe(200);
    const view = board.json().board;
    // Nous is off: Space's own lines, no model call.
    expect(view.paused).toBe("NOUS_OFF");
    expect(view.settings).toEqual(expect.objectContaining({ model: "claude-haiku-5-5", language: "el" }));
    const row = view.rooms.find((entry: { roomId: string }) => entry.roomId === room.id);
    expect(row.panes).toEqual([expect.objectContaining({ paneId: pane.id, name: "Andy", summary: expect.objectContaining({ source: "FALLBACK" }) })]);
    // Nous is ADMIN/OPERATOR only: a USER session is refused (404 while multi-user accounts are off, 403 from Nous's own check).
    expect([403, 404]).toContain((await app.inject({ method: "GET", url: "/api/nous/pane-board", headers: headers("user:someone", "USER") })).statusCode);

    // A reply that is not a prompt or copilot answer reaches Nous as the operator's message, with the pane's refs.
    const sent = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: operator, payload: { text: "Συνέχισε με τα tests" } });
    expect(sent.json()).toEqual({ routed: "NOUS", display: "Sent to Nous about Andy." });
    const messages = (await app.inject({ method: "GET", url: "/api/nous/messages", headers: operator })).json().messages as NousMessage[];
    expect(messages[0]).toEqual(expect.objectContaining({ kind: "OPERATOR", content: "[Board Room · Andy] Συνέχισε με τα tests",
      meta: expect.objectContaining({ person: true, refs: { roomId: room.id, paneId: pane.id }, via: "PANE_BOARD" }) }));
    // Another owner's pane or a closed one is not found; a prompt answer to a pane with no CLI is a conflict, not a fallback.
    expect((await app.inject({ method: "POST", url: "/api/nous/pane-board/pane:missing0001/answer", headers: operator, payload: { text: "x" } })).statusCode).toBe(404);
    const noCli = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: operator, payload: { text: "1", target: { kind: "PROMPT" } } });
    expect(noCli.statusCode).toBe(409);
    // A proof session never answers a prompt or a copilot, and never spends a refresh.
    const proof = headers("user:operator-proof");
    expect((await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: proof, payload: { text: "1", target: { kind: "PROMPT" } } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/nous/pane-board/refresh", headers: proof, payload: {} })).statusCode).toBe(403);
    // The operator's Refresh runs the model even while Nous is off; an answer that is not the JSON asked for keeps the old lines.
    expect((await app.inject({ method: "POST", url: "/api/nous/pane-board/refresh", headers: operator, payload: {} })).statusCode).toBe(202);
    await vi.waitFor(() => expect(paneBoardRunner).toHaveBeenCalledTimes(1));
  });

  it("routes a critical prompt's answer to Nous and a copilot answer through the copilot as the operator", async () => {
    const room = { id: "room:alpha0001", name: "Alpha" } as Room;
    const pane = { id: "pane:andy0001", paneName: "Andy", title: "Andy", roomId: room.id } as Pane;
    const deps = {
      answerPrompt: vi.fn<PaneBoardRouteDeps["answerPrompt"]>(async () => ({ ok: false, refused: true, display: "Left Andy's prompt to the operator", result: "Andy's prompt touches a promote." })),
      answerCopilot: vi.fn<PaneBoardRouteDeps["answerCopilot"]>(async () => "Answered; the copilot continues with it."),
      send: vi.fn<PaneBoardRouteDeps["send"]>(async () => ({}) as NousMessage)
    };
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SpaceNotFoundError ? 404 : error instanceof SpaceConflictError ? 409 : error instanceof ZodError ? 422 : 500).send({ error: error.message }));
    registerNousPaneBoardRoutes(app, { routeOptions: {}, owner: async () => "user:operator", assertPerson: () => undefined, parseBody, parseQuery,
      board: { board: vi.fn(), tick: vi.fn(async () => ({ called: false, summarized: 0, paused: null })) },
      pane: async (_owner, paneId) => paneId === pane.id ? { room, pane } : null, ...deps });

    const critical = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, payload: { text: "1", target: { kind: "PROMPT" } } });
    expect(critical.json()).toEqual({ routed: "NOUS", display: "Sent to Nous: Andy's prompt needs its check first." });
    expect(deps.send).toHaveBeenCalledWith("user:operator", expect.stringMatching(/^\[Alpha · Andy\] My answer to this pane's prompt: 1\n\(Space did not type it: Andy's prompt touches a promote\.\)$/),
      { person: true, refs: { roomId: room.id, paneId: pane.id }, client: { app: "UNKNOWN" } });

    deps.answerPrompt.mockResolvedValueOnce({ ok: true, display: "Answered Andy", result: "ok" });
    expect((await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, payload: { text: "2", target: { kind: "PROMPT" } } })).json())
      .toEqual({ routed: "PROMPT", display: "Answered Andy" });

    const copilot = await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, payload: { text: "Yes, Greek", target: { kind: "COPILOT_QUESTION", copilot: "MAIL", questionId: "q1" } } });
    expect(copilot.json()).toEqual({ routed: "COPILOT_QUESTION", display: "Answered; the copilot continues with it." });
    expect(deps.answerCopilot).toHaveBeenCalledWith("user:operator", { copilot: "MAIL", questionId: "q1", paneId: pane.id, answer: "Yes, Greek" });
    expect((await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, payload: { text: "x", target: { kind: "COPILOT_QUESTION", copilot: "NOPE", questionId: "q1" } } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, payload: { text: "   " } })).statusCode).toBe(422);
  });
});
