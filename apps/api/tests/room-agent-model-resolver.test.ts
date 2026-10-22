import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  checkCodexSolAvailability,
  checkGeminiAvailability,
  resolveAdvancedMissionModel,
  runOpenCodeText
} from "../src/room-agent-model-resolver.js";

describe("room-agent-model-resolver", () => {
  it("asks the pooled weekly quota at the service root with the service key, even for a /v1 base URL", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const mockFetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.authorization ?? null });
      return new Response(JSON.stringify({ remaining_percent: 40, active_accounts_count: 2 }), { status: 200 });
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-key-"));
    const keyFile = path.join(dir, "space-gateway-internal.key");
    await fs.writeFile(keyFile, "sk-sgw-test\n");
    const result = await resolveAdvancedMissionModel({ codexLbBaseUrl: "http://127.0.0.1:4920/v1/", codexLbKeyFile: keyFile,
      fetchImpl: mockFetch as unknown as typeof fetch });
    expect(result.tier).toBe("CODEX");
    expect(calls).toEqual([{ url: "http://127.0.0.1:4920/api/codex/weekly-remaining", authorization: "Bearer sk-sgw-test" }]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves Tier 1 (Codex Sol) when Codex LB has active accounts and remaining quota", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({
        remaining_percent: 65.5,
        active_accounts_count: 3
      }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await resolveAdvancedMissionModel({
      codexLbBaseUrl: "http://192.0.2.246:2455",
      fetchImpl: mockFetch as unknown as typeof fetch
    });

    expect(result.tier).toBe("CODEX");
    expect(result.modelId).toBe("gpt-5.6-sol");
    expect(result.providerId).toBeNull();
    expect(result.reasoningEffort).toBe("high");
  });

  it("resolves Tier 2 (Gemini Flash) when Codex is exhausted and Gemini credentials exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-test-"));
    const tokenDir = path.join(tmpDir, "home/.gemini/antigravity-cli");
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, "antigravity-oauth-token"), "dummy-oauth-content");

    const mockFetchExhausted = async () =>
      new Response(JSON.stringify({
        remaining_percent: 0.0,
        active_accounts_count: 0
      }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await resolveAdvancedMissionModel({
      codexLbBaseUrl: "http://192.0.2.246:2455",
      fetchImpl: mockFetchExhausted as unknown as typeof fetch,
      geminiTokenRoot: tmpDir
    });

    expect(result.tier).toBe("GEMINI");
    expect(result.modelId).toBe("gemini-3.8-flash");
    expect(result.providerId).toBe("cli:gemini");
    expect(result.reasoningEffort).toBe("high");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves Tier 3 (OpenCode Free) when Codex is exhausted and Gemini has no credentials", async () => {
    const emptyGeminiDir = await fs.mkdtemp(path.join(os.tmpdir(), "empty-gemini-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-state-"));
    const stateFile = path.join(stateDir, "model.json");
    await fs.writeFile(stateFile, JSON.stringify({ modelId: "opencode/big-pickle" }));

    const mockFetchError = async () => {
      throw new Error("Codex LB unreachable");
    };

    const result = await resolveAdvancedMissionModel({
      codexLbBaseUrl: "http://192.0.2.246:2455",
      fetchImpl: mockFetchError as unknown as typeof fetch,
      geminiTokenRoot: emptyGeminiDir,
      openCodeStateFile: stateFile
    });

    expect(result.tier).toBe("OPENCODE");
    expect(result.modelId).toBe("opencode/big-pickle");
    expect(result.providerId).toBe("cli:opencode");
    expect(result.reasoningEffort).toBeNull();

    await fs.rm(emptyGeminiDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("runs OpenCode 2 standalone so `run` never starts its background service", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "space-opencode-mode-"));
    const savedPath = process.env.PATH;
    const record = path.join(bin, "args");
    try {
      await fs.writeFile(path.join(bin, "opencode"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nprintf '%s\\n' '{"type":"text","part":{"text":"ok"}}'\n`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
      expect(await runOpenCodeText("opencode/big-pickle", "hi", 5_000)).toBe("ok");
      expect((await fs.readFile(record, "utf8")).split("\n").slice(0, 2)).toEqual(["run", "--standalone"]);
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });

  it("answers only with OpenCode's text events, never with its raw error event", async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), "space-fake-opencode-"));
    const savedPath = process.env.PATH;
    const fake = (lines: string[]) => fs.writeFile(path.join(bin, "opencode"), `#!/bin/sh\nprintf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}\n`, { mode: 0o755 });
    try {
      process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
      await fake(['{"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}']);
      expect(await runOpenCodeText("opencode/big-pickle", "hi", 5_000)).toBeNull();
      await fake(['{"type":"text","part":{"text":"Hugo is closed."}}']);
      expect(await runOpenCodeText("opencode/big-pickle", "hi", 5_000)).toBe("Hugo is closed.");
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });
});
