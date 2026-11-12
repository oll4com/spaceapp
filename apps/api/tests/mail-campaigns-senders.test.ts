// Mail Campaigns senders (plan clipboard:IJ2ovfLg1Lbw, step 4): the SMTP submission client against a fake server, the Workspace
// delegation token (a JWT whose signature the fake token endpoint checks), and the sender rules: consumer Gmail is never bulk by
// default, only our own SMTP host, a check (no mail) makes a sender ACTIVE, nothing reaches a third party.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { mailSenderCreateSchema } from "@space/contracts";
import { InMemoryMailCampaignsRepository } from "@space/db";
import { createMailCampaignsService } from "../src/mail-campaigns/service.js";
import { SmtpError, smtpCheck, smtpSubmit } from "../src/mail-campaigns/smtp.js";
import { createDelegatedTokens, type MailTransports } from "../src/mail-campaigns/transports.js";
import { stubMailSite } from "./fixtures/mail-campaigns-dns.js";

stubMailSite();

async function fakeSmtp(script: (line: string) => string | null) {
  const lines: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.write("220 fake ESMTP\r\n");
    let buffer = ""; let inData = false; let data = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") { inData = false; lines.push(`DATA:${data}`); socket.write("250 2.0.0 Ok: queued as ABC123\r\n"); data = ""; } else data += `${line}\n`;
          continue;
        }
        lines.push(line);
        if (line === "DATA") { inData = true; socket.write("354 go\r\n"); continue; }
        const answer = script(line);
        if (answer) socket.write(answer);
        if (line === "QUIT") socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { lines, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const happy = (line: string) => line.startsWith("EHLO") ? "250-fake\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10000000\r\n" : line.startsWith("QUIT") ? "221 bye\r\n" : line.startsWith("AUTH") ? "235 ok\r\n" : "250 ok\r\n";

describe("SMTP submission", () => {
  it("signs in, submits one dot-stuffed message and quits", async () => {
    const fake = await fakeSmtp(happy);
    try {
      const options = { host: "127.0.0.1", port: fake.port as 465, username: "news@brand.example", password: "pw", heloName: "smtp.brand.example", plainForTests: true };
      expect(await smtpCheck(options)).toContain("Signed in");
      const sent = await smtpSubmit(options, { from: "news@brand.example", to: "a@shop.example" }, Buffer.from("Subject: x\n\n.leading dot\nend\n"));
      expect(sent.providerId).toContain("queued as ABC123");
      expect(fake.lines).toContain(`AUTH PLAIN ${Buffer.from("\0news@brand.example\0pw").toString("base64")}`);
      expect(fake.lines).toContain("MAIL FROM:<news@brand.example>");
      expect(fake.lines).toContain("RCPT TO:<a@shop.example>");
      expect(fake.lines.find((line) => line.startsWith("DATA:"))).toBe("DATA:Subject: x\n\n..leading dot\nend\n");
      await expect(smtpSubmit(options, { from: "news@brand.example", to: "a@x.example>\r\nRCPT TO:<b@y.example" }, Buffer.from("x"))).rejects.toThrow(/envelope/i);
    } finally { await fake.close(); }
  });
  it("answers a refused recipient as permanent and a busy server as transient", async () => {
    for (const [code, permanent] of [[550, true], [451, false]] as const) {
      const fake = await fakeSmtp((line) => line.startsWith("RCPT") ? `${code} no\r\n` : happy(line));
      try {
        const error = await smtpSubmit({ host: "127.0.0.1", port: fake.port as 465, username: "u", password: "p", heloName: "h", plainForTests: true }, { from: "a@brand.example", to: "b@x.example" }, Buffer.from("x")).catch((caught) => caught);
        expect(error).toBeInstanceOf(SmtpError);
        expect([error.code, error.permanent, error.stage]).toEqual([code, permanent, "RCPT TO"]);
        for (let tries = 0; tries < 50 && fake.lines.at(-1) !== "QUIT"; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(fake.lines.at(-1)).toBe("QUIT");
      } finally { await fake.close(); }
    }
  });
});

describe("Workspace delegation token", () => {
  it("signs an RS256 assertion for the subject with the send and read scopes, and caches the token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = JSON.stringify({ type: "service_account", client_email: "robot@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" });
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: URLSearchParams }) => {
      const assertion = init.body.get("assertion")!;
      const [header, claims, signature] = assertion.split(".");
      expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
      calls.push(JSON.parse(Buffer.from(claims!, "base64url").toString()));
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const tokens = createDelegatedTokens(fetchImpl, () => 1_800_000_000_000);
    expect(await tokens(key, "info@example.invalid")).toBe("tok");
    expect(await tokens(key, "info@example.invalid")).toBe("tok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ iss: "robot@project.iam.gserviceaccount.com", sub: "info@example.invalid", aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" });
    await expect(tokens(JSON.stringify({ type: "service_account", client_email: "x", private_key: "y", token_uri: "https://evil.example/token" }), "info@example.invalid")).rejects.toThrow(/not a Google service-account/);
  });
});

