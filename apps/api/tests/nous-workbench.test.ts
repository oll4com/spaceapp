// Nous's workbench (operator request 2026-10-21, plan clipboard:GZNzxm7FNwjM): its own folder, Agent Files from it, public pages,
// web search, network checks, git read only and the Space reads it used to ask panes for. No shell, GET only, public hosts only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeployQueueReport, NousDecision, Room } from "@space/contracts";
import { isPublicAddress } from "../src/public-url-fetch.js";
import { createNousFiles } from "../src/nous/files.js";
import { createNousGit } from "../src/nous/git.js";
import { createNousWeb } from "../src/nous/web.js";
import { createNousLimiter, decisionActionFailed } from "../src/nous/workbench.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps, type NousToolOutcome } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = { id: "room:alpha0001", name: "Alpha", kind: "WORKSPACE" } as Room;
const base = mkdtempSync(join(tmpdir(), "nous-workbench-"));
const root = join(base, "agent-workspace");
const ownRoot = join(base, "var", "nous-workspace");
afterAll(() => rmSync(base, { recursive: true, force: true }));
mkdirSync(root, { recursive: true });
mkdirSync(ownRoot, { recursive: true });
symlinkSync(ownRoot, join(root, "nous"));
writeFileSync(join(base, "outside.txt"), "outside");

const files = createNousFiles({ root, ownRoot, artifactRoot: join(base, "artifacts"), rooms: async () => [room], listArtifacts: async () => [], getArtifact: async () => { throw new Error("none"); } });
const tools = (extra: Partial<NousToolDeps> = {}) => createNousTools({ rooms: async () => [room], listPanes: async () => [], files, ...extra } as unknown as NousToolDeps);

