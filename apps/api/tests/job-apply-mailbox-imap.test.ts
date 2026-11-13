// API audit 12/11: an IMAP socket timeout after connect (imapflow's 'error' event) shut the API down at 14:50:07.
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createImapMailboxFactory } from "../src/job-apply/mailbox.js";

// Answers the login and SELECT, then goes silent.
function silentImapServer() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
        const [tag, command] = line.split(" ");
        if (command?.toUpperCase() === "SELECT") socket.write("* 0 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n");
        socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

let close = () => undefined as void;
afterEach(() => close());

describe("IMAP mailbox", () => {
  it("survives a socket timeout after connect", async () => {
    const imap = silentImapServer();
    close = imap.close;
    await new Promise<void>((resolve) => imap.server.listen(0, "127.0.0.1", resolve));
    const port = (imap.server.address() as { port: number }).port;
    const mailbox = await createImapMailboxFactory({ connectTimeoutMs: 2_000, socketTimeoutMs: 200 })
      .open({ host: "127.0.0.1", port, secure: false, user: "u" }, "p");
    expect(await mailbox.recent({})).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await mailbox.close();
  });
});
