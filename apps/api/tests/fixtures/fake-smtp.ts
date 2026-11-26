// A local SMTP sink for tests: it answers each command line with `script` and keeps every line and message body; nothing leaves 127.0.0.1.
import { createServer, type Socket } from "node:net";

export async function fakeSmtp(script: (line: string) => string | null) {
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