describe("Nous's own folder (space_files_write) and Agent Files (space_agent_files_add)", () => {
  it("writes, appends and replaces text only in its folder, and reads it back through ~/agent-workspace/nous", async () => {
    const nous = tools();
    const wrote = await nous.execute("space_files_write", { path: "research/dns.md", text: "# DNS\n" }, ctx);
    expect(wrote).toMatchObject({ ok: true });
    expect(wrote.result).toContain(`${root}/nous/research/dns.md`);
    expect((await nous.execute("space_files_write", { path: "nous/research/dns.md", text: "again" }, ctx)).result).toContain("exists: replace it");
    expect((await nous.execute("space_files_write", { path: `${root}/nous/research/dns.md`, text: "MX ok\n", mode: "append" }, ctx)).ok).toBe(true);
    expect(readFileSync(join(ownRoot, "research", "dns.md"), "utf8")).toBe("# DNS\nMX ok\n");
    expect((await nous.execute("space_files_write", { path: `${ownRoot}/research/dns.md`, text: "fresh", mode: "replace" }, ctx)).ok).toBe(true);
    expect(readFileSync(join(ownRoot, "research", "dns.md"), "utf8")).toBe("fresh");
    const read = await nous.execute("space_files_read", { path: "nous/research/dns.md" }, ctx);
    expect(read).toMatchObject({ ok: true });
    expect(read.result).toContain("fresh");
    expect((await nous.execute("space_files_list", { path: "nous/research" }, ctx)).result).toContain("dns.md");
  });

  it("refuses paths outside its folder, secret-looking names, links a pane planted, binary text and files past 2 MB", async () => {
    const nous = tools();
    for (const path of ["../outside.txt", "/etc/passwd", `${root}/active/x.md`, `${root}/nous`, "~/agent-workspace/nous", "secrets/x.md", "notes/.env", "api-token.txt"]) {
      expect((await nous.execute("space_files_write", { path, text: "x" }, ctx)).ok, path).toBe(false);
    }
    symlinkSync(join(base, "outside.txt"), join(ownRoot, "planted.md"));
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(ownRoot, "planted-dir"));
    for (const path of ["planted.md", "planted-dir/x.md"]) {
      expect((await nous.execute("space_files_write", { path, text: "x", mode: "replace" }, ctx)).ok, path).toBe(false);
    }
    expect(readFileSync(join(base, "outside.txt"), "utf8")).toBe("outside");
    expect((await nous.execute("space_files_write", { path: "bin.md", text: "a\u0000b" }, ctx)).result).toContain("Only text");
    await nous.execute("space_files_write", { path: "big.md", text: "x".repeat(150_000) }, ctx);
    for (let index = 0; index < 13; index += 1) await nous.execute("space_files_write", { path: "big.md", text: "x".repeat(150_000), mode: "append" }, ctx);
    expect((await nous.execute("space_files_write", { path: "big.md", text: "x".repeat(150_000), mode: "append" }, ctx)).result).toContain("would grow past");
  });

  it("gives the operator a file of its folder as a new Agent File in a taxonomy folder, never from elsewhere", async () => {
    const add = vi.fn(async () => ({ id: "artifact:new00001", byteSize: 5 }));
    const nous = tools({ agentFiles: { add } });
    await nous.execute("space_files_write", { path: "reports/olla.md", text: "hello" }, ctx);
    const added = await nous.execute("space_agent_files_add", { path: "reports/olla.md", folder: "Documents/Reports", name: "olla-report.md" }, ctx);
    expect(added).toMatchObject({ ok: true });
    expect(add).toHaveBeenCalledWith(owner, { roomId: room.id, sourceRoot: ownRoot, sourcePath: join(ownRoot, "reports", "olla.md"), filename: "olla-report.md", folder: "Documents/Reports" });
    expect((await nous.execute("space_agent_files_add", { path: "../outside.txt", folder: "Documents" }, ctx)).ok).toBe(false);
    expect((await nous.execute("space_agent_files_add", { path: "reports/olla.md", folder: "../etc" }, ctx)).ok).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

/** A local server that tests reach under public-looking names: only 127.0.0.1 counts as public here. */
const allowLocal = (address: string) => address === "127.0.0.1" || isPublicAddress(address);
const names: Record<string, string> = { "site.example": "127.0.0.1", "whois.iana.example": "127.0.0.1", "private.example": "10.1.2.3", "mixed.example": "203.0.113.9", "tls.example": "127.0.0.1" };
const resolve = async (host: string) => host === "mixed.example" ? [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.5", family: 4 }]
  : names[host] ? [{ address: names[host]!, family: 4 }] : [];

describe("Nous reads the web (space_web_read, space_web_search) and checks hosts (space_net_check)", () => {
  let server: Server;
  let port = 0;
  const seen: IncomingHttpHeaders[] = [];
  let hits = 0;
  beforeAll(async () => {
    server = createHttpServer((request, response) => {
      seen.push(request.headers);
      if (request.url === "/start") { response.writeHead(302, { location: "/page", "set-cookie": "sid=supersecret; HttpOnly" }); response.end(); return; }
      if (request.url === "/page") {
        hits += 1;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "sid=supersecret" });
        response.end(`<html><head><title>Olla &amp; Co</title><script>alert(1)</script></head><body><h1>Hello</h1><p>${"word ".repeat(4_000)}</p><p>Authorization: Bearer abc.def.ghi</p></body></html>`);
        return;
      }
      if (request.url === "/escape") { response.writeHead(302, { location: "http://private.example/" }); response.end(); return; }
      if (request.url === "/image") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.from([137, 80, 78, 71, 0, 0])); return; }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("missing");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));
  const web = (extra: Parameters<typeof createNousWeb>[0] = {}) => createNousWeb({ resolve, allowAddress: allowLocal, ports: [port], ...extra });

  it("reads a public page as redacted text in slices, keeps it for the next slice, sends no cookie and only GET", async () => {
    const nous = tools({ web: web() });
    const first = await nous.execute("space_web_read", { url: `http://site.example:${port}/start` }, ctx);
    expect(first).toMatchObject({ ok: true });
    expect(first.result).toContain(`http://site.example:${port}/page · HTTP 200 · text/html · "Olla & Co"`);
    expect(first.result).toContain("Hello");
    expect(first.result).not.toContain("alert(1)");
    expect(first.result).toMatch(/the rest with offset \d+/);
    const offset = Number(/the rest with offset (\d+)/.exec(first.result)![1]);
    const next = await nous.execute("space_web_read", { url: `http://site.example:${port}/start`, offset }, ctx);
    expect(next.result).toContain("(end)");
    expect(next.result).not.toContain("abc.def.ghi");
    expect(hits).toBe(1);
    expect(seen.every((headers) => headers.cookie === undefined)).toBe(true);
  });

  it("refuses private and local hosts, after DNS and on a redirect, and binary pages", async () => {
    const nous = tools({ web: web() });
    for (const url of ["http://private.example/", "http://mixed.example/", "http://127.0.0.2/", "http://localhost/", `http://site.example:${port}/escape`, "file:///etc/passwd"]) {
      const outcome = await nous.execute("space_web_read", { url }, ctx);
      expect(outcome.ok, url).toBe(false);
    }
    expect((await nous.execute("space_web_read", { url: `http://site.example:${port}/escape` }, ctx)).result).toMatch(/Private and local addresses/);
    expect((await nous.execute("space_web_read", { url: `http://site.example:${port}/image` }, ctx)).result).toContain("not a text page");
  });

  it("searches through the Council's search with a time cap and redacts the findings", async () => {
    const search = vi.fn(async () => [{ title: "Olla", url: "https://example.invalid/", finding: "Authorization: Bearer abc.def.ghi found" }]);
    const nous = tools({ web: web({ search }) });
    const found = await nous.execute("space_web_search", { query: "example.invalid owner", why: "who runs it" }, ctx);
    expect(found.result).toContain("https://example.invalid/");
    expect(found.result).not.toContain("abc.def.ghi");
    expect(search).toHaveBeenCalledWith("example.invalid owner", "who runs it", expect.any(AbortSignal));
    expect((await tools({ web: web() }).execute("space_web_search", { query: "anything" }, ctx)).ok).toBe(false);
  });

  it("checks http status and headers without cookie values, tcp on the fixed ports only, and refuses local names and private PTR", async () => {
    const nous = tools({ web: web() });
    const http = await nous.execute("space_net_check", { check: "http", host: `http://site.example:${port}/page` }, ctx);
    expect(http.result).toContain("HTTP 200");
    expect(http.result).toContain("set-cookie: sid=…");
    expect(http.result).not.toContain("supersecret");
    expect((await nous.execute("space_net_check", { check: "tcp", host: "site.example", port }, ctx)).result).toContain("is open");
    expect((await nous.execute("space_net_check", { check: "tcp", host: "site.example", port: 3306 }, ctx)).result).toContain("not checked");
    expect((await nous.execute("space_net_check", { check: "tcp", host: "private.example", port }, ctx)).ok).toBe(false);
    for (const host of ["localhost", "db", "printer.local", "metadata.google.internal"]) {
      expect((await nous.execute("space_net_check", { check: "dns", host }, ctx)).ok, host).toBe(false);
    }
    expect((await nous.execute("space_net_check", { check: "dns", host: "10.0.0.1", type: "PTR" }, ctx)).ok).toBe(false);
  });

  it("reads the registry's whois through the IANA referral and a TLS certificate's chain, names and expiry", async () => {
    let asked = 0;
    const whoisServer = createTcpServer((socket) => socket.once("data", (query) => {
      asked += 1;
      socket.end(asked === 1 ? "refer: 127.0.0.1\n" : `Domain Name: ${query.toString().trim().toUpperCase()}\nRegistrar: Example Registrar\n`);
    }));
    await new Promise<void>((done) => whoisServer.listen(0, "127.0.0.1", done));
    const whoisPort = (whoisServer.address() as { port: number }).port;
    const key = join(base, "tls.key");
    const cert = join(base, "tls.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
      "-subj", "/CN=tls.example", "-addext", "subjectAltName=DNS:tls.example"], { stdio: "ignore" });
    const tlsServer = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => socket.on("error", () => undefined));
    await new Promise<void>((done) => tlsServer.listen(0, "127.0.0.1", done));
    const tlsPort = (tlsServer.address() as { port: number }).port;
    try {
      const nous = tools({ web: web({ whoisRoot: { host: "whois.iana.example", port: whoisPort }, ports: [tlsPort] }) });
      // A neutral domain: the public export rewrites example.invalid but not the stub's upper-case echo of it.
      const whois = await nous.execute("space_net_check", { check: "whois", host: "example.com" }, ctx);
      expect(whois.result).toContain("Domain Name: EXAMPLE.COM");
      expect(whois.result).toContain("(from 127.0.0.1)");
      const tls = await nous.execute("space_net_check", { check: "tls", host: "tls.example", port: tlsPort }, ctx);
      expect(tls.result).toContain("chain NOT trusted");
      expect(tls.result).toContain("name matches tls.example");
      expect(tls.result).toContain("expires soon");
      expect(tls.result).toContain("Names: tls.example");
    } finally {
      await new Promise<void>((done) => whoisServer.close(() => done()));
      await new Promise<void>((done) => tlsServer.close(() => done()));
    }
  });
});

