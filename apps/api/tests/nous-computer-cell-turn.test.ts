import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cellTurnArgv, cellTurnEnv } from "../src/computer/cell-host.js";
import type { CellTurnRequest } from "../src/computer/cell-driver.js";
import { createCellRelays } from "../src/computer/cell-relay.js";
import { cellProof, createCellRunnerServer, createRemoteCellDriver, provenCell } from "../src/computer/cell-runner.js";
import { cellTurnBackend, CELL_NO_AI } from "../src/computer/cell-turn.js";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { cellId } from "../src/computer/firecracker-cell-driver.js";
import { registerNousMcpRoute, signNousToken, verifyNousToken } from "../src/nous/mcp.js";
import { NousUnavailableError } from "../src/nous/service.js";

// Plan clipboard:ZGz1LnD51ELH step 7 (Nous decision 27387eef option a): a turn runs in the tenant's cell; its MCP and model calls come back
// only through the cell's relay, the MCP calls with the cell's proof and the model calls with the key put on host-side.
vi.mock("node:fs/promises", async (actual) => ({ ...(await actual<typeof import("node:fs/promises")>()), chown: async () => undefined }));

const runnerToken = "r".repeat(40);
const secret = "cell-turn-test-secret";
const tenant = "tenant:abc";
const cell = { tenantId: tenant, hostId: "nc-cells", memMib: 1024 };
const turnRequest = (over: Partial<CellTurnRequest> = {}): CellTurnRequest => ({
  model: "claude-sonnet-5-5", effort: "high", fallbackModel: null, system: "sys", prompt: "hi", maxTurns: 5, timeoutMs: 60_000, shell: false,
  mcpUrl: "http://192.0.2.1:4940/api/cli/nous/mcp", mcpToken: "nous.abcdefghijklmnopqrstuvwxyz.sig", upstream: { baseUrl: "https://gw.example/anthropic", apiKey: "sk-ngw-secret-key" }, ...over
});
const listen = (server: { listen: (...a: never[]) => unknown }, ...args: unknown[]) => new Promise<void>((r) => (server.listen as (...a: unknown[]) => void)(...args, () => r()));

describe("turn token and cell proof", () => {
  it("binds a cell turn's token to its tenant, and the hub takes it only with that cell's proof", async () => {
    const token = signNousToken(secret, { owner: "user:a", turnId: "nous_turn:t1", expiresAt: Date.now() + 60_000, tenant });
    expect(verifyNousToken(secret, token)).toMatchObject({ owner: "user:a", turnId: "nous_turn:t1", tenant });
    expect(verifyNousToken(secret, signNousToken(secret, { owner: "user:a", turnId: "t", expiresAt: Date.now() + 60_000 }))?.tenant).toBeUndefined();

    const proof = cellProof(runnerToken, cellId(tenant));
    expect(provenCell(runnerToken, proof)).toBe(cellId(tenant));
    expect(provenCell("x".repeat(40), proof)).toBeNull();
    expect(provenCell(runnerToken, `${cellId("tenant:other")}.${proof.split(".")[1]}`)).toBeNull();
    expect(provenCell(runnerToken, undefined)).toBeNull();

    const app = Fastify();
    const service = { turnRunning: () => true, callTool: async () => ({}) };
    registerNousMcpRoute(app, { secret, service: service as never, tools: [], routeOptions: {}, cellProven: (t, p) => provenCell(runnerToken, p) === cellId(t) });
    const noCheck = Fastify();
    registerNousMcpRoute(noCheck, { secret, service: service as never, tools: [], routeOptions: {} });
    const list = (target: typeof app, headers: Record<string, string>) => target.inject({ method: "POST", url: "/api/cli/nous/mcp", headers: { authorization: `Bearer ${token}`, ...headers },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }).then((r) => r.statusCode);
    expect(await list(app, {})).toBe(403);
    expect(await list(app, { "x-space-cell": cellProof(runnerToken, cellId("tenant:other")) })).toBe(403);
    expect(await list(app, { "x-space-cell": proof })).toBe(200);
    expect(await list(noCheck, { "x-space-cell": proof })).toBe(403);
  });
});

