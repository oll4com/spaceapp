import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chessCliMoveEnvironment,
  startChessMoveServer,
  validateChessCliMoveInput,
  type ChessCliMoveInput,
} from "../src/chess-cli-move.js";

const base: ChessCliMoveInput = {
  runtimeId: "cli:claude",
  model: "sonnet",
  effort: "high",
  claudeProfile: "crew",
  prompt: "Answer with JSON",
  timeoutMs: 30_000,
};

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chess-move-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function post(socketPath: string, body: unknown, options: { abortAfterMs?: number } = {}) {
  return new Promise<{ status: number; payload: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const call = request({ socketPath, path: "/move", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, payload: JSON.parse(text) }));
    });
    call.on("error", reject);
    call.end(data);
    if (options.abortAfterMs !== undefined) setTimeout(() => call.destroy(), options.abortAfterMs);
  });
}

describe("chess CLI moves in the worker", () => {
  it("accepts only bounded, well-formed moves", () => {
    expect(validateChessCliMoveInput(base).timeoutMs).toBe(30_000);
    expect(validateChessCliMoveInput({ ...base, timeoutMs: 10_000_000 }).timeoutMs).toBe(180_000);
    expect(() => validateChessCliMoveInput({ ...base, runtimeId: "claude; rm -rf /" })).toThrow("Invalid CLI runtime.");
    expect(() => validateChessCliMoveInput({ ...base, model: "--dangerous" })).toThrow("Invalid CLI model.");
    expect(() => validateChessCliMoveInput({ ...base, effort: "HIGH NOW" })).toThrow("Invalid reasoning effort.");
    expect(() => validateChessCliMoveInput({ ...base, claudeProfile: "../main" })).toThrow("Invalid Claude account profile.");
    expect(() => validateChessCliMoveInput({ ...base, prompt: "x".repeat(12_001) })).toThrow("Invalid chess prompt.");
  });

  it("passes model, effort and the Claude account only where they apply", () => {
    expect(chessCliMoveEnvironment(base)).toMatchObject({
      SPACE_AGENT_CHAT_MODEL: "sonnet",
      SPACE_AGENT_CHAT_REASONING_EFFORT: "high",
      SPACE_CLAUDE_ACCOUNT_PROFILE: "crew",
      SPACE_CLI_WORKSPACE: "/opt/spaceapp/var/chess-benchmark/workspace",
    });
    expect(chessCliMoveEnvironment({ ...base, claudeProfile: "main" }).SPACE_CLAUDE_ACCOUNT_PROFILE).toBeUndefined();
    const cursor = chessCliMoveEnvironment({ ...base, runtimeId: "cli:cursor", model: null, effort: null });
    expect(cursor.SPACE_CLAUDE_ACCOUNT_PROFILE).toBeUndefined();
    expect(cursor.SPACE_AGENT_CHAT_MODEL).toBeUndefined();
  });

  it("serves moves over a socket only its owner can open and stops a move when the caller leaves", async () => {
    const socketPath = join(dir, "worker.sock");
    // Unix socket paths hold about 104-107 bytes: a long TMPDIR fails here, not later as ENOENT or EADDRINUSE (1.1.7 review).
    if (socketPath.length > 103) throw new Error(`TMPDIR is too long for a Unix socket path (${socketPath.length} bytes); use a short TMPDIR such as /tmp/s.`);
    let aborted = false;
    const server = await startChessMoveServer(socketPath, async (input, signal) => {
      if (input.prompt === "slow") {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true }));
        throw new Error("cancelled");
      }
      if (input.prompt === "broken") throw new Error("Qwen Code has no available tokens/quota right now.");
      return `{"move":"e2e4"} via ${input.runtimeId} ${input.model}`;
    });
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      const ok = await post(socketPath, base);
      expect(ok).toEqual({ status: 200, payload: { text: '{"move":"e2e4"} via cli:claude sonnet' } });
      const bad = await post(socketPath, { ...base, runtimeId: "nope" });
      expect(bad).toEqual({ status: 400, payload: { error: "Invalid CLI runtime." } });
      const failed = await post(socketPath, { ...base, prompt: "broken" });
      expect(failed).toEqual({ status: 502, payload: { error: "Qwen Code has no available tokens/quota right now." } });
      await post(socketPath, { ...base, prompt: "slow" }, { abortAfterMs: 50 }).catch(() => undefined);
      for (let wait = 0; wait < 100 && !aborted; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(aborted).toBe(true);
    } finally {
      server.close();
    }
  });
});
