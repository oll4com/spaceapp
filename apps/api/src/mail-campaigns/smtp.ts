import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

// A minimal SMTP submission client for our own mail server (public-host Plesk): implicit TLS on 465 or STARTTLS on 587, AUTH PLAIN,
// one recipient per message, dot-stuffed DATA. Enough for campaign mail; no pipelining, no attachments of its own (the MIME is built
// elsewhere). A 4xx answer is transient, a 5xx permanent.
export class SmtpError extends Error {
  constructor(readonly code: number, message: string, readonly stage: string) { super(message); }
  get permanent(): boolean { return this.code >= 500; }
}
export interface SmtpOptions {
  host: string; port: 465 | 587; username: string; password: string; heloName: string; timeoutMs?: number;
  /** Tests: a plain socket instead of TLS (never used for a real server). */
  plainForTests?: boolean;
}

interface Reply { code: number; text: string }
function session(socket: Socket | TLSSocket, timeoutMs: number) {
  let buffer = "";
  const waiting: Array<(reply: Reply | Error) => void> = [];
  const replies: Array<Reply | Error> = [];
  let lines: string[] = [];
  const deliver = (reply: Reply | Error) => { const next = waiting.shift(); if (next) next(reply); else replies.push(reply); };
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) { deliver({ code: Number(line.slice(0, 3)), text: lines.map((entry) => entry.slice(4)).join("\n") }); lines = []; }
    }
  };
  const onError = (error: Error) => deliver(error);
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", () => deliver(new Error("The mail server closed the connection.")));
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`The mail server did not answer within ${timeoutMs / 1000} s.`)));
  return {
    read: () => new Promise<Reply>((resolve, reject) => {
      const take = (reply: Reply | Error) => reply instanceof Error ? reject(reply) : resolve(reply);
      const ready = replies.shift();
      if (ready) take(ready); else waiting.push(take);
    }),
    detach: () => { socket.off("data", onData); socket.off("error", onError); socket.removeAllListeners("close"); socket.setTimeout(0); }
  };
}

/** Opens an authenticated session; `use` gets a command function. QUIT is sent and the socket closed whatever happens. */
async function withSession<T>(options: SmtpOptions, use: (command: (line: string, expect: number[], stage: string) => Promise<Reply>) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const open = () => new Promise<Socket | TLSSocket>((resolve, reject) => {
    const socket: Socket | TLSSocket = options.plainForTests ? tcpConnect({ host: options.host, port: options.port }, () => resolve(socket))
      : options.port === 465 ? tlsConnect({ host: options.host, port: 465, servername: options.host }, () => resolve(socket))
        : tcpConnect({ host: options.host, port: 587 }, () => resolve(socket));
    socket.once("error", reject);
  });
  let socket = await open();
  let talk = session(socket, timeoutMs);
  const command = async (line: string | null, expect: number[], stage: string) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await talk.read();
    if (!expect.includes(reply.code)) throw new SmtpError(reply.code, `${stage}: ${reply.code} ${reply.text}`.slice(0, 500), stage);
    return reply;
  };
  try {
    await command(null, [220], "GREETING");
    let ehlo = await command(`EHLO ${options.heloName}`, [250], "EHLO");
    if (options.port === 587 && !options.plainForTests) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError(530, "The mail server offers no STARTTLS on 587.", "STARTTLS");
      await command("STARTTLS", [220], "STARTTLS");
      talk.detach();
      socket = await new Promise<TLSSocket>((resolve, reject) => { const secure = tlsConnect({ socket, servername: options.host }, () => resolve(secure)); secure.once("error", reject); });
      talk = session(socket, timeoutMs);
      ehlo = await command(`EHLO ${options.heloName}`, [250], "EHLO");
    }
    if (!/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) throw new SmtpError(535, "The mail server offers no AUTH PLAIN.", "AUTH");
    await command(`AUTH PLAIN ${Buffer.from(`\0${options.username}\0${options.password}`, "utf8").toString("base64")}`, [235], "AUTH");
    return await use((line, expect, stage) => command(line, expect, stage));
  } finally {
    try { socket.write("QUIT\r\n"); } catch { /* closing anyway */ }
    socket.end();
  }
}

/** Signs in and leaves (a sender's check): no mail. */
export async function smtpCheck(options: SmtpOptions): Promise<string> {
  return withSession(options, async () => `Signed in to ${options.host}:${options.port} as ${options.username}.`);
}

/** Submits one message; the answer is the server's queue line (its id). */
export async function smtpSubmit(options: SmtpOptions, envelope: { from: string; to: string }, raw: Buffer): Promise<{ providerId: string }> {
  if (/[\r\n<>]/.test(envelope.from + envelope.to)) throw new SmtpError(501, "Bad envelope address.", "ENVELOPE");
  return withSession(options, async (command) => {
    await command(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
    await command(`RCPT TO:<${envelope.to}>`, [250, 251], "RCPT TO");
    await command("DATA", [354], "DATA");
    const body = raw.toString("utf8").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const done = await command(`${body}${body.endsWith("\r\n") ? "" : "\r\n"}.`, [250], "MESSAGE");
    return { providerId: done.text.slice(0, 200) };
  });
}