describe("Nous reads git (space_git)", () => {
  const repo = join(base, "repo");
  const worktrees = join(base, "worktrees");
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Bob", "-c", "user.email=bob@example.com", ...args], { encoding: "utf8" });
  beforeAll(() => {
    mkdirSync(repo);
    mkdirSync(worktrees);
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([1, 0, 2]));
    g("add", ".");
    g("commit", "-q", "-m", "First commit");
    writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
    g("commit", "-q", "-am", "Raise a to 2");
    symlinkSync(join(base, "elsewhere-repo"), join(worktrees, "wt-abc123-ff00aa"));
  });

  it("reads log, show, diff, stat, branches, a file at a revision and blame", async () => {
    const nous = tools({ git: createNousGit({ stable: repo, worktrees }) });
    const run = async (args: Record<string, unknown>) => (await nous.execute("space_git", { repo: "stable", ...args }, ctx));
    expect((await run({ op: "log" })).result).toContain("Raise a to 2");
    expect((await run({ op: "log", grep: "first" })).result).not.toContain("Raise a to 2");
    expect((await run({ op: "show" })).result).toContain("+export const a = 2;");
    expect((await run({ op: "diff", base: "HEAD~1", rev: "HEAD" })).result).toContain("-export const a = 1;");
    expect((await run({ op: "stat" })).result).toContain("app.ts");
    expect((await run({ op: "branches" })).result).toContain("main");
    expect((await run({ op: "file", rev: "HEAD~1", path: "app.ts" })).result).toContain("export const a = 1;");
    expect((await run({ op: "blame", path: "app.ts" })).result).toContain("Bob");
  });

  it("refuses options as revisions, paths out of the repository, secrets, binaries and repositories outside the list", async () => {
    const nous = tools({ git: createNousGit({ stable: repo, worktrees }) });
    const run = async (args: Record<string, unknown>) => (await nous.execute("space_git", { op: "log", repo: "stable", ...args }, ctx));
    expect((await run({ rev: "--output=/tmp/nous-git-x" })).ok).toBe(false);
    expect((await run({ op: "file", path: "../outside.txt" })).ok).toBe(false);
    expect((await run({ op: "file", path: ":(top)app.ts" })).ok).toBe(false);
    expect((await run({ op: "file", path: ".env" })).result).toContain("secret");
    expect((await run({ op: "file", path: "logo.bin" })).result).toContain("binary");
    for (const repoRef of ["/etc", "../repo", "wt-abc123-ff00aa", `${worktrees}/../repo`]) expect((await run({ repo: repoRef })).ok, repoRef).toBe(false);
  });
});

