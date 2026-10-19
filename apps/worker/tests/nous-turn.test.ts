import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startChessMoveServer } from "../src/chess-cli-move.js";
import { NOUS_TURN_MAX_BODY_BYTES, NousTurnInputError, parseNousTurnOutput, validateNousTurnInput, type NousTurnInput } from "../src/nous-turn.js";

const base: NousTurnInput = {
  model: "claude-opus-5-5", effort: "xhigh", claudeProfile: "crew", system: "You are Nous.", prompt: "What waits?",
  mcpUrl: "http://127.0.0.1:4911/api/cli/nous/mcp", mcpToken: "nous.abcdefghijklmnopqrstuvwxyz0123456789", maxTurns: 40, timeoutMs: 1_200_000
};

function post(socketPath: string, path: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const call = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    });
    call.on("error", reject);
    call.end(data);
  });
}

describe("Nous turns in the worker", () => {
  it("accepts only a Nous turn for its own tool endpoint, with a bounded model, effort and turn limit", () => {
    expect(validateNousTurnInput(base)).toEqual(base);
    expect(validateNousTurnInput({ ...base, timeoutMs: 99_000_000 }).timeoutMs).toBe(1_200_000);
    for (const bad of [{ mcpUrl: "https://evil.example/collect" }, { mcpToken: "short" }, { effort: "ultra" }, { model: "../../x" }, { maxTurns: 0 },
      { prompt: " " }, { claudeProfile: "Bad Profile" }, { prompt: "x".repeat(400_001) }]) {
      expect(() => validateNousTurnInput({ ...base, ...bad })).toThrow(NousTurnInputError);
    }
  });

  it("reads Claude Code's JSON result, an error result included", () => {
    expect(parseNousTurnOutput('{"type":"result","subtype":"success","is_error":false,"result":"Όλα κινούνται.","num_turns":3}\n'))
      .toEqual({ text: "Όλα κινούνται.", isError: false, turns: 3 });
    expect(parseNousTurnOutput('{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":40}'))
      .toEqual({ text: "Claude Code stopped (error_max_turns).", isError: true, turns: 40 });
    expect(() => parseNousTurnOutput("API Error: 529 overloaded")).toThrow("API Error: 529 overloaded");
  });

  it("serves the turn on the move socket next to the chess moves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-turn-"));
    const socketPath = join(dir, "worker.sock");
    const server = await startChessMoveServer(socketPath, async () => "move", {
      "/nous-turn": { maxBodyBytes: NOUS_TURN_MAX_BODY_BYTES, isInputError: (error) => error instanceof NousTurnInputError,
        handle: async (body) => { const input = validateNousTurnInput(body); return { text: `answered ${input.prompt}`, isError: false, turns: 1 }; } }
    });
    try {
      expect(await post(socketPath, "/nous-turn", base)).toEqual({ status: 200, body: { text: "answered What waits?", isError: false, turns: 1 } });
      expect((await post(socketPath, "/nous-turn", { ...base, mcpUrl: "https://evil.example/x" })).status).toBe(400);
      expect((await post(socketPath, "/elsewhere", base)).status).toBe(404);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