describe("senders", () => {
  const base = { displayName: "example.invalid", footerAddress: "example.invalid, Athens" };
  function setup(check: () => Promise<string>) {
    const sent: unknown[] = [];
    const transports = { for: () => ({ check, send: async (...args: unknown[]) => { sent.push(args); return { providerId: "x" }; } }) } as unknown as MailTransports;
    return { service: createMailCampaignsService({ repository: new InMemoryMailCampaignsRepository(), transports }), sent };
  }
  it("keeps consumer Gmail out of bulk, refuses foreign relays and other domains' mailboxes", async () => {
    const { service } = setup(async () => "ok");
    const gmail = await service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "someone@gmail.com", config: { route: "GMAIL_CONNECTOR", account: "someone@gmail.com" } }), "test");
    expect(gmail).toMatchObject({ status: "SETUP", bulk: false, warmup: { stage: 0 } });
    expect(gmail.bulkNote).toMatch(/500/);
    await expect(service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "news@brand.example", config: { route: "SMTP", host: "smtp.sendgrid.net", port: 465, username: "u", vaultKeyId: "vault_key:abcdef12" } }), "test"))
      .rejects.toThrow(/EXTERNAL decision/);
    await expect(service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "sales@example.invalid", config: { route: "GMAIL_DELEGATED", subject: "info@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "test"))
      .rejects.toThrow(/own domain/);
    expect(await service.senders("user:o")).toHaveLength(1);
  });
  it("activates a sender only through a passing check, which sends nothing", async () => {
    let pass = false;
    const { service, sent } = setup(async () => { if (!pass) throw new Error("535 authentication failed"); return "Signed in."; });
    const sender = await service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "news@brand.example", config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "news@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "test");
    expect(sender.bulk).toBe(true);
    await expect(service.updateSender("user:o", sender.id, { status: "ACTIVE" })).rejects.toThrow(/check/);
    await expect(service.checkSender("user:o", sender.id)).rejects.toThrow(/535/);
    expect((await service.senders("user:o"))[0]!.status).toBe("SETUP");
    pass = true;
    expect((await service.checkSender("user:o", sender.id)).sender.status).toBe("ACTIVE");
    expect((await service.updateSender("user:o", sender.id, { status: "PAUSED" }))!.status).toBe("PAUSED");
    expect(sent).toEqual([]);
  });
  it("sends one transactional plain-text mail only through the owner's ACTIVE sender (Forgot password)", async () => {
    const { service, sent } = setup(async () => "Signed in.");
    const sender = await service.createSender("user:o", mailSenderCreateSchema.parse({ ...base, address: "news@brand.example", config: { route: "SMTP", host: "smtp.brand.example", port: 465, username: "news@brand.example", vaultKeyId: "vault_key:abcdef12" } }), "test");
    const mail = { to: "owner@brand.example", subject: "Reset your SpaceApp password", text: "Open https://space.example/#password-reset=abc\nonce." };
    await expect(service.sendTransactional("user:o", sender.id, mail)).rejects.toThrow(/cannot send/);
    await service.checkSender("user:o", sender.id);
    await expect(service.sendTransactional("user:other", sender.id, mail)).rejects.toThrow(/cannot send/);
    await expect(service.sendTransactional("user:o", sender.id, { ...mail, to: "a@b.example\r\nBcc: x@y.example" })).rejects.toThrow(/plain ASCII/);
    await service.sendTransactional("user:o", sender.id, mail);
    const [raw, envelope] = sent[0] as [Buffer, { from: string; to: string }];
    expect(envelope).toEqual({ from: "news@brand.example", to: "owner@brand.example" });
    expect(raw.toString("ascii")).toMatch(/Content-Transfer-Encoding: 7bit\r\n\r\nOpen https:\/\/space\.example\/#password-reset=abc\r\nonce\.$/);
  });
});