describe("Nous's Space reads and limits", () => {
  const ticket = (id: string, status: string, note: string | null = null) => ({ id, status, branch: `space/${id}`, summary: `Work ${id}`, sha: "a".repeat(40), submittedAt: "2026-10-21T10:00:00Z",
    updatedAt: "2026-10-21T10:05:00Z", note, deployedCommit: null, conflictFiles: status === "CONFLICT" ? ["apps/api/src/app.ts"] : [], autoResolvedFiles: [], remotes: null,
    statusSince: "2026-10-21T10:05:00Z", submitter: { runtimeId: "cli:claude", cliSessionId: null, paneId: "pane:x", roomId: "room:y", paneTitle: "Bob", roomName: "Cleo" } });
  const report = (active: unknown[], recent: unknown[]) => ({ available: true, daemonRunning: true, heartbeatAt: null, paused: null, current: null, active, recent }) as unknown as DeployQueueReport;

  it("lists the merge queues with their tickets and reads one ticket in full", async () => {
    const queues = vi.fn(async () => [{ name: "dev", report: report([ticket("q-20261021-100000-aaaa", "QUEUED")], [ticket("q-20261021-090000-bbbb", "CONFLICT", "merge conflict in app.ts")]) },
      { name: "stable", report: null }]);
    const nous = tools({ queues });
    const all = await nous.execute("space_queue_status", {}, ctx);
    expect(all.result).toContain("dev queue: daemon running");
    expect(all.result).toContain("q-20261021-100000-aaaa QUEUED");
    expect(all.result).toContain("note: merge conflict in app.ts");
    expect(all.result).toContain("stable queue: not readable here.");
    const one = await nous.execute("space_queue_status", { ticket: "q-20261021-090000-bbbb" }, ctx);
    expect(one.result).toContain("Conflict files: apps/api/src/app.ts");
    expect(one.result).toContain("Submitter: Bob in Cleo (cli:claude)");
  });

  it("lists its decisions with their outcome, approved actions that failed first", async () => {
    const decision = (id: string, status: NousDecision["status"], outcome: string | null, createdAt: string) => ({ id, ownerUserId: owner, category: "DESTRUCTIVE", title: `Decision ${id}`,
      body: "", options: [], recommendation: null, refs: {}, action: { type: "PANE_TEXT", roomId: "room:y", paneId: "pane:x", text: "go", mode: "PROMPT" }, status, answer: null, outcome,
      createdAt, answeredAt: createdAt }) as NousDecision;
    const now = new Date().toISOString();
    const listed = [decision("nous_decision:ok", "APPROVED", "Sent to Bob in Cleo.", now), decision("nous_decision:bad", "APPROVED", "Failed: That pane is not in one of your rooms.", now),
      decision("nous_decision:old", "APPROVED", "Failed: x", "2026-09-01T00:00:00.000Z")];
    expect(listed.map(decisionActionFailed)).toEqual([false, true, true]);
    const nous = tools({ decisions: async () => listed });
    const result = (await nous.execute("space_nous_decisions", {}, ctx)).result;
    expect(result).toMatch(/^2 decisions in the last 7 days; 1 approved action FAILED/);
    expect(result.indexOf("nous_decision:bad")).toBeLessThan(result.indexOf("nous_decision:ok"));
    expect(result).not.toContain("nous_decision:old");
  });

  it("limits each workbench tool per owner and hour, and offers the tools under space_ names only", async () => {
    let at = 0;
    const limiter = createNousLimiter({ space_web_read: 2 }, () => at);
    expect([limiter.take(owner, "space_web_read"), limiter.take(owner, "space_web_read")]).toEqual([null, null]);
    expect(limiter.take(owner, "space_web_read")).toContain("frees up in 60 minutes");
    expect(limiter.take("user:other", "space_web_read")).toBeNull();
    expect(limiter.take(owner, "space_world")).toBeNull();
    at = 3_600_001;
    expect(limiter.take(owner, "space_web_read")).toBeNull();
    // Operator rule 2026-10-27: the read tools have no hourly cap; new Agent Files and draft clears keep theirs.
    const defaults = createNousLimiter(undefined, () => at);
    for (const tool of ["space_web_search", "space_web_read", "space_net_check", "space_git", "space_db_query", "space_queue_status", "space_nous_decisions",
      "space_nous_turn_costs", "space_look", "space_files_write"]) {
      expect(Array.from({ length: 300 }, () => defaults.take(owner, tool)).every((refused) => refused === null)).toBe(true);
    }
    expect(Array.from({ length: 31 }, () => defaults.take(owner, "space_clear_pane_draft")).at(-1)).toContain("ran 30 times in the last hour");
    const add = vi.fn(async () => ({ id: "artifact:x", byteSize: 1 }));
    const nous = tools({ agentFiles: { add } });
    await nous.execute("space_files_write", { path: "share.md", text: "x" }, ctx);
    const outcomes: NousToolOutcome[] = [];
    for (let index = 0; index < 21; index += 1) outcomes.push(await nous.execute("space_agent_files_add", { path: "share.md", folder: "Documents" }, ctx));
    expect(outcomes.at(-1)).toMatchObject({ ok: false, refused: true });
    expect(add).toHaveBeenCalledTimes(20);
    const definitions = nousToolDefinitions({ copilots: false }).map((tool) => tool.name);
    expect(definitions).toEqual(expect.arrayContaining(["space_files_write", "space_agent_files_add", "space_web_read", "space_web_search", "space_net_check", "space_git",
      "space_queue_status", "space_nous_decisions", "space_nous_turn_costs"]));
  });
});

