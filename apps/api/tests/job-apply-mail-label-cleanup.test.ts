import { describe, expect, it } from "vitest";
import type { JobApplyLabelIds } from "../src/job-apply/gmail-organize.js";
import { cleanupJobMailLabels, cleanupNote } from "../src/job-apply/mail-label-cleanup.js";

const now = Date.parse("2026-11-03T12:00:00.000Z");
const minutesAgo = (minutes: number) => String(now - minutes * 60_000);
const labels: JobApplyLabelIds = { ids: { REJECTION: "L-rej", CONFIRMATION: "L-conf", ACTION_NEEDED: "L-act" }, all: ["L-rej", "L-conf", "L-act", "L-old"], legacyOther: "L-old" };
type Message = { id: string; labelIds: string[]; internalDate: string; from: string; subject: string; text: string };

/** A Gmail that keeps each thread's labels, so the cleanup's last check (is Other empty?) sees what its own modify calls did. */
function fakeGmail(threads: Record<string, Message[]>) {
  const threadLabels = new Map(Object.entries(threads).map(([id, messages]) => [id, new Set(messages.flatMap((message) => message.labelIds))]));
  const messages = new Map(Object.values(threads).flat().map((message) => [message.id, message]));
  const modifies: Array<{ thread: string; addLabelIds?: string[]; removeLabelIds?: string[] }> = [];
  const deleted: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/users\/me/, "");
    const method = init?.method ?? "GET";
    if (path === "/threads") return json({ threads: [...threadLabels].filter(([, set]) => set.has(url.searchParams.get("labelIds")!)).map(([id]) => ({ id })) });
    let match = /^\/threads\/([^/]+)\/modify$/.exec(path);
    if (match && method === "POST") {
      const change = JSON.parse(String(init!.body)) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      const set = threadLabels.get(match[1])!;
      for (const id of change.removeLabelIds ?? []) set.delete(id);
      for (const id of change.addLabelIds ?? []) set.add(id);
      modifies.push({ thread: match[1], ...change });
      return json({});
    }
    match = /^\/threads\/([^/]+)$/.exec(path);
    if (match) return json({ messages: threads[match[1]].map((message) => ({ id: message.id, labelIds: message.labelIds, internalDate: message.internalDate, snippet: message.text,
      payload: { headers: [{ name: "From", value: message.from }, { name: "Subject", value: message.subject }] } })) });
    match = /^\/messages\/([^/]+)$/.exec(path);
    if (match) return json({ payload: { mimeType: "text/plain", body: { data: Buffer.from(messages.get(match[1])!.text).toString("base64url") } } });
    match = /^\/labels\/([^/]+)$/.exec(path);
    if (match && method === "DELETE") { deleted.push(match[1]); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected Gmail call ${method} ${path}`);
  }) as typeof fetch;
  return { fetchImpl, modifies, deleted };
}

describe("job mail label cleanup", () => {
  it("does nothing when the mailbox has no legacy Other label", async () => {
    const gmail = fakeGmail({});
    await expect(cleanupJobMailLabels({ accessToken: "t", fetchImpl: gmail.fetchImpl, account: "a@example.com", labels: { ...labels, legacyOther: null }, nowMs: now })).resolves.toBeNull();
    expect(gmail.modifies).toEqual([]);
  });

  it("files each Other or multi-label thread under one label, then deletes the empty Other label", async () => {
    const gmail = fakeGmail({
      // The newest received mail is a rejection; the operator's newer reply (SENT) is skipped.
      rejected: [
        { id: "r1", labelIds: ["L-old", "INBOX"], internalDate: minutesAgo(60), from: "talent@acme.com", subject: "Engineer role", text: "We have decided to go with another candidate for this role." },
        { id: "r2", labelIds: ["SENT"], internalDate: minutesAgo(30), from: "me@example.com", subject: "Re: Engineer role", text: "Thanks." }
      ],
      trashed: [{ id: "x1", labelIds: ["L-old", "TRASH"], internalDate: minutesAgo(60), from: "talent@acme.com", subject: "Engineer role", text: "We have decided to go with another candidate for this role." }],
      // Two labels, nothing the rules place: the newest message's label stays.
      twoLabels: [
        { id: "k1", labelIds: ["L-act", "INBOX"], internalDate: minutesAgo(120), from: "friend@example.com", subject: "Lunch", text: "Lunch on Friday?" },
        { id: "k2", labelIds: ["L-rej", "INBOX"], internalDate: minutesAgo(60), from: "friend@example.com", subject: "Lunch", text: "Lunch on Friday?" }
      ],
      onlyOther: [{ id: "u1", labelIds: ["L-old", "INBOX"], internalDate: minutesAgo(60), from: "friend@example.com", subject: "Lunch", text: "Lunch on Friday?" }]
    });
    const result = await cleanupJobMailLabels({ accessToken: "t", fetchImpl: gmail.fetchImpl, account: "a@example.com", labels, nowMs: now });

    expect(result).toEqual({ account: "a@example.com", other: 3, multiLabel: 1, rejections: 1, confirmations: 0, actionNeeded: 0, unlabelled: 1, kept: 1, trashOrSpam: 1, otherDeleted: true });
    expect(gmail.modifies).toEqual(expect.arrayContaining([
      { thread: "rejected", addLabelIds: ["L-rej"], removeLabelIds: ["INBOX", "L-conf", "L-act", "L-old"] },
      { thread: "trashed", removeLabelIds: ["L-old"] },
      { thread: "twoLabels", addLabelIds: ["L-rej"], removeLabelIds: ["L-conf", "L-act", "L-old"] },
      { thread: "onlyOther", removeLabelIds: ["L-old"] }
    ]));
    expect(gmail.modifies).toHaveLength(4);
    expect(gmail.deleted).toEqual(["L-old"]);
    expect(cleanupNote(result!)).toBe("Cleaned the Job Applications labels of a@example.com: 3 threads under Other, 1 under two or more labels; filed 1 → Rejections; 1 left where they were without a label; 1 kept their newest label; 1 in the trash or spam lost Other. Deleted the empty label Job Applications/Other (no mail deleted).");
  });
});
