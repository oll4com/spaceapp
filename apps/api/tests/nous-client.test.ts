// Where the operator writes to Nous from (operator 31/10 16:22 BKK, plan clipboard:4TXfIZzj8ITW): every operator message stores
// meta.client from the session's app claim, the UA and the X-Space-Client header, and the turn names it per message and in
// "# Where the operator is".
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { NOUS_APP_MIN_VERSION, type NousMessage } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { renderOperatorMessages, renderOperatorWhere } from "../src/nous/service.js";

const sessionSecret = "nous-client-secret-with-enough-length";
const operator = { id: "user:operator", email: "useroperator@space.local", role: "ADMIN" as const };
const cookie = (app?: string) => {
  const token = signSession(operator, sessionSecret, Date.now(), app ? { app } : {});
  return { cookie: `space_session=${token}`, "x-space-csrf-token": createCsrfToken(token, sessionSecret)! };
};
const message = (content: string, createdAt: string, client?: unknown): NousMessage =>
  ({ id: `nous_msg:${createdAt}`, ownerUserId: operator.id, turnId: null, kind: "OPERATOR", status: "DONE", content, meta: client ? { client } : {}, createdAt }) as NousMessage;

describe("Nous knows where the operator writes from", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("stores the client on the dock's and the pane board's messages and names it in the turn", async () => {
    const store = new InMemorySpaceStore();
    const prompts: string[] = [];
    const app = await createApp({ store, auth: { sessionSecret, devLogin: false, secureCookies: false },
      nousRunner: vi.fn(async (input: { prompt: string }) => { prompts.push(input.prompt); return { text: "ok", isError: false }; }), paneBoardRunner: vi.fn(async () => "[]") });
    apps.push(app);
    await app.inject({ method: "GET", url: "/api/nous", headers: cookie() });
    const send = (headers: Record<string, string>, content: string) => app.inject({ method: "POST", url: "/api/nous/messages", headers, payload: { content } });
    // The Nous app: okhttp says nothing, the device session's claim does; the header adds version, form and view.
    // An app below the update floor (CODE-2) is refused before Nous sees it; the current one goes through.
    const old = await send({ ...cookie("nous"), "user-agent": "okhttp/4.12.0", "x-space-client": "v=0.2.10; form=PHONE; view=requests" }, "Παλιά έκδοση");
    expect(old.statusCode).toBe(426);
    expect(old.json().error).toMatchObject({ code: "APP_UPDATE_REQUIRED", details: { minVersion: NOUS_APP_MIN_VERSION } });
    expect((await send({ ...cookie("nous"), "user-agent": "okhttp/4.12.0", "x-space-client": `v=${NOUS_APP_MIN_VERSION}; form=PHONE; view=requests` }, "Από το κινητό")).statusCode).toBe(202);
    // The Windows desktop app strips Electron from its UA; the web app's header names it.
    expect((await send({ ...cookie(), "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36",
      "x-space-client": "app=DESKTOP_WINDOWS; v=0.1.30; view=nous:chat; vp=1920x1080" }, "Από τον υπολογιστή")).statusCode).toBe(202);
    const room = await store.createRoom({ name: "Clara", initialPaneCount: 0 }, undefined, operator.id);
    const pane = await store.createPane({ roomId: room.id, title: "Cody", paneName: "Cody", mode: "TERMINAL" });
    await app.inject({ method: "POST", url: `/api/nous/pane-board/${pane.id}/answer`, headers: { ...cookie(), "user-agent": "Mozilla/5.0 (Linux; Android 17; SM-S938B; wv) AppleWebKit/537.36 Version/4.0 Chrome/155.0 Mobile Safari/537.36" },
      payload: { text: "Συνέχισε" } });
    const listed = (await app.inject({ method: "GET", url: "/api/nous/messages", headers: cookie() })).json().messages as NousMessage[];
    const clients = listed.filter((entry) => entry.kind === "OPERATOR").map((entry) => entry.meta.client);
    expect(clients).toEqual(expect.arrayContaining([
      { app: "NOUS_ANDROID", os: "ANDROID", form: "PHONE", version: NOUS_APP_MIN_VERSION, view: "requests" },
      { app: "DESKTOP_WINDOWS", os: "WINDOWS", form: "DESKTOP", version: "0.1.30", view: "nous:chat", viewport: "1920x1080" },
      { app: "SPACEAPP_ANDROID", os: "ANDROID", form: "PHONE" }]));
    await vi.waitFor(() => expect(prompts.some((prompt) => prompt.includes(`(from the Nous app ${NOUS_APP_MIN_VERSION} on an Android phone, view requests): Από το κινητό`))).toBe(true));
    expect(prompts.join("\n")).toContain("# Where the operator is");
  });

  it("names each waiting message's client and fits the latest", () => {
    const at = Date.parse("2026-10-31T09:30:00Z");
    const messages = [message("old, no client", "2026-10-31T09:00:00.000Z"),
      message("from the phone", "2026-10-31T09:27:00.000Z", { app: "NOUS_ANDROID", os: "ANDROID", form: "PHONE", version: "0.2.10" })];
    const text = renderOperatorMessages(messages, "Asia/Bangkok");
    expect(text).toContain(": old, no client");
    expect(text).toContain("(from the Nous app 0.2.10 on an Android phone): from the phone");
    expect(renderOperatorWhere(messages, at)).toBe("# Where the operator is\nThe operator last wrote 3 min ago from the Nous app 0.2.10 on an Android phone. "
      + "Fit your answer, cards and needs-you items to a phone: tappable links and phone steps; mark anything that needs a computer \"From a computer: …\".");
    expect(renderOperatorWhere([message("x", "2026-10-31T09:00:00.000Z")], at)).toBe("");
  });
});