describe("Nous clears its own stuck draft (space_clear_pane_draft)", () => {
  const bob = { id: "pane:bob000001", roomId: room.id, title: "Bob", paneName: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
  const setup = (screens: string[], state = "IDLE") => {
    const pressKeys = vi.fn(async () => undefined);
    const inspectPane = vi.fn(async () => ({ sessionId: "cli:s1", runtimeId: "cli:claude", state, text: screens.length > 1 ? screens.shift()! : screens[0]! }));
    const roomTool = vi.fn(async () => ({ ok: true, display: "Sent", result: "{}" }));
    const nous = tools({ listPanes: async () => [bob] as never, inspectPane: inspectPane as never, roomTool: roomTool as never, pressKeys,
      allowances: async () => ({ promote: false, warm: false }) });
    return { nous, pressKeys };
  };

  it("clears text it sent that stayed in an idle composer, and only once", async () => {
    const { nous, pressKeys } = setup(["Done.\n❯ Run plan step 3 and report with space-progress\n", "Done.\n❯ \n"]);
    expect((await nous.execute("space_send_to_pane", { room: "Alpha", panes: ["Bob"], text: "Run plan step 3 and report with space-progress" }, ctx)).ok).toBe(true);
    const cleared = await nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx);
    expect(cleared).toMatchObject({ ok: true });
    expect(pressKeys).toHaveBeenCalledTimes(1);
    expect(pressKeys).toHaveBeenCalledWith("cli:s1", "\u0003", "trace:1");
  });

  it("never touches the operator's draft, a running turn or an empty composer", async () => {
    const own = setup(["Done.\n❯ my own words for later\n"]);
    expect(await own.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: false, refused: true });
    const running = setup(["Working…\n❯ Run plan step 3\n"], "RUNNING");
    expect((await running.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).result).toContain("turn runs");
    const empty = setup(["Done.\n❯ \n"]);
    expect((await empty.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).result).toContain("nothing to clear");
    for (const fixture of [own, running, empty]) expect(fixture.pressKeys).not.toHaveBeenCalled();
  });
});

