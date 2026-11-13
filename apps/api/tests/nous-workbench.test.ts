// Nous's workbench (operator request 2026-10-21, plan clipboard:GZNzxm7FNwjM): its own folder, Agent Files from it, public pages,
// web search, network checks, git read only and the Space reads it used to ask panes for. No shell, GET only, public hosts only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createSocket } from "node:dgram";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SPACE_INSTALL_ROOT, type DeployQueueReport, type GatewayAccount, type NousDecision, type Room } from "@space/contracts";
import { isPublicAddress } from "../src/public-url-fetch.js";
import { createNousFiles } from "../src/nous/files.js";
import { createNousGit } from "../src/nous/git.js";
import { createNousWeb } from "../src/nous/web.js";
import { claudeSearchFindings } from "../src/council/web-search.js";
import { poolBackAt } from "../src/nous/tokens.js";
import { decisionActionFailed } from "../src/nous/workbench.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps, type NousToolOutcome } from "../src/nous/tools.js";
import { rememberSpaceTyped } from "../src/cli-prompt-submit.js";

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
    // R83: the folder's real path reads the same file; a path of Space's checkout is pointed to space_git.
    expect((await nous.execute("space_files_read", { path: `${ownRoot}/research/dns.md` }, ctx)).result).toContain("fresh");
    expect((await nous.execute("space_files_read", { path: `${SPACE_INSTALL_ROOT}/docs/agents/README.md` }, ctx)).result)
      .toContain('read it with space_git op "file", repo "stable", path "docs/agents/README.md"');
    // Goal 401b115b (9/11): any other outside path is answered with the workspace-relative form to send next.
    expect((await nous.execute("space_files_read", { path: "/home/someone/agent-workspace/reports/run.md" }, ctx)).result)
      .toContain('Read it relative to the workspace: path "reports/run.md".');
    expect((await nous.execute("space_files_read", { path: "/opt/run.md" }, ctx)).result)
      .toContain('e.g. path "reports/<folder>/run.md" or "nous/run.md"; space_files_list find "run.md" searches the names.');
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

  it("gives the operator a file of its folder as a new Agent File in a taxonomy folder, holding paths outside the workspace", async () => {
    const add = vi.fn(async () => ({ id: "artifact:new00001", byteSize: 5 }));
    const nous = tools({ agentFiles: { add } });
    await nous.execute("space_files_write", { path: "reports/olla.md", text: "hello" }, ctx);
    const added = await nous.execute("space_agent_files_add", { path: "reports/olla.md", folder: "Documents/Reports", name: "olla-report.md" }, ctx);
    expect(added).toMatchObject({ ok: true });
    expect(add).toHaveBeenCalledWith(owner, { roomId: room.id, sourceRoot: ownRoot, sourcePath: join(ownRoot, "reports", "olla.md"), filename: "olla-report.md", folder: "Documents/Reports", copiedFrom: null });
    // W45 step 2 (2/11: 3 stored FAILED): a path outside the workspace is a hold, worded as final for that path.
    expect(await nous.execute("space_agent_files_add", { path: "../outside.txt", folder: "Documents" }, ctx)).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("Nothing added. Do not call it again with this path;") });
    expect(await nous.execute("space_agent_files_add", { path: "/etc/hostname", folder: "Documents" }, ctx)).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("use a readable, non-secret file of the agent workspace") });
    expect((await nous.execute("space_agent_files_add", { path: "reports/olla.md", folder: "../etc" }, ctx)).ok).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    // 31/10 REVIEW: a pane-written file Space may not read names its owner and mode and the fix.
    add.mockImplementationOnce(async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); });
    const denied = await nous.execute("space_agent_files_add", { path: "reports/olla.md", folder: "Documents" }, ctx);
    expect(denied).toMatchObject({ ok: false, display: "Space may not read that file" });
    expect(denied.result).toMatch(/reports\/olla\.md \(uid \d+, gid \d+, mode \d+\) is not readable by Space: have the pane that wrote it run chmod 664/);
  });

  it("R49-2: publishes a file a pane wrote anywhere under the agent workspace through a redacted copy in nous/published/, never from outside or a secret name", async () => {
    const add = vi.fn(async () => ({ id: "artifact:new00002", byteSize: 9 }));
    const nous = tools({ agentFiles: { add } });
    mkdirSync(join(root, "active", "20261103-pane"), { recursive: true });
    const secret = "sk-ant-api03-" + "a".repeat(40);
    writeFileSync(join(root, "active", "20261103-pane", "brief.md"), `# Brief\nkey ${secret}\n`);
    const added = await nous.execute("space_agent_files_add", { path: "active/20261103-pane/brief.md", folder: "Agent Files › Documents › Reports" }, ctx);
    expect(added).toMatchObject({ ok: true });
    expect(added.result).toContain("Copied from active/20261103-pane/brief.md to nous/published/");
    const call = (add.mock.calls[0] as unknown as [string, { sourceRoot: string; sourcePath: string; filename: string; folder: string; copiedFrom: string }])[1];
    expect(call).toMatchObject({ sourceRoot: ownRoot, filename: "brief.md", folder: "Documents/Reports", copiedFrom: "active/20261103-pane/brief.md" });
    expect(call.sourcePath).toMatch(/\/published\/\d{8}-\d{6}-brief\.md$/);
    expect(call.sourcePath.startsWith(join(ownRoot, "published"))).toBe(true);
    const copy = readFileSync(call.sourcePath, "utf8");
    expect(copy).toContain("# Brief");
    expect(copy).not.toContain(secret);
    expect(readFileSync(join(root, "active", "20261103-pane", "brief.md"), "utf8")).toContain(secret);
    // Never outside the workspace, through a link out of it, or a secret-looking name: nothing is added then.
    writeFileSync(join(root, "active", "api-token.txt"), "x");
    symlinkSync(join(base, "outside.txt"), join(root, "active", "leak.md"));
    for (const path of ["../outside.txt", "/etc/hostname", "active/api-token.txt", "active/leak.md"]) {
      expect(await nous.execute("space_agent_files_add", { path, folder: "Documents" }, ctx), path).toMatchObject({ ok: false, refused: true,
        result: expect.stringContaining("Nothing added. Do not call it again with this path;") });
    }
    expect(add).toHaveBeenCalledTimes(1);
    expect((await nous.execute("space_agent_files_add", { path: "active/20261103-pane/brief.md", folder: "-bad|name" }, ctx)).result).toContain('e.g. "Documents/Reports"');
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
  let slow = 0;
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
      if (request.url === "/slow" || request.url === "/stuck") {
        slow += 1;
        if (request.url === "/stuck" || slow === 1) return; // never answers: the read times out
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Late but here.");
        return;
      }
      if (request.url === "/escape") { response.writeHead(302, { location: "http://private.example/" }); response.end(); return; }
      if (request.url === "/doc.pdf") { response.writeHead(200, { "content-type": "application/pdf" }); response.end(Buffer.from("%PDF-1.4\n%\u00e2\u00e3\n", "latin1")); return; }
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
    expect(first.result).toMatch(/the rest: space_web_read with the same url and "offset": \d+/);
    const offset = Number(/"offset": (\d+)/.exec(first.result)![1]);
    const next = await nous.execute("space_web_read", { url: `http://site.example:${port}/start`, offset }, ctx);
    expect(next.result).toContain("(end)");
    expect(next.result).not.toContain("abc.def.ghi");
    expect(hits).toBe(1);
    expect(seen.every((headers) => headers.cookie === undefined)).toBe(true);
  });

  it("asks a page that did not answer in time once more, and names the timeout when it fails again (R13-8)", async () => {
    const waits: number[] = [];
    const nous = tools({ web: web({ pageTimeoutMs: 300, wait: async (ms) => { waits.push(ms); } }) });
    expect((await nous.execute("space_web_read", { url: `http://site.example:${port}/slow` }, ctx)).result).toContain("Late but here.");
    expect(waits).toEqual([5_000]);
    expect(await nous.execute("space_web_read", { url: `http://site.example:${port}/stuck` }, ctx))
      .toMatchObject({ ok: false, result: expect.stringContaining("did not answer within 0.3 s, twice 5 s apart") });
  });

  it("refuses private and local hosts, after DNS and on a redirect, and binary pages", async () => {
    const nous = tools({ web: web() });
    for (const url of ["http://private.example/", "http://mixed.example/", "http://127.0.0.2/", "http://localhost/", `http://site.example:${port}/escape`, "file:///etc/passwd"]) {
      const outcome = await nous.execute("space_web_read", { url }, ctx);
      expect(outcome.ok, url).toBe(false);
    }
    // Plan ro5ukMcJnIk4 step 2: the public-address gate is a refusal (no Score tool failure).
    expect(await nous.execute("space_web_read", { url: `http://site.example:${port}/escape` }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(/Private and local addresses/) });
    expect(await nous.execute("space_web_read", { url: "http://localhost/" }, ctx)).toMatchObject({ ok: false, refused: true });
    expect((await nous.execute("space_web_read", { url: `http://site.example:${port}/image` }, ctx)).result).toContain("not a text page");
  });

  it("reads a PDF page as its text (plan ro5ukMcJnIk4 step 2: 6 reads failed 'is application/pdf, not a text page' in 7 days)", async () => {
    const readPdf = vi.fn(async (data: Buffer) => ({ status: "FULL" as const, reason: null, text: `--- Page 1 ---\nFellowship RFP (${data.subarray(0, 5).toString("latin1")})` }));
    const nous = tools({ web: web({ readPdf }) });
    const read = await nous.execute("space_web_read", { url: `http://site.example:${port}/doc.pdf` }, ctx);
    expect(read).toMatchObject({ ok: true, result: expect.stringContaining("Fellowship RFP (%PDF-)") });
    expect(read.result).toContain("application/pdf");
    const unreadable = tools({ web: web({ readPdf: async () => ({ status: "UNAVAILABLE" as const, reason: "The file contains no readable text.", text: "" }) }) });
    expect((await unreadable.execute("space_web_read", { url: `http://site.example:${port}/doc.pdf` }, ctx)).result).toContain("is a PDF whose text could not be read: The file contains no readable text.");
  });

  it("searches through the Council's search with a time cap and redacts the findings", async () => {
    const search = vi.fn(async () => [{ title: "Olla", url: "https://example.invalid/", finding: "Authorization: Bearer abc.def.ghi found" }]);
    const nous = tools({ web: web({ search }) });
    const found = await nous.execute("space_web_search", { query: "example.invalid owner", why: "who runs it" }, ctx);
    expect(found.result).toContain("https://example.invalid/");
    expect(found.result).not.toContain("abc.def.ghi");
    // OBS-006: the turn's trace id goes with the search, so Space Gateway's request log rows carry it.
    expect(search).toHaveBeenCalledWith("example.invalid owner", "who runs it", expect.any(AbortSignal), "trace:1");
    expect((await tools({ web: web() }).execute("space_web_search", { query: "anything" }, ctx)).ok).toBe(false);
  });

  it("R74 (2026-11-05 REVIEW: 10 of 10 searches refused 429 on 4/11): a quota refusal answers at once until the gateway's retry time", async () => {
    let clock = Date.parse("2026-11-04T09:07:55Z");
    const search = vi.fn(async () => { throw Object.assign(new Error("Web search HTTP 429: Rate limit exceeded. Try again in 300s"), { kind: "quota" }); });
    const nous = tools({ web: web({ search, now: () => clock }) });
    const first = await nous.execute("space_web_search", { query: "Metavallon VC fund II" }, ctx);
    // 9/11 tool errors (42 in 7 days): a quota wait is REFUSED (QUOTA), not a mistake.
    expect(first).toMatchObject({ ok: false, refused: true });
    expect(first.result).toContain("out of quota until 2026-11-04 09:12 UTC");
    clock += 28_000;
    const again = await nous.execute("space_web_search", { query: "Metavallon Fund II size" }, ctx);
    expect(again.result).toContain("out of quota until 2026-11-04 09:12 UTC");
    expect(again.result).toContain("space_web_read");
    expect(search).toHaveBeenCalledTimes(1);
    clock += 300_000;
    await nous.execute("space_web_search", { query: "Metavallon Fund II size" }, ctx);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("2026-11-07 REVIEW (10 of 10 failed, Codex out to 11/11): while the Codex pool is out the search runs on Claude; only both failing answers the quota text", async () => {
    let clock = Date.parse("2026-11-06T14:59:00Z");
    const search = vi.fn(async () => { throw Object.assign(new Error("Web search HTTP 429: Rate limit exceeded. Try again in 300s"), { kind: "quota" }); });
    const fallbackSearch = vi.fn(async () => claudeSearchFindings({ content: [{ type: "server_tool_use" }, { type: "web_search_tool_result", content: [] },
      { type: "text", text: "LinkedIn's appeal form is at its help page.", citations: [{ type: "web_search_result_location", url: "https://www.linkedin.com/help/linkedin/ask/RA", title: "Appeal a restriction", cited_text: "…" }] }] }));
    const searcher = web({ search, fallbackSearch, now: () => clock, searchBackAt: async () => Date.parse("2026-11-11T05:35:19Z") });
    const nous = tools({ web: searcher });
    const first = await nous.execute("space_web_search", { query: "LinkedIn restricted account appeal form" }, ctx);
    expect(first.ok).toBe(true);
    expect(first.result).toContain("https://www.linkedin.com/help/linkedin/ask/RA");
    expect(searcher.searchOutLine()).toBe("Web search: the Codex pool is out until 2026-11-11 05:35 UTC; space_web_search runs on Claude's search meanwhile.");
    clock += 3_600_000;
    expect((await nous.execute("space_web_search", { query: "LinkedIn appeal" }, ctx)).ok).toBe(true);
    expect(search).toHaveBeenCalledTimes(1);
    expect(fallbackSearch).toHaveBeenCalledTimes(2);
    fallbackSearch.mockRejectedValueOnce(new Error("Claude web search HTTP 429"));
    const both = await nous.execute("space_web_search", { query: "LinkedIn appeal" }, ctx);
    expect(both.ok).toBe(false);
    expect(both.result).toContain("out of quota until 2026-11-11 05:35 UTC");
    expect(both.result).toContain("Claude's search failed too: Claude web search HTTP 429");
  });

  it("2026-11-06 REVIEW (18 of 18 failed while the Codex weeks were used up): a quota refusal waits for the pool's return, and the world says so before a call", async () => {
    let clock = Date.parse("2026-11-05T14:12:00Z");
    const search = vi.fn(async () => { throw Object.assign(new Error("Web search HTTP 429: Rate limit exceeded. Try again in 300s"), { kind: "quota" }); });
    const searcher = web({ search, now: () => clock, searchBackAt: async () => Date.parse("2026-11-11T05:35:19Z") });
    expect(searcher.searchOutLine()).toBeNull();
    const nous = tools({ web: searcher });
    expect((await nous.execute("space_web_search", { query: "Qualco salary" }, ctx)).result).toContain("out of quota until 2026-11-11 05:35 UTC");
    clock += 3 * 3_600_000;
    expect((await nous.execute("space_web_search", { query: "Qualco salary" }, ctx)).result).toContain("out of quota until 2026-11-11 05:35 UTC");
    expect(search).toHaveBeenCalledTimes(1);
    expect(searcher.searchOutLine()).toBe("Web search: out of quota until 2026-11-11 05:35 UTC: space_web_search answers that at once; read pages you know with space_web_read.");
    // The pool's return time: the latest reset of each usable account's spent windows, the first account back; null while one has room.
    const at = Date.parse("2026-11-05T14:12:00Z");
    const account = (status: string, used: [number | null, number | null], resets: [string | null, string | null]) => ({ provider: "CODEX", status,
      primaryWindow: { usedPercent: used[0], resetAt: resets[0], windowMinutes: 300 }, secondaryWindow: { usedPercent: used[1], resetAt: resets[1], windowMinutes: 10_080 } }) as unknown as GatewayAccount;
    const spent = account("RATE_LIMITED", [0, 100], ["2026-11-06T01:41:07Z", "2026-11-11T05:35:19Z"]);
    const paused = account("PAUSED", [0, 0], ["2026-11-12T08:43:03Z", null]);
    expect(poolBackAt([spent, paused], "CODEX", at)).toBe(Date.parse("2026-11-11T05:35:19Z"));
    expect(poolBackAt([spent, account("ACTIVE", [40, 60], ["2026-11-05T16:00:00Z", "2026-11-09T00:00:00Z"])], "CODEX", at)).toBeNull();
    expect(poolBackAt([paused], "CODEX", at)).toBeNull();
  });

  it("checks http status and headers without cookie values, tcp on the fixed ports only, and refuses local names and private PTR", async () => {
    const nous = tools({ web: web() });
    const http = await nous.execute("space_net_check", { check: "http", host: `http://site.example:${port}/page` }, ctx);
    expect(http.result).toContain("HTTP 200");
    expect(http.result).toContain("set-cookie: sid=…");
    expect(http.result).not.toContain("supersecret");
    expect((await nous.execute("space_net_check", { check: "tcp", host: "site.example", port }, ctx)).result).toContain("is open");
    expect((await nous.execute("space_net_check", { check: "tcp", host: "site.example", port: 3306 }, ctx)).result).toContain("not checked");
    expect(await nous.execute("space_net_check", { check: "tcp", host: "private.example", port }, ctx)).toMatchObject({ ok: false, refused: true });
    for (const host of ["localhost", "db", "printer.local", "metadata.google.internal"]) {
      expect((await nous.execute("space_net_check", { check: "dns", host }, ctx)).ok, host).toBe(false);
    }
    expect((await nous.execute("space_net_check", { check: "dns", host: "10.0.0.1", type: "PTR" }, ctx)).ok).toBe(false);
  });

  it("answers a SERVFAIL of the public resolvers as the check's result, not a failure (plan ro5ukMcJnIk4 step 2: 6 in 7 days)", async () => {
    // A resolver that answers SERVFAIL (RCODE 2) to every question: the header's flags become 0x8182 and only the question is kept.
    const dns = createSocket("udp4");
    dns.on("message", (query, peer) => {
      let end = 12;
      while (query[end]) end += query[end]! + 1;
      const answer = Buffer.from(query.subarray(0, end + 5));
      answer.writeUInt16BE(0x8182, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(0, 6); answer.writeUInt16BE(0, 10);
      dns.send(answer, peer.port, peer.address);
    });
    await new Promise<void>((done) => dns.bind(0, "127.0.0.1", done));
    try {
      const nous = tools({ web: web({ dnsServers: [`127.0.0.1:${dns.address().port}`] }) });
      expect(await nous.execute("space_net_check", { check: "dns", host: "kartiva.com", type: "NS" }, ctx))
        .toMatchObject({ ok: true, result: expect.stringContaining("NS kartiva.com:\n- SERVFAIL: the public resolvers got no answer") });
    } finally { dns.close(); }
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

  it("R83 (8/11: worktrees named by their branch): reads the worktree that has the branch checked out", async () => {
    g("worktree", "add", "-q", "-b", "fix/snip-held", join(worktrees, "wt-r83abc-0a0b0c"));
    const nous = tools({ git: createNousGit({ stable: repo, worktrees }) });
    for (const ref of ["snip-held", "fix/snip-held", `${worktrees}/snip-held`]) {
      expect((await nous.execute("space_git", { repo: ref, op: "log" }, ctx)).result, ref).toContain("Raise a to 2");
    }
    expect((await nous.execute("space_git", { repo: "no-such-branch", op: "log" }, ctx)).result).toContain('rev "<branch>"');
  });
});

describe("R51-3: space_git names the repository that has what the other lacks", () => {
  const [stable, dev] = [join(base, "r51-stable"), join(base, "r51-dev")];
  const g = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Bob", "-c", "user.email=bob@example.com", ...args], { encoding: "utf8" }).trim();
  beforeAll(() => {
    mkdirSync(stable);
    g(stable, "init", "-q", "-b", "main");
    writeFileSync(join(stable, "app.ts"), "export const a = 1;\n");
    g(stable, "add", ".");
    g(stable, "commit", "-q", "-m", "First commit");
    g(stable, "branch", "dev");
    execFileSync("git", ["clone", "-q", "-b", "dev", stable, dev]);
    writeFileSync(join(dev, "reveal.ts"), "export const shown = true;\n");
    g(dev, "add", ".");
    g(dev, "commit", "-q", "-m", "Reveal on dev");
  });

  it("answers a file or commit only dev has with repo dev, and reads stable as main in a range", async () => {
    const nous = tools({ git: createNousGit({ stable, dev, worktrees: join(base, "worktrees") }) });
    const run = async (args: Record<string, unknown>) => nous.execute("space_git", { repo: "stable", ...args }, ctx);
    // 3/11 07:19 UTC: a file on dev, not yet promoted, read on stable.
    expect((await run({ op: "file", path: "reveal.ts" })).result).toMatch(/does not exist in 'HEAD'\nreveal\.ts is in dev \(.*r51-dev\): call again with repo "dev"\./);
    const commit = g(dev, "rev-parse", "--short", "HEAD");
    expect((await run({ op: "show", rev: commit })).result).toContain(`${commit} is in dev (`);
    // 3/11 10:51 UTC: "stable..dev" read as main..dev.
    expect((await run({ op: "log", rev: "dev..stable" })).ok).toBe(true);
    // Nowhere: the error alone.
    expect((await run({ op: "file", path: "missing.ts" })).result).not.toContain("call again with repo");
    // R84 (6-8/11: guessed paths such as apps/api/src/nous-providers.ts): the nearest real paths follow the error.
    expect((await run({ op: "file", path: "src/app.ts" })).result).toMatch(/does not exist in 'HEAD'\nNearest paths at HEAD: app\.ts\.$/);
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

  it("has no hourly cap on any workbench tool (operator 31/10 16:07 BKK), and offers the tools under space_ names only", async () => {
    const add = vi.fn(async () => ({ id: "artifact:x", byteSize: 1 }));
    const nous = tools({ agentFiles: { add } });
    await nous.execute("space_files_write", { path: "share.md", text: "x" }, ctx);
    const outcomes: NousToolOutcome[] = [];
    for (let index = 0; index < 30; index += 1) outcomes.push(await nous.execute("space_agent_files_add", { path: "share.md", folder: "Documents" }, ctx));
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(add).toHaveBeenCalledTimes(30);
    const definitions = nousToolDefinitions({ copilots: false }).map((tool) => tool.name);
    expect(definitions).toEqual(expect.arrayContaining(["space_files_write", "space_agent_files_add", "space_web_read", "space_web_search", "space_net_check", "space_git",
      "space_queue_status", "space_nous_decisions", "space_nous_turn_costs"]));
  });
});

describe("Nous clears its own stuck draft (space_clear_pane_draft)", () => {
  const bob = { id: "pane:bob000001", roomId: room.id, title: "Bob", paneName: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false };
  const setup = (screens: string[], state = "IDLE", runtimeId = "cli:claude") => {
    const pressKeys = vi.fn(async () => undefined);
    const inspectPane = vi.fn(async () => ({ sessionId: "cli:s1", runtimeId, state, text: screens.length > 1 ? screens.shift()! : screens[0]! }));
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

  it("clears a scheduled task Space itself typed there (goal 35813e48, 3/11 Bruno/Paul)", async () => {
    const task = "Scheduled task “Temu watch” (Every 2 hours, Space task task:temu00001): Check Temu prices.";
    rememberSpaceTyped("cli:s1", task);
    const { nous, pressKeys } = setup([`Compacted while idle\n❯ ${task}\n`, "Done.\n❯ \n"]);
    expect(await nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: true });
    expect(pressKeys).toHaveBeenCalledWith("cli:s1", "\u0003", "trace:1");
  });

  it("never touches the operator's draft, a running turn or an empty composer", async () => {
    const own = setup(["Done.\n❯ my own words for later\n"]);
    expect(await own.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: false, refused: true });
    const running = setup(["Working…\n❯ Run plan step 3\n"], "RUNNING");
    // R42: a working pane has nothing to clear, which is no failure.
    expect(await running.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: true, result: expect.stringContaining("turn runs") });
    const empty = setup(["Done.\n❯ \n"]);
    expect((await empty.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).result).toContain("nothing to clear");
    for (const fixture of [own, running, empty]) expect(fixture.pressKeys).not.toHaveBeenCalled();
  });

  it("R43-2: clears OpenCode with one Ctrl+C and Antigravity with Ctrl+U and Backspace per line; a CLI with no safe clear is told so", async () => {
    const text = "Run plan step 3\nand report with space-progress";
    const send = async (fixture: ReturnType<typeof setup>) => expect((await fixture.nous.execute("space_send_to_pane", { room: "Alpha", panes: ["Bob"], text }, ctx)).ok).toBe(true);
    // OpenCode 2.2.5 shows a pasted multi-line text as "[Pasted ~2 lines]" (real PTY 2/11).
    const opencode = setup(["┃\n┃  [Pasted ~2 lines]\n┃\n┃  Build · Big Pickle OpenCode\n", "┃\n┃  Ask anything… \"Fix broken tests\"\n┃\n┃  Build · Big Pickle OpenCode\n"], "IDLE", "cli:opencode");
    await send(opencode);
    expect(await opencode.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: true });
    expect(opencode.pressKeys).toHaveBeenCalledWith("cli:s1", "\u0003", "trace:1");
    // Antigravity 1.4.12: Ctrl+C keeps the draft and arms its exit; Ctrl+U empties a line and Backspace joins the one above.
    const rule = "─".repeat(40);
    const agy = setup([`${rule}\n> Run plan step 3\n  and report with space-progress\n${rule}\n? for shortcuts\n`, `${rule}\n> \n${rule}\n? for shortcuts\n`], "IDLE", "cli:gemini");
    await send(agy);
    expect(await agy.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx)).toMatchObject({ ok: true });
    expect(agy.pressKeys).toHaveBeenCalledWith("cli:s1", "\u0015\u007f\u0015\u007f\u0015", "trace:1");
    const other = setup(["> Run plan step 3\n"], "IDLE", "cli:kimi");
    expect(await other.nous.execute("space_clear_pane_draft", { room: "Alpha", pane: "Bob" }, ctx))
      .toMatchObject({ ok: false, refused: true, result: expect.stringContaining("knows no key that empties its composer") });
    expect(other.pressKeys).not.toHaveBeenCalled();    // R79 (queue R42-5): the description names every CLI it clears, so Nous uses it on OpenCode and Antigravity panes too.
    const described = nousToolDefinitions({ copilots: true }).find((definition) => definition.name === "space_clear_pane_draft")!.description;
    for (const cli of ["Claude Code", "Codex", "OpenCode", "Antigravity"]) expect(described, cli).toContain(cli);
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

  it("keeps panes off the paid Claude API key while Claude Max is only pace-held, and allows it once every Max account is out (operator 6/11)", async () => {
    const roomTool = vi.fn(async () => ({ ok: true, display: "Model set", result: "{\"status\":\"COMPLETED\"}" }));
    const max = (nowLeft: number | null) => async () => [{ key: "claude", name: "Claude Max", nowLeft }] as never;
    const keyModel = { room: "Cleo", pane: "Andy", modelId: "space-gateway-claude/claude-opus-5-5" };
    // Pace-held: the week and 5-hour window still have room, so Max serves over its daily share and the key takes nothing.
    expect(await nousFor({ roomTool: roomTool as never, providerRooms: max(72) }).execute("space_set_pane_model", keyModel, ctx))
      .toMatchObject({ ok: false, display: "Claude Max has room", result: expect.stringContaining("cli:claude") });
    expect(roomTool).not.toHaveBeenCalled();
    // A Max model is never refused.
    expect((await nousFor({ roomTool: roomTool as never, providerRooms: max(72) }).execute("space_set_pane_model", { ...keyModel, modelId: "claude-opus-5-5" }, ctx)).ok).toBe(true);
    // Every Max account's week at 100%: the key is the fallback again.
    roomTool.mockClear();
    expect((await nousFor({ roomTool: roomTool as never, providerRooms: max(0) }).execute("space_set_pane_model", keyModel, ctx)).ok).toBe(true);
    expect(roomTool).toHaveBeenCalledTimes(1);
  });

  it("treats a copilot question that was already closed as done and sends an answer to a pane back at its prompt as its next prompt", async () => {
    const answerQuestion = vi.fn(async () => { throw new Error("That Job Copilot question is not waiting any more."); });
    const closed = await nousFor({ copilots: { answerQuestion } as never }).execute("space_copilot_answer", { copilot: "JOB", question: "q1", answer: "Yes, remote only." }, ctx);
    expect(closed).toMatchObject({ ok: true, result: expect.stringContaining("not waiting any more") });
    // 7/11 REVIEW item 2: 14 of 15 failures named the question by its words ("BlooMind draft …: A, B or C?"), not its mailq: id.
    const question = (id: string, text: string) => ({ copilot: "MAIL", kind: "QUESTION", id, paneId: null, title: `Needs you: ${text}`, detail: text });
    const items = vi.fn(async () => [question("mailq:bloo", "BlooMind draft (thread 1a1a6dd84e85adcd): A, B or C?"), question("mailq:pp1", "PayPal: which card?"),
      question("mailq:pp2", "PayPal: which account?"), { ...question("jobq:1", "BlooMind draft"), copilot: "JOB" }]);
    const byId = vi.fn(async (_owner: string, input: { questionId: string }) => { if (!input.questionId.startsWith("mailq:")) throw new Error("The question was not found."); return "Answered."; });
    const words = nousFor({ copilots: { items, answerQuestion: byId } as never });
    expect(await words.execute("space_copilot_answer", { copilot: "MAIL", question: "BlooMind draft (thread 1a1a6dd84e85adcd): A, B or C?", answer: "C" }, ctx))
      .toMatchObject({ ok: true, result: "[mailq:bloo] Answered." });
    expect(byId).toHaveBeenLastCalledWith(owner, expect.objectContaining({ questionId: "mailq:bloo" }));
    expect(await words.execute("space_copilot_answer", { copilot: "MAIL", question: "mailq:pp1", answer: "Visa" }, ctx)).toMatchObject({ ok: true, result: "Answered." });
    expect(await words.execute("space_copilot_answer", { copilot: "MAIL", question: "PayPal", answer: "Visa" }, ctx))
      .toMatchObject({ ok: false, display: "Several questions match", result: expect.stringContaining("[mailq:pp1] PayPal: which card?; [mailq:pp2]") });
    expect(await words.execute("space_copilot_answer", { copilot: "MAIL", question: "Arize pricing reply", answer: "Archive it" }, ctx))
      .toMatchObject({ ok: false, display: "No such question", result: expect.stringContaining("Open now: [mailq:bloo] BlooMind") });
    expect(byId).toHaveBeenCalledTimes(3);
    // 13/11 review: 7 of 7 failures named a needs-you card whose question had closed; an id that never existed still fails.
    const card = { id: "notification:card01", source: "JOB_COPILOT", kind: "QUESTION", title: "Job Copilot has a question", status: "RESOLVED", resolvedAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z", payload: { answeredBy: "USER" } };
    const cards = nousFor({ copilots: { items, answerQuestion: byId } as never, notifications: { list: async () => [], resolve: async () => false, get: async (_o: string, id: string) => id === card.id ? card : null } as never });
    expect(await cards.execute("space_copilot_answer", { copilot: "JOB", question: card.id, answer: "Yes" }, ctx))
      .toMatchObject({ ok: true, display: "ALREADY_CLOSED", result: expect.stringContaining("was closed 2026-11-12T10:00:00.000Z by USER") });
    expect(await cards.execute("space_copilot_answer", { copilot: "JOB", question: "notification:never01", answer: "Yes" }, ctx)).toMatchObject({ ok: false, display: "No such question" });
    // 13/11 Score lever (Alibaba 02:11Z): a just-closed question named in Nous's own words is named back with its card id; still a failure.
    const alibaba = { ...card, id: "notification:ali01", source: "MAIL_COPILOT", title: "Mail Copilot has a question", body: "", payload: { ask: { question: "Alibaba Cloud AI Catalyst welcome: reply with our UID?" } } };
    const closedQuestions = vi.fn(async () => [alibaba, { ...alibaba, id: "notification:other01", payload: { ask: { question: "PayPal: which card?" } } }]);
    const words2 = nousFor({ copilots: { items, answerQuestion: byId } as never, notifications: { list: async () => [], resolve: async () => false, closedQuestions } as never });
    const named = await words2.execute("space_copilot_answer", { copilot: "MAIL", question: "Alibaba Cloud AI Catalyst: welcome mail, $200 credits need an account and the UID", answer: "Star it" }, ctx);
    expect(named).toMatchObject({ ok: false, display: "No such question", result: expect.stringContaining("[notification:ali01] \"Mail Copilot has a question\" closed 2026-11-12T10:00:00.000Z") });
    expect(named.result).not.toContain("other01");
    expect(closedQuestions).toHaveBeenCalledWith(owner, "MAIL_COPILOT");
    const calls: Array<[string, Record<string, unknown>]> = [];
    const roomTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return name === "answer_pane_prompt" ? { ok: false, display: "Andy is not waiting for an answer",
        result: "Andy is not waiting for an answer (state IDLE). It is at an empty prompt: send the answer as its next prompt (send_to_pane) instead." }
        : { ok: true, display: "Sent", result: "{\"status\":\"COMPLETED\"}" };
    });
    const answered = await nousFor({ roomTool: roomTool as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "Use the staging database for this step" }, ctx);
    expect(answered).toMatchObject({ ok: true, result: expect.stringContaining("Andy no longer waited on a prompt, so your answer went through space_send_to_pane.") });
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane"]);
    expect(calls[1]![1]).toMatchObject({ panes: [andy.id], text: "Use the staging database for this step" });
    calls.length = 0;
    // 12/11 review (Bob, Hugo IDLE x7): a pane at its empty prompt asked in prose, so "1" and "yes" go as its next prompt too.
    expect(await nousFor({ roomTool: roomTool as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "1" }, ctx)).toMatchObject({ ok: true, display: "SENT_AS_PROMPT" });
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane"]);
    calls.length = 0;
    expect((await nousFor({ roomTool: roomTool as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "yes" }, ctx)).ok).toBe(true);
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane"]);
    // 2026-10-30 REVIEW ("not waiting for an answer" ×5): a pane whose turn still runs gets the answer through space_send_to_pane too.
    calls.length = 0;
    const running = vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args]);
      return name === "answer_pane_prompt" ? { ok: false, display: "Andy is not waiting for an answer",
        result: "Andy is not waiting for an answer (state RUNNING). Its turn is still running: send the answer with send_to_pane (after its turn)." }
        : { ok: true, display: "Sent", result: "{\"status\":\"COMPLETED\"}" };
    });
    expect(await nousFor({ roomTool: running as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "Use the staging database" }, ctx)).toMatchObject({ ok: true });
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane"]);
    // Item 10 (round 5): while the turn runs, one word that is no menu key goes after it; "yes" or "1" stays an answer to a prompt that is gone.
    calls.length = 0;
    expect((await nousFor({ roomTool: running as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "continue" }, ctx)).ok).toBe(true);
    expect((await nousFor({ roomTool: running as never }).execute("space_answer_pane", { room: "Cleo", pane: "Andy", answer: "yes" }, ctx)).ok).toBe(false);
    expect(calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "send_to_pane", "answer_pane_prompt"]);
    // A pane without a CLI names the tools that reach it instead of the Room Agent's bare refusal.
    const web = { ...andy, id: "pane:web000001", title: "Web", paneName: "Web", mode: "BROWSER", terminalRuntimeId: null };
    calls.length = 0;
    const browser = await nousFor({ roomTool: roomTool as never, listPanes: async () => [andy, web] as never }).execute("space_answer_pane", { room: "Cleo", pane: "Web", answer: "ok" }, ctx);
    expect(browser).toMatchObject({ ok: false, result: expect.stringContaining("is a browser pane without a CLI: there is no prompt to answer. See its page with space_look") });
    expect(calls).toEqual([]);
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
