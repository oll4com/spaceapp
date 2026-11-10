import { createServer } from "node:https";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spaceCliBrowserCommandRequestSchema, spaceTextCaptchaCommandSchema } from "@space/contracts";
import { CdpClient } from "../src/browser-sessions.js";
import { createTextCaptchaService } from "../src/browser-text-captcha.js";
import { microsoftCaptchaFrame, microsoftCaptchaPage } from "../src/browser-text-captcha-page.js";

const endpoint = vi.hoisted(() => ({ url: "" }));
vi.mock("../src/cli-browser-cdp.js", () => ({ activeTabProfilePath: async () => "/owned/fixture", readChromeAutomationEndpoint: async () => endpoint.url }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const picture = (text: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="70"><rect width="160" height="70" fill="white"/><text x="10" y="30" font-size="25">${text}</text><text x="10" y="60" font-size="25">WXY</text></svg>`).toString("base64")}`;
const markup = `<section id="challenge" style="width:400px;background:white;padding:10px"><h2>Help us prove you're not a robot</h2>
  <img src="${picture("ABC")}"><div><input id="hipAnswer" placeholder="Type the letters" value="old-answer"></div>
  <p role="alert" hidden>Incorrect letters. Try again.</p><button disabled>Submit</button></section>`;
function fixture(url: string) {
  // "/frame" is same-site (in-process); "/reactblade" is cross-site, a real OOPIF like Azure's tenant Create blade.
  if (url === "/frame" || url === "/reactblade") return `<body><input type=password value="private-fixture-password"><button onclick="window.siteSubmits++">Create</button>
    <iframe src="https://${url === "/frame" ? "main.iam.ad.ext.azure.com" : "sandbox-1.reactblade.portal.azure.net"}/captcha" style="position:absolute;left:80px;top:150px;width:600px;height:400px;border:0"></iframe>
    <script>window.siteSubmits=0;</script>`;
  return `<body style="padding:60px"><input id="private" type=password value="private-fixture-password"><form onsubmit="window.siteSubmits++;return false"><button>Create</button></form>
    ${markup}<script>
      window.siteSubmits=0;window.answers=0;window.inputs=0;
      const input=document.querySelector('#hipAnswer'),button=document.querySelector('#challenge button');
      input.addEventListener('input',e=>{if(e.isTrusted)window.inputs++;button.disabled=!input.value});
      button.onclick=e=>{if(!e.isTrusted)return;window.answers++;
        if(input.value==='ABCWXY')document.querySelector('#challenge').remove();
        else document.querySelector('[role=alert]').hidden=false;};
    </script>`;
}

describe("Microsoft text CAPTCHA boundaries", () => {
  it("accepts only fixed Microsoft origins and a strict letters/digits answer with a continuation", () => {
    expect(microsoftCaptchaPage("https://portal.azure.com/#create")).toBe(true);
    expect(microsoftCaptchaFrame("https://main.iam.ad.ext.azure.com/frame")).toBe(true);
    expect(microsoftCaptchaFrame("https://sandbox-1.reactblade.portal.azure.net/")).toBe(true);
    for (const url of ["https://evilreactblade.portal.azure.net.attacker.com", "https://reactblade-portal.azure.net.example", "https://reactblade.portal.azure.net.evil.test"]) {
      expect(microsoftCaptchaFrame(url), url).toBe(false);
    }
    for (const url of ["http://portal.azure.com", "https://portal.azure.com.evil.test", "https://user@portal.azure.com", "https://portal.azure.com:8443", "https://evil.test"]) {
      expect(microsoftCaptchaPage(url), url).toBe(false); expect(microsoftCaptchaFrame(url), url).toBe(false);
    }
    const command = { type: "TEXT_CAPTCHA", action: "answer", checkpoint: "ac5f571a-6123-4fa2-a9ef-831cf0e9cdff", answer: "ABCWXY" };
    expect(spaceTextCaptchaCommandSchema.safeParse(command).success).toBe(true);
    expect(spaceCliBrowserCommandRequestSchema.safeParse({ targetPaneId: "pane:owned", command }).success).toBe(true);
    for (const invalid of [{ ...command, checkpoint: undefined }, { ...command, action: "inspect" }, { ...command, answer: "abc\n" },
      { ...command, selector: "input[type=password]" }, { ...command, url: "https://evil.test" }, { ...command, answer: "" }]) {
      expect(spaceTextCaptchaCommandSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

// Owned HTTPS and Chrome only. Never connects to Microsoft's service or an operator profile.
describe.skipIf(process.env.SPACE_TEXT_CAPTCHA_BROWSER_PROOF !== "1")("text CAPTCHA in real Chrome", () => {
  let dir = "", chrome: ChildProcess | undefined, cdp: CdpClient;
  let chromeError = "";
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    // Chrome's singleton socket must fit sockaddr_un's 108-byte path.
    const base = "/var/lib/spaceapp-user/agent-workspace/active/azcap";
    await mkdir(base, { recursive: true }); dir = await mkdtemp(`${base}/chrome-`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key`, "-out", `${dir}/cert`, "-days", "1", "-subj", "/CN=portal.azure.com"], { stdio: "ignore" });
    server = createServer({ key: await readFile(`${dir}/key`), cert: await readFile(`${dir}/cert`) }, (req, res) => {
      res.writeHead(200, { "content-type": "text/html" }); res.end(fixture(req.url ?? "/"));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    chrome = spawn("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--disable-background-networking", "--site-per-process", "--ignore-certificate-errors", "--window-size=1100,1000",
      `--host-resolver-rules=MAP portal.azure.com 127.0.0.1:${port}, MAP main.iam.ad.ext.azure.com 127.0.0.1:${port}, MAP sandbox-1.reactblade.portal.azure.net 127.0.0.1:${port}, MAP fixture.test 127.0.0.1:${port}`,
      "--remote-debugging-port=0", `--user-data-dir=${dir}/profile`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TMPDIR: dir } });
    chrome.stderr?.on("data", data => { chromeError = (chromeError + data.toString()).slice(-3000); });
    let active = "";
    const deadline = Date.now() + 15_000;
    while (!active && Date.now() < deadline) { active = await readFile(`${dir}/profile/DevToolsActivePort`, "utf8").catch(() => ""); if (!active) await sleep(100); }
    expect(active, chromeError).not.toBe("");
    const [number, path] = active.trim().split("\n"); endpoint.url = `ws://127.0.0.1:${number}${path}`;
    cdp = await CdpClient.connect(endpoint.url, 3_000);
  }, 25_000);
  afterAll(async () => {
    cdp?.close();
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(resolve => chrome!.once("exit", resolve)); chrome.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill("SIGKILL"); await exited; }
    }
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function page(url = "https://portal.azure.com/captcha") {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await sleep(500);
    const options = { config: { browserSessionsProfileRoot: "/owned" }, pane: { id: "pane:owned" },
      session: { sessionId: "browser:owned", activePageId: targetId, pages: [{ pageId: targetId }] }, actor: "cli:owner", checkControl: async () => {},
      command: { action: "inspect" } } as unknown as Parameters<ReturnType<typeof createTextCaptchaService>>[0];
    const evaluate = async (expression: string) => (await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
    return { options, targetId, evaluate };
  }
  it.each(["/captcha", "/frame", "/reactblade"])("crops both lines and submits only the CAPTCHA once, including an owned OOPIF (%s)", async path => {
    const p = await page(`https://portal.azure.com${path}`), solve = createTextCaptchaService();
    try {
      const first = await solve(p.options);
      expect(first.status).toBe("TEXT_CHALLENGE");
      const png = Buffer.from(first.image as string, "base64");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([160, 70]);
      expect(JSON.stringify(first)).not.toMatch(/private-fixture-password|old-answer|hipAnswer/);
      const answer = { ...p.options, command: { action: "answer" as const, checkpoint: first.checkpoint as string, answer: "ABCWXY" } };
      expect(await solve(answer)).toMatchObject({ status: "SUBMITTED", verified: false });
      await expect(solve(answer)).rejects.toThrow(/checkpoint/);
      expect(await solve(p.options)).toMatchObject({ status: "NO_CHALLENGE", verified: false });
      expect(await p.evaluate("window.siteSubmits")).toBe(0);
    } finally { await cdp.send("Target.closeTarget", { targetId: p.targetId }); }
  });
  it("rejects a replaced image, another caller/tab, a covered image and loss of operator control without submitting", async () => {
    const p = await page(), solve = createTextCaptchaService();
    try {
      const first = await solve(p.options);
      const answer = { action: "answer" as const, checkpoint: first.checkpoint as string, answer: "ABCWXY" };
      await expect(solve({ ...p.options, actor: "cli:other", command: answer })).rejects.toThrow(/checkpoint/);
      await expect(solve({ ...p.options, session: { ...p.options.session, activePageId: "other", pages: [{ pageId: "other" }] } as typeof p.options.session, command: answer })).rejects.toThrow(/checkpoint/);
      await p.evaluate(`document.querySelector('#challenge img').src=${JSON.stringify(picture("XYZ"))}`);
      await sleep(100);
      const changed = await solve({ ...p.options, command: answer });
      expect(changed.status).toBe("STALE_CHALLENGE");
      expect(await p.evaluate("({answers:window.answers,inputs:window.inputs})")).toEqual({ answers: 0, inputs: 0 });
      await expect(solve({ ...p.options, command: { ...answer, checkpoint: changed.checkpoint as string }, checkControl: async () => { throw new Error("OPERATOR_CONTROL"); } })).rejects.toThrow("OPERATOR_CONTROL");
      expect(await p.evaluate("window.answers")).toBe(0);
      await p.evaluate("document.querySelector('#challenge img').style.visibility='hidden'");
      expect((await solve(p.options)).status).toBe("UNSUPPORTED_CHALLENGE");
    } finally { await cdp.send("Target.closeTarget", { targetId: p.targetId }); }
  });
  it("reports a rejected answer as pending and never calls submission success", async () => {
    const p = await page(), solve = createTextCaptchaService();
    try {
      const first = await solve(p.options);
      expect(await solve({ ...p.options, command: { action: "answer", checkpoint: first.checkpoint as string, answer: "WRONG" } })).toMatchObject({ status: "SUBMITTED", verified: false });
      const rejected = await solve(p.options);
      expect(rejected).toMatchObject({ status: "TEXT_CHALLENGE", rejected: true, verified: false });
      expect(await p.evaluate("({answers:window.answers,site:window.siteSubmits})")).toEqual({ answers: 1, site: 0 });
    } finally { await cdp.send("Target.closeTarget", { targetId: p.targetId }); }
  });
  it("does not inspect copied markup on another origin", async () => {
    const p = await page("https://fixture.test/captcha");
    try { expect(await createTextCaptchaService()(p.options)).toMatchObject({ status: "UNSUPPORTED_PAGE", verified: false }); }
    finally { await cdp.send("Target.closeTarget", { targetId: p.targetId }); }
  });
});
