import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { postToWorker } from "../src/nous/mcp.js";
import { helperRunner, turnRunner } from "../src/nous/wiring.js";

// OBS-006 (2026-11-02): a Nous turn's worker request carries the trace id its tool calls carry, so journalctl -u space-worker joins them.
describe("Nous turns name their trace to the worker", () => {
  const options = { config: { cliApiBaseUrl: "https://space.example:4911" }, apiBaseUrl: "https://space.example:4911", auth: { sessionSecret: "s".repeat(64) } } as never;
  const pick = async () => ({ provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh", fallbackModel: null });

  it("sends traceId (trace:<the turn id's last 24>) and turnId with each turn and helper", async () => {
    const run = vi.fn(async () => ({ text: "ok", isError: false, costUsd: null, tokens: null }));
    const backend = { run, unavailable: async () => null } as never;
    await turnRunner(options, backend, pick as never, async () => false)({ owner: "user:operator", turnId: "nous_turn:0123456789abcdef01234567", reason: "INBOX",
      system: "You are Nous.", prompt: "What waits?" } as never, new AbortController().signal);
    expect(run.mock.calls[0]![0]).toMatchObject({ traceId: "trace:0123456789abcdef01234567", turnId: "nous_turn:0123456789abcdef01234567" });
    await helperRunner(options, backend, pick as never)({ owner: "user:operator", subagentId: "nous_sub:fedcba9876543210fedcba98", system: "s", prompt: "p", timeoutMs: 60_000 } as never,
      new AbortController().signal);
    expect(run.mock.calls[1]![0]).toMatchObject({ traceId: "trace:fedcba9876543210fedcba98", turnId: "nous_sub:fedcba9876543210fedcba98" });
  });

  it("OBS-006 (2026-11-05): sends the turn's traceId as x-request-id on the worker socket, and none without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-worker-"));
    const socketPath = join(dir, "worker.sock");
    const seen: unknown[] = [];
    const server = createServer((request, response) => { seen.push(request.headers["x-request-id"]); request.resume().on("end", () => response.end("{}")); });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await postToWorker(socketPath, "/nous-turn", { traceId: "trace:0123456789abcdef01234567", prompt: "p" }, new AbortController().signal);
      await postToWorker(socketPath, "/nous-turn", { prompt: "p" }, new AbortController().signal);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual(["trace:0123456789abcdef01234567", undefined]);
  });
});
