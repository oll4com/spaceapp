import { describe, expect, it } from "vitest";
import { createGmailClient } from "../src/mail-copilot/gmail-client.js";
import { gmailMessageById } from "../src/mail-campaigns/wiring.js";

// A Gmail that answers like the real API: metadata keeps only the headers named in metadataHeaders (stable 2/11 18:2x: the seed check read NOT_FOUND).
function gmail() {
  const headers = (messageId: string, spam: boolean) => [
    { name: "Authentication-Results", value: `mx.google.com; dkim=pass header.i=@example.invalid header.s=default; spf=pass smtp.mailfrom=ntheo@example.invalid; dmarc=pass (p=QUARANTINE sp=NONE dis=NONE) header.from=oll4.com` },
    { name: "From", value: "ntheo@example.invalid" }, { name: "Subject", value: spam ? "real" : "test" }, { name: "Message-ID", value: messageId }];
  const thread = { id: "t1", messages: [
    { id: "m1", labelIds: ["INBOX"], payload: { headers: headers("<mc.x.test-seed.a@example.invalid>", false) } },
    { id: "m2", labelIds: ["SPAM", "CATEGORY_PERSONAL"], payload: { headers: headers("<mc.x.send.b@example.invalid>", true), body: { data: "aGk=" } } }] };
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input)); asked.push(url.pathname + url.search);
    if (url.pathname.endsWith("/threads")) return Response.json(url.searchParams.get("q")?.includes("mc.x.send.b@example.invalid") ? { threads: [{ id: "t1" }] } : {});
    const named = url.searchParams.getAll("metadataHeaders");
    const shown = url.searchParams.get("format") === "metadata"
      ? { ...thread, messages: thread.messages.map((message) => ({ ...message, payload: { headers: message.payload.headers.filter((entry) => named.includes(entry.name)) } })) } : thread;
    return Response.json(shown);
  }) as typeof fetch;
  return { client: createGmailClient({ accessToken: "x", fetchImpl, retryDelayMs: 0 }), asked };
}

describe("gmailMessageById", () => {
  it("reads one message's labels and every header by its Message-ID, never another copy in its thread", async () => {
    const { client, asked } = gmail();
    const found = await gmailMessageById(client, "<mc.x.send.b@example.invalid>");
    expect(found?.labels).toEqual(["SPAM", "CATEGORY_PERSONAL"]);
    expect(found?.headers.map((entry) => entry.name)).toContain("Authentication-Results");
    expect(asked[0]).toContain("q=in%3Aanywhere+rfc822msgid%3Amc.x.send.b%40example.invalid");
    expect(await gmailMessageById(client, "mc.x.unknown@example.invalid")).toBeNull();
  });
});