describe("cell runner turn", () => {
  const fake = createFakeCellDriver({});
  const withTurn = { ...fake, turn: vi.fn(async () => ({ code: 0, stdout: '{"result":"ok"}', stderr: "" })) };
  const servers = [createCellRunnerServer(fake, runnerToken), createCellRunnerServer(withTurn, runnerToken)];
  const urls: string[] = [];
  beforeAll(async () => {
    for (const server of servers) {
      await listen(server, 0, "127.0.0.1");
      urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));
  const post = (url: string, args: unknown[]) => fetch(`${url}/v1/cells/turn`, { method: "POST", headers: { authorization: `Bearer ${runnerToken}` }, body: JSON.stringify({ args }) }).then((r) => r.status);

  it("checks the turn's shape, answers 501 without a turn driver and runs it through the remote driver", async () => {
    for (const bad of [{ mcpUrl: "http://evil/x" }, { prompt: " " }, { maxTurns: 0 }, { timeoutMs: 1 }, { model: "a b" }, { upstream: { baseUrl: "file:///etc", apiKey: "sk-ngw-secret-key" } },
      { upstream: { baseUrl: "https://gw", apiKey: "k\n" } }, { upstream: { baseUrl: "https://gw", apiKey: "sk-ngw-secret-key", headers: { "X-Up": "1" } } }, { mcpToken: "short" }]) {
      expect(await post(urls[1]!, [cell, turnRequest(bad as Partial<CellTurnRequest>)]), JSON.stringify(bad)).toBe(400);
    }
    expect(await post(urls[0]!, [cell, turnRequest()])).toBe(501);
    const remote = createRemoteCellDriver({ hosts: { "nc-cells": urls[1]! }, token: runnerToken });
    expect(await remote.turn!(cell, turnRequest())).toEqual({ code: 0, stdout: '{"result":"ok"}', stderr: "" });
    expect(withTurn.turn).toHaveBeenCalledWith(cell, turnRequest(), expect.any(AbortSignal));
  });

  it("a Stop on the hub aborts the runner's turn (the request closes, the driver's signal fires)", async () => {
    let seen: AbortSignal | undefined;
    withTurn.turn.mockImplementationOnce((async (_cell: unknown, _request: unknown, signal: AbortSignal) => {
      seen = signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { code: null, stdout: "", stderr: "" };
    }) as never);
    const remote = createRemoteCellDriver({ hosts: { "nc-cells": urls[1]! }, token: runnerToken });
    const stop = new AbortController();
    const turn = remote.turn!(cell, turnRequest(), stop.signal);
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen!.aborted).toBe(false);
    stop.abort();
    await expect(turn).rejects.toThrow();
    await vi.waitFor(() => expect(seen!.aborted).toBe(true));
  });
});

