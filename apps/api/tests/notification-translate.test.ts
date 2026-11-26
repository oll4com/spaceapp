import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { eventSchema, needsYouCardTexts, needsYouMailTranslation, needsYouTranslation, type UiLanguage } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createCardTranslator, foreignLanguage, translateCard, translateMail } from "../src/notifications/translate.js";

const GREEK: Record<string, string> = {
  "Approve data delete on qm:207?": "Έγκριση διαγραφής δεδομένων στο qm:207;", "Monitoring Copilot needs you": "Το Monitoring Copilot σε χρειάζεται",
  "The backup at /var/backups/vzdump-qemu-207.vma.zst is 40 GB.": "Το αντίγραφο στο /var/backups/vzdump-qemu-207.vma.zst είναι 40 GB.",
  "Disk usage at 91 %": "Χρήση δίσκου 91 %", "Approve": "Έγκριση", "Decline": "Απόρριψη", "": ""
};

// Operator 1/11 23:09 BKK «needs you να ειναι στην γλώσσα που εχω ορισει»: a card is translated once when raised, the original kept.
describe("needs-you cards in the operator's language", () => {
  it("goal 7365014c: Space's own start-now words read as Nous asked them, whatever the model wrote", async () => {
    const record = { title: "Andy needs you", body: "Sign at https://a.test", payload: { ask: { question: "Start now?", options: ["Go now", "Later today"], answer: { kind: "PANE" } } } };
    const out = await translateCard(async (texts) => texts.map((text) => text && `EL:${text}`), record, "el");
    expect(out).toMatchObject({ question: "Ξεκινάς τώρα;", options: ["Πάμε τώρα", "Αργότερα σήμερα"], body: "EL:Sign at https://a.test" });
  });

  const card = (body = "The backup at /var/backups/vzdump-qemu-207.vma.zst is 40 GB.\n\nChecked first:\nDisk usage at 91 %") => ({
    ownerUserId: "user:1", roomId: "room:1", paneId: "pane:1", source: "MONITORING_COPILOT" as const, kind: "MONITORING_REVIEW", severity: "ATTENTION" as const,
    title: "Monitoring Copilot needs you", body, link: { roomId: "room:1", paneId: "pane:1" }, dedupeKey: "monitoring:review:1", telegram: false,
    payload: { ask: { question: "Approve data delete on qm:207?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION" as const, copilot: "MONITORING", item: "REVIEW" as const, itemId: "monrev:1" } } }
  });
  const setup = (language: UiLanguage | undefined) => {
    const repository = new InMemorySpaceNotificationsRepository();
    const translate = vi.fn(async (texts: string[]) => texts.map((text) => GREEK[text] ?? `EL:${text}`));
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), translate,
      userSettings: async () => ({ notifications: null, ...(language ? { uiLanguage: language } : {}) }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    return { repository, translate, service };
  };

  it("adds the Greek text beside the original, the checked header left for the dock's fold, and reuses it for the same card", async () => {
    const { service, translate } = setup("el");
    const raised = await service.raise(card());
    await vi.waitFor(async () => expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")).not.toBeNull());
    const record = (await service.get("user:1", raised.id))!;
    // OBS-006: the translator names the card, which Space Gateway's request log rows then carry.
    expect((translate.mock.calls[0] as unknown[])[2]).toBe(raised.id);
    expect(record.title).toBe("Monitoring Copilot needs you");
    expect(needsYouTranslation(record, "el")).toMatchObject({ title: "Το Monitoring Copilot σε χρειάζεται", question: "Έγκριση διαγραφής δεδομένων στο qm:207;",
      options: ["Έγκριση", "Απόρριψη"], body: "Το αντίγραφο στο /var/backups/vzdump-qemu-207.vma.zst είναι 40 GB.\n\nChecked first:\nΧρήση δίσκου 91 %" });
    // The same card raised again (its payload replaced) takes the kept translation, no second model call.
    await service.raise(card());
    await vi.waitFor(async () => expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")).not.toBeNull());
    expect(translate).toHaveBeenCalledTimes(1);
    // A changed text is not shown with the old translation.
    const changed = await service.raise(card("The backup is 41 GB now."));
    expect(needsYouTranslation(changed, "el")).toBeNull();
  });

  it("translates a card raised before the operator chose Greek when Needs you is read, once however often it is read", async () => {
    let language: UiLanguage | undefined;
    const repository = new InMemorySpaceNotificationsRepository();
    const translate = vi.fn(async (texts: string[]) => { await new Promise((resolve) => setTimeout(resolve, 10)); return texts.map((text) => GREEK[text] ?? `EL:${text}`); });
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), translate,
      userSettings: async () => ({ notifications: null, ...(language ? { uiLanguage: language } : {}) }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const raised = await service.raise(card());
    expect(translate).not.toHaveBeenCalled();
    language = "el";
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await vi.waitFor(async () => expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")?.question).toBe("Έγκριση διαγραφής δεδομένων στο qm:207;"));
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("makes a translation an older translator kept again once on read, showing it meanwhile (stable 1/11: campaign card ab76acad)", async () => {
    const { service, translate } = setup("el");
    const base = card();
    const old = { language: "el", from: needsYouCardTexts(base as never).from, title: "Monitoring Copilot σε χρειάζεται",
      body: "The backup is 40 GB.", question: "Approve data delete on qm:207;", options: ["Approve", "Decline"] };
    const raised = await service.raise({ ...base, payload: { ...base.payload, translated: old } });
    expect(needsYouTranslation(raised, "el")?.title).toBe("Monitoring Copilot σε χρειάζεται");
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await vi.waitFor(async () => expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")).toMatchObject({ version: 3, title: "Το Monitoring Copilot σε χρειάζεται" }));
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("logs why an older translation could not be made again and waits 10 minutes before the next try, the old text showing meanwhile", async () => {
    const repository = new InMemorySpaceNotificationsRepository();
    let at = Date.parse("2026-11-01T22:51:53.000Z");
    const translate = vi.fn(async () => { throw new Error("The card translator left out texts 4 of 5, twice."); });
    const warn = vi.fn();
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), translate, now: () => new Date(at).toISOString(), log: { warn } as never,
      userSettings: async () => ({ notifications: null, uiLanguage: "el" }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    const base = card();
    const old = { language: "el", from: needsYouCardTexts(base as never).from, title: "Monitoring Copilot σε χρειάζεται",
      body: "The backup is 40 GB.", question: "Approve data delete on qm:207;", options: ["Approve", "Decline"] };
    const raised = await service.raise({ ...base, payload: { ...base.payload, translated: old } });
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.objectContaining({ notificationId: raised.id, err: expect.objectContaining({ message: expect.stringContaining("left out texts 4 of 5") }) }), "Notification translation failed."));
    at += 3 * 60_000;
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translate).toHaveBeenCalledTimes(1);
    expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")?.title).toBe("Monitoring Copilot σε χρειάζεται");
    at += 8 * 60_000;
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
  });

  it("translates on a Needs you read from a browser that lists Greek first while the language is unset (nous_msg:40900116)", async () => {
    const { service, translate } = setup(undefined);
    const raised = await service.raise(card());
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 }, ["en-US", "el"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translate).not.toHaveBeenCalled();
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 }, ["el-GR", "en"]);
    await vi.waitFor(async () => expect(needsYouTranslation((await service.get("user:1", raised.id))!, "el")).not.toBeNull());
  });

  it("translates nothing in English, nothing already Greek and nothing that needs no one", async () => {
    const english = setup(undefined);
    await english.service.raise(card());
    const greek = setup("el");
    await greek.service.raise({ ...card("Το αντίγραφο είναι 40 GB."), title: "Χρειάζεσαι", payload: { ask: { question: "Να διαγραφεί;", answer: { kind: "NOUS" as const } } } });
    await greek.service.raise({ ...card(), kind: "MAIL_RECEIVED", severity: "INFO", dedupeKey: "mail:1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(english.translate).not.toHaveBeenCalled();
    expect(greek.translate).not.toHaveBeenCalled();
  });

  it("asks the gateway with the texts keyed by place, empty ones left out, asks a left-out text once more, and says why an answer is unusable", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const texts = JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as Record<string, string>;
      return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, `EL ${text}`])))}\n\`\`\`` } }] }));
    });
    const keyFile = join(await mkdtemp(join(tmpdir(), "space-card-translate-")), "gateway.key");
    await writeFile(keyFile, "sk-test\n", "utf8");
    const translate = createCardTranslator({ baseUrl: "http://127.0.0.1:4920/v1", keyFile, fetchImpl: fetchImpl as never });
    // A card with no "Checked first" (a Mail campaign review, e12d2047 on 1/11) sends no empty string the model could drop, and its keys run without
    // a gap the model could close (12/11 public-host reboot card: given 0,1,3,4,5 it renumbered them; the question read «Έγκριση», both options «Απόρριψη»).
    expect(await translate(["Approve the campaign", "Read every mail", "", "Approve", "Decline"], "el")).toEqual(["EL Approve the campaign", "EL Read every mail", "", "EL Approve", "EL Decline"]);
    expect(JSON.parse(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).messages[1].content)).toEqual({ 0: "Approve the campaign", 1: "Read every mail", 2: "Approve", 3: "Decline" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://127.0.0.1:4920/pools/gemini/v1/chat/completions");
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>)["x-request-id"]).toBeUndefined();
    await translate(["Approve and send"], "el", "notification:0123456789abcdef01234567");
    expect((fetchImpl.mock.calls.at(-1)![1]!.headers as Record<string, string>)["x-request-id"]).toBe("notification:0123456789abcdef01234567");
    const reply = (content: string) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    // A text the model left out is asked once more alone; the answer keeps the rest (stable 1/11: bff6dfcb's version 1 text stayed, nothing said why).
    fetchImpl.mockClear();
    fetchImpl.mockImplementationOnce(reply("{\"0\": \"one\"}"));
    expect(await translate(["Hold", "Skip"], "el")).toEqual(["one", "EL Skip"]);
    expect(JSON.parse(JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body)).messages[1].content)).toEqual({ 1: "Skip" });
    fetchImpl.mockImplementationOnce(reply("{\"0\": \"one\"}")).mockImplementationOnce(reply("{}"));
    await expect(translate(["Pause", "Resume"], "el")).rejects.toThrow("left out texts 1 of 2, twice");
    // A number kept as written, and words around the object, are still the answer.
    fetchImpl.mockImplementationOnce(reply("Here it is: {\"0\": 7, \"1\": \"Όχι\"} Done."));
    expect(await translate(["7", "No"], "el")).toEqual(["7", "Όχι"]);
    fetchImpl.mockImplementationOnce(reply("Sorry, here: ["));
    await expect(translate(["Open", "Close"], "el")).rejects.toThrow("not a JSON object");
    for (const status of [503, 429, 503, 503]) fetchImpl.mockImplementationOnce(async () => new Response("held", { status }));
    await expect(translate(["Open", "Close"], "el")).rejects.toThrow("no route with room: gemini-3-flash-preview 503, gemini-3.5-flash-lite 429, openai/gpt-oss-120b 503, gpt-5.6-luna 503");
    // Texts translated before come from memory: a card made only of them asks nothing, a mixed one asks only its new text.
    fetchImpl.mockClear();
    expect(await translate(["Approve", "", "Decline"], "el")).toEqual(["EL Approve", "", "EL Decline"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await translate(["Approve", "Archive"], "el")).toEqual(["EL Approve", "EL Archive"]);
    expect(JSON.parse(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).messages[1].content)).toEqual({ 0: "Archive" });
    // The memory is per language: the same text into English is asked.
    await translate(["Approve"], "en");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await createCardTranslator({ baseUrl: null, keyFile, fetchImpl: fetchImpl as never })(["Approve"], "el")).toBeNull();
  });

  it("asks the free pools first and Codex last; a Codex 429 rests Codex 30 minutes for every caller (plan clipboard:nsWKwUFhUFWA slice 7)", async () => {
    const answer = (texts: Record<string, string>) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, `EL ${text}`]))) } }] }));
    const asked = (init?: RequestInit) => JSON.parse(JSON.parse(String(init?.body)).messages[1].content) as Record<string, string>;
    // The pools are spent (429), and Codex answers until it refuses with 429 too.
    let codex = 200;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => String(url).includes("/pools/") ? new Response("spent", { status: 429 })
      : codex === 429 ? new Response(JSON.stringify({ error: { code: "usage_limit_reached" } }), { status: 429 }) : answer(asked(init)));
    const keyFile = join(await mkdtemp(join(tmpdir(), "space-card-translate-")), "gateway.key");
    await writeFile(keyFile, "sk-test\n", "utf8");
    const cards = createCardTranslator({ baseUrl: "http://127.0.0.1:4920/v1", keyFile, fetchImpl: fetchImpl as never });
    const steps = createCardTranslator({ baseUrl: "http://127.0.0.1:4920/v1", keyFile, fetchImpl: fetchImpl as never });
    expect(await cards(["Approve", "Decline"], "el", "notification:0123456789abcdef01234567")).toEqual(["EL Approve", "EL Decline"]);
    expect(fetchImpl.mock.calls.map(([called]) => String(called).replace("http://127.0.0.1:4920", ""))).toEqual(["/pools/gemini/v1/chat/completions",
      "/pools/gemini/v1/chat/completions", "/pools/groq/v1/chat/completions", "/v1/chat/completions"]);
    const init = fetchImpl.mock.calls[3]![1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-5.6-luna", store: false });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).store).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-request-id"]).toBe("notification:0123456789abcdef01234567");
    // Codex refuses one translator: the other one does not ask it either (one rest for every caller), until 30 minutes pass.
    codex = 429;
    await expect(cards(["Pause"], "el")).rejects.toThrow("gpt-5.6-luna 429");
    fetchImpl.mockClear();
    await expect(steps(["Resume"], "el")).rejects.toThrow("no route with room: gemini-3-flash-preview 429, gemini-3.5-flash-lite 429, openai/gpt-oss-120b 429.");
    expect(fetchImpl.mock.calls.some(([called]) => !String(called).includes("/pools/"))).toBe(false);
    codex = 200;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    expect(await steps(["Resume"], "el")).toEqual(["EL Resume"]);
    vi.restoreAllMocks();
  });
});