// Slice 2: the top server-side causes of Nous's tool failures, 7 days to 2026-10-21 (796 failed of 25,316 calls); each case replays a group.
describe("Nous reliability fixes (workbench review 2026-10-21)", () => {
  const cleo = { id: "room:cleo00001", name: "Cleo", kind: "WORKSPACE", ownerUserId: owner } as Room;
  const andy = { id: "pane:andy00001", roomId: cleo.id, title: "Andy", paneName: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
  const nousFor = (extra: Partial<NousToolDeps> = {}) => createNousTools({ rooms: async () => [cleo], listPanes: async () => [andy] as never,
    inspectPane: (async () => ({ sessionId: "cli:s1", runtimeId: "cli:claude", state: "IDLE", text: "❯ " })) as never,
    allowances: async () => ({ promote: false, warm: false }), files, ...extra } as unknown as NousToolDeps);

  it("lets work texts through that only name the deploy script or report money, and still holds real deploys, payments and sends", async () => {
    const { classifyNousOutgoing } = await import("../src/nous/guardrails.js");
    for (const text of [
      "If scripts/space-deploy-commit.sh (or its install loop) would change, keep both steps.",
      "Do not rename any deploy/*.sudoers or binary that scripts/space-deploy-commit.sh validates.",
      "Add them to your steps: (1) scripts/space-deploy-commit.sh around lines 1735 (gateway key copy).",
      "the space_ops full catalog has 6 tools (space_deploy_commit left it on 2026-10-19).",
      "Hetzner: invoice 084000608594 €259.16, card charge failed; SharedLicense invoice $8.00 paid.",
      "Order 159664: replacement instead of refund up to EUR 23.60; is the product code right?",
      "545 paid orders never shipped, no refund recorded: €19,659.52 order totals.",
      "Today is Hetzner's Payment Warning deadline (invoice 081001207245, EUR 197.43).",
      "fair@example.invalid keeps its own From: add it as \"Send mail as\" on info@example.invalid the same way.",
      "Check the pre-send checks it runs: one test mail to itself shows From ntheo@example.invalid."
    ]) expect(classifyNousOutgoing(text), text).toBeNull();
    for (const [text, reason] of [
      ["Run scripts/space-deploy-commit.sh 3e0cb20a49 now.", "a direct deploy"], ["`bash scripts/space-deploy-commit.sh abc`", "a direct deploy"],
      ["sudo -n /opt/spaceapp/scripts/space-queue-deploy.sh --target x", "a direct deploy"], ["Pay the Hetzner invoice with the company card.", "a payment"],
      ["Then buy the Pro plan for $20.", "a payment"], ["Issue a refund of €23.60 to the customer.", "a payment"],
      ["Send the reply email to the client today", "sending or publishing to third parties"]
    ] as const) expect(classifyNousOutgoing(text)?.reasons, text).toContain(reason);
  });

  it("answers the operator now from an inbox turn too, and only refuses while they are away", async () => {
    const { createNousService } = await import("../src/nous/service.js");
    const { InMemoryNousRepository, InMemoryNousAwayRepository } = await import("@space/db");
    const { createNousAway } = await import("../src/nous/away.js");
    for (const isAway of [false, true]) {
      const away = createNousAway({ repository: new InMemoryNousAwayRepository(), notifications: { raise: vi.fn(async () => ({}) as never) }, saveNote: async () => ({}) });
      if (isAway) await away.start(owner, { reason: "Sleeping", mandate: "Keep going", grant: [], operatorMessageId: null, operatorQuote: null });
      const repository = new InMemoryNousRepository();
      let interim = "";
      const late: { service?: ReturnType<typeof createNousService> } = {};
      const service = late.service = createNousService({
        repository, tools: { execute: vi.fn() as never }, limits: { inboxDebounceMs: 5 }, log: { warn: (details: unknown, message: string) => { interim = `warn ${message} ${String((details as { err?: unknown }).err)}`; } },
        runner: async (input) => { interim = await late.service!.replyNow(owner, input.turnId, "The CAPTCHA expires at 14:28."); return { text: "Done.", isError: false }; },
        world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
        settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never, saveSettings: async (_owner, value) => value,
        notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => {}) } as never, executeAction: vi.fn(async () => ""),
        away
      });
      await service.notice(owner, "pane:x", "Nik waits for a CAPTCHA");
      await vi.waitFor(() => expect(interim).not.toBe(""));
      await service.idle(owner);
      expect(interim).toBe(isAway ? "AWAY" : "SENT");
    }
  });

  it("reads an artifact id given without its prefix, clips a card item over 200 characters, and points a draft refusal at the draft tool", async () => {
    const read = vi.fn(async (_owner: string, input: { artifactId?: string }) => `read ${input.artifactId}`);
    expect((await nousFor({ files: { read } as never }).execute("space_files_read", { artifactId: "MDhGXmj67XBw" }, ctx)).result).toBe("read artifact:MDhGXmj67XBw");
    const notify = vi.fn(async () => ({ ok: true, display: "Card", result: "Card" }));
    expect((await nousFor({ paneNotices: { notify } as never }).execute("space_notify_operator", { room: "Cleo", pane: "Andy", title: "Sign in",
      items: [{ text: "x".repeat(260) }, { text: "Solve the CAPTCHA" }], checked: ["Vault: no login for this site"] }, ctx)).ok).toBe(true);
    expect((notify.mock.calls[0] as unknown[])[3]).toMatchObject({ items: [{ text: `${"x".repeat(199)}…` }, { text: "Solve the CAPTCHA" }] });
    const roomTool = vi.fn(async () => ({ ok: false, display: "Could not change Andy's model",
      result: JSON.stringify({ status: "FAILED", results: [{ paneId: andy.id, status: "FAILED", detail: "Send or clear the current CLI draft before changing model settings." }] }) }));
    expect((await nousFor({ roomTool: roomTool as never }).execute("space_set_pane_model", { room: "Cleo", pane: "Andy", modelId: "claude-opus-5-5" }, ctx)).result).toContain("space_clear_pane_draft");
  });

  it("treats a copilot question that was already closed as done and sends an answer to a pane back at its prompt as its next prompt", async () => {
    const answerQuestion = vi.fn(async () => { throw new Error("That Job Copilot question is not waiting any more."); });
    const closed = await nousFor({ copilots: { answerQuestion } as never }).execute("space_copilot_answer", { copilot: "JOB", question: "q1", answer: "Yes, remote only." }, ctx);
    expect(closed).toMatchObject({ ok: true, result: expect.stringContaining("not waiting any more") });
    const calls: Array<[string, Record<string, unknown>]> = [];
    const roomTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return name === "answer_pane_prompt" ? { ok: false, display: "Andy is not waiting for an answer",
        result: "Andy is not waiting for an answer (state IDLE). It is at an empty prompt: send the answer as its next prompt (send_to_pane) instead." }
        : { ok: true, display: "Sent", result: "{\"status\":\"COMPLETED\"}" };
    });
    const answered = await nousFor({ roomTool: roomTool as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "Use the staging database for this step" }, ctx);
    expect(answered).toMatchObject({ ok: true, result: expect.stringContaining("went as its next prompt") });
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane"]);
    expect(calls[1]![1]).toMatchObject({ panes: [andy.id], text: "Use the staging database for this step" });
    calls.length = 0;
    expect((await nousFor({ roomTool: roomTool as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "1" }, ctx)).ok).toBe(false);
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt"]);
  });

  it("moves a Claude account switch on a working pane to after its turn, marks private folders, and calls a terminal without an AI CLI a shell", async () => {
    const roomTool = vi.fn(async () => ({ ok: true, display: "Space Control", result: "{\"status\":\"PENDING\"}" }));
    const nous = nousFor({ roomTool: roomTool as never, inspectPane: (async () => ({ sessionId: "cli:s1", runtimeId: "cli:claude", state: "RUNNING" })) as never });
    const outcome = await nous.execute("space_execute", { room: "Cleo", actions: [{ kind: "configure", target: { paneIds: [andy.id] }, accountProfileId: "space-gateway", when: "NOW" }] }, ctx);
    expect(outcome.ok, outcome.result).toBe(true);
    expect((roomTool.mock.calls[0] as unknown[])[1]).toMatchObject({ arguments: { actions: [{ kind: "configure", accountProfileId: "space-gateway", when: "AFTER_TURN" }] } });
    mkdirSync(join(root, "active", "locked"), { recursive: true });
    execFileSync("chmod", ["000", join(root, "active", "locked")]);
    try {
      expect((await tools().execute("space_files_list", { path: "active" }, ctx)).result).toContain("locked/ · dir");
      expect((await tools().execute("space_files_list", { path: "active" }, ctx)).result).toMatch(/locked\/ · dir · .* · private \(not readable\)/);
    } finally { execFileSync("chmod", ["755", join(root, "active", "locked")]); }
    const { paneKind } = await import("../src/nous/digest.js");
    expect(paneKind(andy as never)).toBe("CLI claude");
    expect(paneKind({ ...andy, terminalRuntimeId: null } as never)).toBe("shell (no AI CLI: read it, never send to it)");
  });
});
