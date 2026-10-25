import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNativeReadServer } from "../src/native-read-server.js";
import { serveClaudeNativeTurns, type ClaudeNativeTurns } from "../src/claude-native-turns.js";

// A stand-in for `claude-vscode-parity native-turns --serve`: answers each line, "hang" never, "die" exits.
const fakeServer = `
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.paneId === "hang") return;
  if (request.paneId === "die") process.exit(1);
  process.stdout.write(JSON.stringify({ id: request.id, result: { pane: request.paneId, pid: process.pid } }) + "\\n");
});`;

function server(script = fakeServer, now?: () => number) {
  return createNativeReadServer<{ pane: string; pid: number }>({ command: process.execPath, args: ["-e", script], timeoutMs: 1_000, now });
}

describe("native read server", () => {
  it("answers many reads from one process, matched by id", async () => {
    const reader = server();
    const answers = await Promise.all(["pane:a", "pane:b", "pane:c"].map((paneId) => reader.read({ paneId })));
    expect(answers.map((answer) => answer?.pane)).toEqual(["pane:a", "pane:b", "pane:c"]);
    expect(new Set(answers.map((answer) => answer?.pid)).size).toBe(1);
    reader.stop();
  });

  it("answers undefined for reads in flight when the server dies, then starts a new one", async () => {
    const reader = server();
    const first = await reader.read({ paneId: "pane:a" });
    const [lost] = await Promise.all([reader.read({ paneId: "die" })]);
    expect(lost).toBeUndefined();
    const next = await reader.read({ paneId: "pane:b" });
    expect(next?.pane).toBe("pane:b");
    expect(next?.pid).not.toBe(first?.pid);
    reader.stop();
  });

  it("times a stuck read out as null and restarts the server", async () => {
    const reader = server();
    const before = await reader.read({ paneId: "pane:a" });
    expect(await reader.read({ paneId: "hang" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await reader.read({ paneId: "pane:b" });
    expect(after?.pid).not.toBe(before?.pid);
    reader.stop();
  });

  it("leaves a server that will not start alone for a minute", async () => {
    const starts = join(await mkdtemp(join(tmpdir(), "native-read-server-")), "starts");
    let time = 0;
    const reader = server(`require("node:fs").appendFileSync(${JSON.stringify(starts)}, "x"); process.exit(64)`, () => time);
    expect(await reader.read({ paneId: "pane:a" })).toBeUndefined();
    time += 59_000;
    expect(await reader.read({ paneId: "pane:a" })).toBeUndefined();
    expect(await readFile(starts, "utf8")).toBe("x");
    time += 1_000;
    expect(await reader.read({ paneId: "pane:a" })).toBeUndefined();
    expect(await readFile(starts, "utf8")).toBe("xx");
    await rm(dirname(starts), { recursive: true, force: true });
  });
});

describe("serveClaudeNativeTurns", () => {
  it("validates each request like the one-shot read and answers by id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
    const reads: unknown[] = [];
    const served = serveClaudeNativeTurns(input, output, async (identity) => {
      reads.push(identity);
      return { nativeSessionId: "session" } as ClaudeNativeTurns;
    });
    input.write(`${JSON.stringify({ id: 1, paneId: "pane:abcdef", sessionId: "cli_session:abcdef", rootPid: 4242 })}\n`);
    input.write(`${JSON.stringify({ id: 2, paneId: "../etc", sessionId: "cli_session:abcdef", rootPid: 4242 })}\n`);
    input.write("not json\n");
    input.write(`${JSON.stringify({ id: "3", paneId: "pane:abcdef", sessionId: "cli_session:abcdef", rootPid: 4242 })}\n`);
    input.write(`${"x".repeat(2_000)}\n`);
    input.end();
    await served;
    await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toEqual([{ paneId: "pane:abcdef", sessionId: "cli_session:abcdef", rootPid: 4242 }]);
    expect(lines.map((line) => JSON.parse(line)).sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, result: { nativeSessionId: "session" } },
      { id: 2, result: null }
    ]);
  });
});