// Operator 21/11 nous_msg:e9b4df3e: a card's mail in neither Greek nor English is translated when the card is raised, the original kept.
describe("needs-you mail in a third language", () => {
  const FRENCH = { subject: "Vous êtes invité à accéder au portail candidat de Startup Talents", text: "Bonjour, vous pouvez maintenant accéder à votre espace candidat avec le lien ci-dessous. Merci et à bientôt.", at: "2026-11-21T10:00:00.000Z" };
  const ENGLISH = { subject: "Your invoice is ready", text: "Hello, the invoice for this month is attached to this mail. Thanks for your order.", at: null };
  const GREEK_MAIL = { subject: "Η παραγγελία σας", text: "Καλημέρα, η παραγγελία σας στάλθηκε σήμερα. Ευχαριστούμε.", at: null };
  const toGreek = vi.fn(async (texts: string[]) => texts.map((text) => `EL:${text}`));

  it("tells French from English and Greek, links and ids aside", () => {
    expect(foreignLanguage(`${FRENCH.subject}\n${FRENCH.text}`)).toBe(true);
    expect(foreignLanguage(`${ENGLISH.subject}\n${ENGLISH.text} https://portail.example.fr/candidat?token=abcdef`)).toBe(false);
    expect(foreignLanguage(`${GREEK_MAIL.subject}\n${GREEK_MAIL.text}`)).toBe(false);
    expect(foreignLanguage("Сообщение о доставке")).toBe(true);
  });

  it("stores the French subject and body translated beside the original; English and Greek stay as written", async () => {
    expect(await translateMail(toGreek, FRENCH, "el")).toEqual({ language: "el", original: FRENCH, subject: `EL:${FRENCH.subject}`, text: `EL:${FRENCH.text}` });
    toGreek.mockClear();
    expect(await translateMail(toGreek, ENGLISH, "el")).toEqual({ language: "el", original: ENGLISH });
    expect(await translateMail(toGreek, GREEK_MAIL, "en")).toEqual({ language: "en", original: GREEK_MAIL });
    expect(toGreek).not.toHaveBeenCalled();
  });

  const mailCard = {
    ownerUserId: "user:1", roomId: "room:1", paneId: "pane:1", source: "MAIL_COPILOT" as const, kind: "REVIEW_REQUESTED", severity: "ATTENTION" as const,
    title: "Mail Copilot needs you", body: "A candidate portal invite from Startup Talents.", link: { roomId: "room:1", paneId: "pane:1", target: "thread:me@example.com:t1" }, dedupeKey: "mail:review:1", telegram: false,
    payload: {}
  };
  const setup = (translate: (texts: string[]) => Promise<string[]>) => {
    const repository = new InMemorySpaceNotificationsRepository();
    const mail = vi.fn(async () => FRENCH);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), translate,
      userSettings: async () => ({ notifications: null, uiLanguage: "en", agentLanguage: "el" }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }) });
    service.setMail(mail);
    return { service, mail };
  };

  it("translates the card's mail into the agent language when raised and keeps the original", async () => {
    const { service, mail } = setup(async (texts) => texts.map((text) => `EL:${text}`));
    const raised = await service.raise(mailCard);
    await vi.waitFor(async () => expect((await service.get("user:1", raised.id))!.payload.mailTranslated).toBeDefined());
    const record = (await service.get("user:1", raised.id))!;
    expect(mail).toHaveBeenCalledWith("user:1", expect.objectContaining({ account: "me@example.com", threadId: "t1" }));
    expect(record.payload.mailTranslated).toMatchObject({ language: "el", original: FRENCH });
    expect(needsYouMailTranslation(record, "el", FRENCH)).toEqual({ subject: `EL:${FRENCH.subject}`, text: `EL:${FRENCH.text}` });
    // A newer message in the thread is not shown with the older one's translation.
    expect(needsYouMailTranslation(record, "el", { subject: FRENCH.subject, at: "2026-11-22T10:00:00.000Z" })).toBeNull();
  });

  it("still raises the card when the translation fails, the mail shown as sent", async () => {
    const { service, mail } = setup(async () => { throw new Error("no route with room"); });
    const raised = await service.raise(mailCard);
    await vi.waitFor(() => expect(mail).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const record = (await service.get("user:1", raised.id))!;
    expect(record.status).toBe("OPEN");
    expect(record.payload.mailTranslated).toBeUndefined();
    expect(needsYouMailTranslation(record, "el", FRENCH)).toBeNull();
  });
});