describe("cell relay", () => {
  let dir: string;
  let hubUrl = "", upUrl = "";
  const seen: Array<{ who: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const record = (who: string) => createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => (seen.push({ who, url: req.url!, headers: req.headers, body }), res.end(`${who}-ok`)));
  });
  const hub = record("hub"), up = record("up");
  beforeAll(async () => {
    dir = await mkdtemp("/tmp/relay-");
    await listen(hub, 0, "127.0.0.1");
    await listen(up, 0, "127.0.0.1");
    hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/api/cli/nous/mcp`;
    upUrl = `http://127.0.0.1:${(up.address() as AddressInfo).port}/anthropic`;
  });
  afterAll(async () => {
    hub.close();
    up.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ask = (socketPath: string, method: string, path: string, headers: Record<string, string>, body = "") => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, headers }, (res) => {
      let out = "";
      res.on("data", (d) => (out += d)).on("end", () => resolve({ status: res.statusCode!, body: out }));
    });
    req.on("error", reject).end(body);
  });

  it("passes a turn's MCP calls with the cell's proof and its model calls with the real key, and nothing else", async () => {
    const relays = createCellRelays({ proof: (id) => cellProof(runnerToken, id) });
    const sock = join(dir, "v.sock_5253"), id = cellId(tenant);
    const close = await relays.open(id, sock, 10_001, { handle: "relay-handle-1", mcpUrl: hubUrl, mcpToken: "nous.turn-token", upstream: { baseUrl: upUrl, apiKey: "sk-ngw-real", headers: { "x-nous-task": "reason" } } });

    expect(await ask(sock, "POST", "/api/cli/nous/mcp", { authorization: "Bearer nous.turn-token" }, '{"m":1}')).toEqual({ status: 200, body: "hub-ok" });
    expect(seen.at(-1)).toMatchObject({ who: "hub", url: "/api/cli/nous/mcp", body: '{"m":1}', headers: { "x-space-cell": cellProof(runnerToken, id), authorization: "Bearer nous.turn-token" } });

    expect(await ask(sock, "POST", "/model/v1/messages?beta=true", { "x-api-key": "relay-handle-1", authorization: "Bearer relay-handle-1" }, '{"q":1}')).toEqual({ status: 200, body: "up-ok" });
    const model = seen.at(-1)!;
    expect(model).toMatchObject({ who: "up", url: "/anthropic/v1/messages?beta=true", body: '{"q":1}', headers: { "x-api-key": "sk-ngw-real", "x-nous-task": "reason" } });
    expect(model.headers.authorization).toBeUndefined();

    const count = seen.length;
    expect((await ask(sock, "POST", "/api/cli/nous/mcp", { authorization: "Bearer other" })).status).toBe(401);
    expect((await ask(sock, "POST", "/model/v1/messages", { "x-api-key": "sk-ngw-real" })).status).toBe(401);
    expect((await ask(sock, "POST", "/model/v1/files", { "x-api-key": "relay-handle-1" })).status).toBe(404);
    expect((await ask(sock, "GET", "/api/nous", {})).status).toBe(404);
    expect(seen.length).toBe(count);

    await close();
    expect(existsSync(sock)).toBe(false);
  });
});

describe("the guest's turn command", () => {
  it("runs Claude Code on the relay with the turn's handle, never a key", () => {
    const argv = cellTurnArgv(turnRequest({ shell: true, fallbackModel: "claude-haiku-5-5" }));
    expect(argv.slice(0, 2)).toEqual(["/usr/local/bin/claude", "--strict-mcp-config"]);
    expect(JSON.parse(argv[3]!)).toEqual({ mcpServers: { space_nous: { type: "http", url: "http://127.0.0.1:5253/api/cli/nous/mcp", headers: { Authorization: `Bearer ${turnRequest().mcpToken}` } } } });
    expect(argv.join(" ")).toContain("--tools Bash ToolSearch --allowedTools mcp__space_nous Bash ToolSearch --print --max-turns 5 --output-format json --model claude-sonnet-5-5 --effort high --fallback-model claude-haiku-5-5 --append-system-prompt sys");
    expect(argv.join(" ")).not.toContain("sk-ngw");
    expect(cellTurnArgv(turnRequest({ effort: "none", system: "" }))).not.toContain("--effort");
    expect(cellTurnEnv("relay-h")).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:5253/model", ANTHROPIC_API_KEY: "relay-h", NO_PROXY: "localhost,127.0.0.1", HOME: "/work" });
  });
});

