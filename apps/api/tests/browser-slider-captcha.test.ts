import { createServer } from "node:https";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spaceCliBrowserCommandRequestSchema, spaceSliderCaptchaCommandSchema } from "@space/contracts";
import { CdpClient } from "../src/browser-sessions.js";
import { alibabaSliderPage, createSliderCaptchaService } from "../src/browser-slider-captcha.js";

const endpoint = vi.hoisted(() => ({ url: "" }));
vi.mock("../src/cli-browser-cdp.js", () => ({ activeTabProfilePath: async () => "/owned/fixture", readChromeAutomationEndpoint: async () => endpoint.url }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Like Alibaba NoCaptcha: only a trusted press on the knob, held through 20+ moves to the end of the track in under 3 s, is
// accepted; the first `reject` slides fail and show the provider's "Click to retry". `frame` puts it in a baxia punish frame.
function slider(reject: number, frame: boolean) {
  return `<div id="nc" style="margin:40px"></div><script>
    window.slides=0; window.downs=0; window.retries=0;
    const nc=document.querySelector('#nc');
    function render(){
      nc.innerHTML='<div id="nc_1_wrapper" class="nc_wrapper" style="width:300px"><div id="nc_1_n1t" class="nc_scale" style="position:relative;width:300px;height:34px;background:#e8e8e8">'
        +'<div id="nc_1__bg" class="nc_bg" style="position:absolute;left:0;top:0;height:34px;width:0;background:#7ac23c"></div>'
        +'<span id="nc_1_n1z" class="nc_iconfont btn_slide" style="position:absolute;left:0;top:0;width:42px;height:34px;background:#fff;border:1px solid #999;box-sizing:border-box"></span>'
        +'<div id="nc_1__scale_text">Please slide to verify</div></div></div>';
      const knob=nc.querySelector('.btn_slide'),track=nc.querySelector('.nc_scale'),bg=nc.querySelector('.nc_bg');let drag=null;
      knob.addEventListener('mousedown',e=>{if(!e.isTrusted)return;window.downs++;drag={x:e.clientX,moves:0,t:performance.now()};});
      document.onmousemove=e=>{if(!drag||!e.isTrusted||!(e.buttons&1))return;drag.moves++;const left=Math.max(0,Math.min(e.clientX-drag.x,track.clientWidth-knob.offsetWidth));knob.style.left=left+'px';bg.style.width=left+'px';};
      document.onmouseup=e=>{if(!drag)return;const d=drag;drag=null;window.slides++;
        const ok=parseFloat(knob.style.left||'0')>=track.clientWidth-knob.offsetWidth-1&&d.moves>=20&&performance.now()-d.t<3000&&window.slides>${reject};
        if(ok){${frame ? "frameElement.remove();" : "knob.classList.add('btn_ok');nc.querySelector('#nc_1__scale_text').textContent='Verified';"}return;}
        nc.innerHTML='<div id="\`nc_1_refresh1\`" class="errloading" style="width:300px;height:34px">Click to retry(error:FIXT)</div>';
        nc.querySelector('.errloading').onclick=e=>{if(e.isTrusted){window.retries++;render();}};};
    }
    render();
  </script>`;
}
function fixture(url: URL) {
  const reject = Number(url.searchParams.get("reject") ?? 0);
  if (url.pathname.includes("_____tmd_____/punish")) return `<body>${slider(reject, true)}`;
  const site = `<input type=password value="private-fixture-password"><form onsubmit="window.siteSubmits++;return false"><button>Sign Up</button></form><script>window.siteSubmits=0;</script>`;
  if (url.pathname === "/frame") return `<body>${site}<iframe src="https://passport.alibabacloud.com//register/check.do/_____tmd_____/punish?reject=${reject}"
    style="position:absolute;left:120px;top:180px;width:500px;height:200px;border:0"></iframe>`;
  if (url.pathname === "/plain") return `<body>${site}`;
  return `<body>${site}${slider(reject, false)}`;
}

describe("Alibaba slider boundaries", () => {
  it("accepts only Alibaba Cloud / Aliyun HTTPS pages and a strict command", () => {
    for (const url of ["https://passport.alibabacloud.com//register/x/_____tmd_____/punish?x5secdata=1", "https://account.alibabacloud.com/register/intl_register.htm", "https://passport.aliyun.com/"]) {
      expect(alibabaSliderPage(url), url).toBe(true);
    }
    for (const url of ["http://passport.alibabacloud.com/", "https://alibabacloud.com.evil.test/", "https://evilalibabacloud.com/", "https://user@passport.alibabacloud.com/",
      "https://passport.alibabacloud.com:8443/", "https://fixture.test/", "not a url"]) expect(alibabaSliderPage(url), url).toBe(false);
    expect(spaceCliBrowserCommandRequestSchema.safeParse({ targetPaneId: "pane:owned", command: { type: "SLIDER_CAPTCHA" } }).success).toBe(true);
    for (const extra of [{ selector: ".btn_slide" }, { url: "https://evil.test" }, { distance: 300 }]) {
      expect(spaceSliderCaptchaCommandSchema.safeParse({ type: "SLIDER_CAPTCHA", ...extra }).success).toBe(false);
    }
  });
});

// Owned HTTPS and Chrome only. Never connects to Alibaba or an operator profile.
describe.skipIf(process.env.SPACE_SLIDER_CAPTCHA_BROWSER_PROOF !== "1")("Alibaba slider in real Chrome", () => {
  let dir = "", chrome: ChildProcess | undefined, cdp: CdpClient, chromeError = "";
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    // Chrome's singleton socket must fit sockaddr_un's 108-byte path.
    const base = "/var/lib/spaceapp-user/agent-workspace/active/alislide";
    await mkdir(base, { recursive: true }); dir = await mkdtemp(`${base}/chrome-`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key`, "-out", `${dir}/cert`, "-days", "1", "-subj", "/CN=alibabacloud.com"], { stdio: "ignore" });
    server = createServer({ key: await readFile(`${dir}/key`), cert: await readFile(`${dir}/cert`) }, (req, res) => {
      res.writeHead(200, { "content-type": "text/html" }); res.end(fixture(new URL(req.url ?? "/", "https://fixture.test")));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    chrome = spawn("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--disable-background-networking", "--site-per-process", "--ignore-certificate-errors", "--window-size=1100,900",
      `--host-resolver-rules=MAP passport.alibabacloud.com 127.0.0.1:${port}, MAP account.alibabacloud.com 127.0.0.1:${port}, MAP fixture.test 127.0.0.1:${port}`,
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
  async function page(url: string, checkControl = async () => {}) {
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await sleep(700);
    const options = { config: { browserSessionsProfileRoot: "/owned" }, pane: { id: "pane:owned" }, command: {}, checkControl,
      session: { sessionId: "browser:owned", activePageId: targetId, pages: [{ pageId: targetId }] } } as unknown as Parameters<ReturnType<typeof createSliderCaptchaService>>[0];
    const evaluate = async (expression: string) => (await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
    const close = () => cdp.send("Target.closeTarget", { targetId });
    return { options, evaluate, close };
  }

  it("slides the baxia punish frame clear after the provider's retry, and returns only a status", async () => {
    const p = await page("https://passport.alibabacloud.com/frame?reject=1");
    try {
      const result = await createSliderCaptchaService()(p.options);
      expect(result).toMatchObject({ status: "CLEARED", cleared: true, slides: 2 });
      expect(Object.keys(result).sort()).toEqual(["cleared", "message", "slides", "status"]);
      expect(JSON.stringify(result)).not.toMatch(/private-fixture-password|FIXT|nc_1/);
      expect(await p.evaluate("[document.querySelectorAll('iframe').length, window.siteSubmits]")).toEqual([0, 0]);
    } finally { await p.close(); }
  }, 40_000);

  it("clears an inline slider once, then reports it verified as NO_CHALLENGE without another slide", async () => {
    const p = await page("https://account.alibabacloud.com/inline"), solve = createSliderCaptchaService();
    try {
      expect(await solve(p.options)).toMatchObject({ status: "CLEARED", slides: 1 });
      expect(await solve(p.options)).toMatchObject({ status: "NO_CHALLENGE", slides: 0 });
      expect(await p.evaluate("[window.downs, window.siteSubmits]")).toEqual([1, 0]);
    } finally { await p.close(); }
  }, 40_000);

  it("stops after three rejected slides and hands off", async () => {
    const p = await page("https://account.alibabacloud.com/inline?reject=9");
    try {
      expect(await createSliderCaptchaService()(p.options)).toMatchObject({ status: "REJECTED", cleared: false, slides: 3 });
      expect(await p.evaluate("[window.slides, window.retries]")).toEqual([3, 2]);
    } finally { await p.close(); }
  }, 60_000);

  it("touches nothing on another site's copy, a page without a slider, or after the operator takes control", async () => {
    const copy = await page("https://fixture.test/inline");
    try {
      expect(await createSliderCaptchaService()(copy.options)).toMatchObject({ status: "UNSUPPORTED_PAGE", slides: 0 });
      expect(await copy.evaluate("window.downs")).toBe(0);
    } finally { await copy.close(); }
    const plain = await page("https://account.alibabacloud.com/plain");
    try { expect(await createSliderCaptchaService()(plain.options)).toMatchObject({ status: "NO_CHALLENGE", slides: 0 }); } finally { await plain.close(); }
    let checks = 0;
    const held = await page("https://account.alibabacloud.com/inline", async () => { if (++checks > 1) throw new Error("An operator holds browser control."); });
    try {
      await expect(createSliderCaptchaService()(held.options)).rejects.toThrow(/operator holds/);
      expect(await held.evaluate("[window.downs, document.querySelector('.btn_slide').style.left]")).toEqual([0, "0px"]);
    } finally { await held.close(); }
  }, 40_000);
});