describe("cell turn backend", () => {
  const owner = "user:a";
  const deps = (over: Partial<Parameters<typeof cellTurnBackend>[0]> = {}) => {
    const turn = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ type: "result", result: "Done.", is_error: false, num_turns: 2, total_cost_usd: 0.01 }), stderr: "" }));
    return { turn, deps: {
      pool: { query: async () => ({ rows: [{ tenant_id: tenant }] }) } as never,
      provisioner: { ensureTenantCell: vi.fn(async () => ({ tenantId: tenant, hostId: "nc-cells", from: "AWAKE" as const, wakeMs: 0 })) },
      cells: { cell: async () => ({ memMib: 1024 }) as never },
      driver: { turn },
      upstream: async () => ({ baseUrl: "https://gw.example", apiKey: "sk-ngw-real" }),
      ...over
    } };
  };
  const body = () => ({ model: "claude-sonnet-5-5", effort: "high", system: "s", prompt: "p", maxTurns: 5, timeoutMs: 60_000, mcpUrl: "http://hub/api/cli/nous/mcp",
    mcpToken: signNousToken(secret, { owner, turnId: "nous_turn:t1", expiresAt: Date.now() + 60_000 }) });

  it("wakes the owner's cell, binds the token to its tenant and reads Claude Code's answer", async () => {
    const { turn, deps: d } = deps();
    const result = await cellTurnBackend(d, secret)(body(), new AbortController().signal);
    expect(result).toMatchObject({ text: "Done.", isError: false, model: "claude-sonnet-5-5" });
    const [ref, request] = turn.mock.calls[0] as unknown as [typeof cell, CellTurnRequest];
    expect(ref).toEqual(cell);
    expect(verifyNousToken(secret, request.mcpToken)).toMatchObject({ owner, turnId: "nous_turn:t1", tenant });
    expect(request.upstream.apiKey).toBe("sk-ngw-real");
  });

  it("gives a shell only to a PERSONAL cell: a team cell's turns share one guest user, so a shell could read another member's token (REV1128-008)", async () => {
    const shellOf = async (kind: string | null) => {
      const { turn, deps: d } = deps({ pool: { query: async () => ({ rows: [{ tenant_id: tenant, kind }] }) } as never });
      await cellTurnBackend(d, secret)({ ...body(), shell: true }, new AbortController().signal);
      return (turn.mock.calls[0] as unknown as [unknown, CellTurnRequest])[1].shell;
    };
    expect(await shellOf("PERSONAL")).toBe(true);
    expect(await shellOf("TEAM")).toBe(false);
    expect(await shellOf(null)).toBe(false);
  });

  it("refuses with no AI connected, another provider or a bad token, before any cell wakes", async () => {
    const { deps: d } = deps({ upstream: async () => null });
    await expect(cellTurnBackend(d, secret)(body(), new AbortController().signal)).rejects.toThrow(CELL_NO_AI);
    await expect(cellTurnBackend(d, secret)({ ...body(), provider: "codex" }, new AbortController().signal)).rejects.toBeInstanceOf(NousUnavailableError);
    await expect(cellTurnBackend(d, secret)({ ...body(), mcpToken: "nous.bad" }, new AbortController().signal)).rejects.toThrow("does not verify");
    expect(d.provisioner.ensureTenantCell).not.toHaveBeenCalled();
  });
});

const VM_AGENT = join(__dirname, "../../../deploy/space-vm-agent/space-vm-agent.py");

describe("space-vm-agent turn support", () => {
  it.skipIf(!existsSync(VM_AGENT))("runs exec with env and cwd, and forwards its relay port to the host", async () => {
    const dir = await mkdtemp("/tmp/vma-");
    const agentSock = join(dir, "a.sock"), hostSock = join(dir, "h.sock");
    const host = createNetServer((c) => c.once("data", (d) => c.end(`host got ${d}`)));
    await listen(host, hostSock);
    const free = createNetServer();
    await listen(free, 0, "127.0.0.1");
    const port = (free.address() as AddressInfo).port;
    await new Promise((r) => free.close(r));
    const proc = spawn("python3", ["-I", VM_AGENT, "--unix", agentSock, "--relay", String(port), "--relay-unix", hostSock]);
    await new Promise((r) => proc.stdout.once("data", r));
    const ask = (req: object) => new Promise<Record<string, unknown>>((resolve) => {
      const c = connect(agentSock, () => c.write(`${JSON.stringify(req)}\n`));
      c.once("data", (d) => (c.end(), resolve(JSON.parse(String(d)))));
    });
    try {
      expect(await ask({ op: "exec", argv: ["sh", "-c", "echo $CELL_X; pwd"], env: { CELL_X: "relay" }, cwd: dir })).toMatchObject({ ok: true, code: 0, stdout: `relay\n${dir}\n` });
      expect(await ask({ op: "exec", argv: ["true"], env: { A: 1 } })).toMatchObject({ ok: false });
      const forwarded = await new Promise<string>((resolve, reject) => {
        const c = connect(port, "127.0.0.1", () => c.write("ping"));
        let out = "";
        c.on("data", (d) => (out += d)).on("end", () => resolve(out)).on("error", reject);
      });
      expect(forwarded).toBe("host got ping");
    } finally {
      proc.kill();
      host.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
