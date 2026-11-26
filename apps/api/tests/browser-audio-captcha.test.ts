import { createServer } from "node:https";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spaceAudioCaptchaCommandSchema, spaceCliBrowserCommandRequestSchema } from "@space/contracts";
import { CdpClient } from "../src/browser-sessions.js";
import { captchaDigits, createAudioCaptchaService, transcribeCaptchaAudio, type CaptchaTranscriber } from "../src/browser-audio-captcha.js";
import type { SpaceApiConfig } from "../src/config.js";

const endpoint = vi.hoisted(() => ({ url: "" }));
vi.mock("../src/cli-browser-cdp.js", () => ({ activeTabProfilePath: async () => "/owned/fixture", readChromeAutomationEndpoint: async () => endpoint.url }));
const voice = vi.hoisted(() => ({ keys: {} as Record<string, string>, senseVoiceUp: false }));
vi.mock("../src/voice-transcription.js", () => ({
  resolveLiveAudioCredentials: async (_config: unknown, provider: string) => voice.keys[provider] ? { configured: true, apiKey: voice.keys[provider] } : { configured: false, missingReason: "no key" },
  isLocalSenseVoiceUp: async () => voice.senseVoiceUp
}));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("NetEase audio CAPTCHA boundaries", () => {
  it("reads digits from numerals, English and Chinese number words", () => {
    expect(captchaDigits("four eight two one")).toBe("4821");
    expect(captchaDigits("Seven, three, oh, five.")).toBe("7305");
    expect(captchaDigits("4 8 2 1")).toBe("4821");
    expect(captchaDigits("四八二一")).toBe("4821");
    expect(captchaDigits("幺两零九")).toBe("1209");
    expect(captchaDigits("I cannot hear anything")).toBe("");
  });
  it("takes a strict command with nothing but an optional pageId", () => {
    expect(spaceCliBrowserCommandRequestSchema.safeParse({ targetPaneId: "pane:owned", command: { type: "AUDIO_CAPTCHA" } }).success).toBe(true);
    expect(spaceAudioCaptchaCommandSchema.safeParse({ type: "AUDIO_CAPTCHA", pageId: "page-1" }).success).toBe(true);
    for (const extra of [{ answer: "4821" }, { url: "https://evil.test/clip.mp3" }, { selector: ".yidun_voice__input" }]) {
      expect(spaceAudioCaptchaCommandSchema.safeParse({ type: "AUDIO_CAPTCHA", ...extra }).success).toBe(false);
    }
  });
  it("falls back from an unpaid Gemini key to the Vercel AI Gateway, sending the clip as a file part, before SenseVoice", async () => {
    const config = { googleVoiceBaseUrl: "https://generativelanguage.googleapis.com", vercelVoiceBaseUrl: "https://ai-gateway.vercel.sh", voiceTranscriptionTimeoutMs: 1_000 } as SpaceApiConfig;
    const calls: { url: string; body: { model: string; messages: { content: Record<string, unknown>[] }[] } }[] = [];
    let vercel = 200;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.includes("googleapis")) return new Response("{}", { status: 402 });
      return new Response(JSON.stringify({ choices: [{ message: { content: " 4821 " } }] }), { status: vercel });
    }));
    voice.keys = { google: "fixture-google-key", vercel: "fixture-vercel-key" };
    try {
      expect(await transcribeCaptchaAudio(config, Buffer.from("ID3 fixture clip"))).toEqual({ text: "4821", via: "vercel" });
      expect(calls.map(call => [call.url, call.body.model])).toEqual([["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "gemini-3.6-flash"],
        ["https://ai-gateway.vercel.sh/v1/chat/completions", "google/gemini-2.5-flash"]]);
      expect(calls[1]!.body.messages[0]!.content[1]).toEqual({ type: "file", file: { data: Buffer.from("ID3 fixture clip").toString("base64"), media_type: "audio/mpeg", filename: "clip.mp3" } });
      vercel = 403;
      await expect(transcribeCaptchaAudio(config, Buffer.from("RIFF fixture"))).rejects.toThrow("Gemini answered HTTP 402; Vercel AI Gateway answered HTTP 403; local SenseVoice is not running");
      expect(calls[3]!.body.messages[0]!.content[1]).toMatchObject({ file: { media_type: "audio/wav", filename: "clip.wav" } });
    } finally { vi.unstubAllGlobals(); voice.keys = {}; }
  });
});

// A NetEase Yidun voice widget: trusted clicks and Enter only; the first `reject` answers fail and keep the same clip until its
// refresh is pressed. `image` starts in the image mode with the voice switch; in `frame` a success closes the popup.
const CODES = ["four eight two one", "seven three oh five", "one nine six four", "five five zero two"];
function widget(reject: number, image: boolean, frame: boolean, reload = false) {
  return `<div class="yidun yidun--popup"><div class="yidun_panel"><button class="yidun_top__audio" ${image ? "" : "style=display:none"}>voice</button>
    <div class="yidun_voice" ${image ? "style=display:none" : ""}><audio class="yidun_audio__source"></audio><button class="yidun_audio__play">play</button>
    <button class="yidun_audio__refresh">refresh</button><input class="yidun_voice__input" type="tel" maxlength="10"></div></div></div><script>
    const digits=${JSON.stringify(CODES.map(captchaDigits))};
    window.n=0; window.plays=0; window.refreshes=0; window.answers=[];
    const root=document.querySelector('.yidun'), audio=root.querySelector('audio'), input=root.querySelector('input');
    const load=()=>{audio.src='https://necaptcha.nosdn.127.net/clip?n='+window.n; input.value='';};
    root.querySelector('.yidun_top__audio').onclick=e=>{if(!e.isTrusted)return; root.querySelector('.yidun_voice').style.display=''; e.target.style.display='none';};
    root.querySelector('.yidun_audio__play').onclick=e=>{if(e.isTrusted)window.plays++;};
    const voice=root.querySelector('.yidun_voice'), next=()=>{window.n++; load();};
    // reload: NetEase hides the voice panel while the next clip loads (longer than the tool's pause after refresh).
    root.querySelector('.yidun_audio__refresh').onclick=e=>{if(!e.isTrusted)return; window.refreshes++;
      ${reload ? "voice.style.display='none'; setTimeout(()=>{voice.style.display=''; next();},2500);" : "next();"}};
    input.addEventListener('keydown',e=>{if(e.key!=='Enter'||!e.isTrusted)return; window.answers.push(input.value);
      if(window.answers.length>${reject}&&input.value===digits[window.n%digits.length]){root.classList.add('yidun--success');${frame ? "setTimeout(()=>root.style.display='none',300);" : ""}}
      else{root.classList.add('yidun--error'); setTimeout(()=>root.classList.remove('yidun--error'),600);}});
    load();
  </script>`;
}
function fixture(url: URL) {
  const reject = Number(url.searchParams.get("reject") ?? 0), image = url.searchParams.has("image"), reload = url.searchParams.has("reload");
  if (url.pathname === "/widget") return `<body>${widget(reject, image, true)}`;
  const site = `<input type=password value="private-fixture-password"><form onsubmit="window.siteSubmits++;return false"><button>Get code</button></form><script>window.siteSubmits=0;</script>`;
  if (url.pathname === "/frame") return `<body>${site}<iframe src="https://c.dun.163.com/widget?${url.searchParams}" style="width:400px;height:300px;border:0"></iframe>`;
  if (url.pathname === "/plain") return `<body>${site}`;
  return `<body>${site}${widget(reject, image, false, reload)}`;
}
// The stub "hears" the clip's bytes; `unclear` clip numbers come back as noise.
const hear = (unclear: number[] = []): CaptchaTranscriber => async (_config, audio) => {
  const words = audio.subarray(4).toString("latin1");
  return { text: unclear.includes(CODES.indexOf(words)) ? "hello" : words, via: "local-sensevoice" };
};

// Owned HTTPS and Chrome only. Never connects to NetEase, Huawei or an operator profile.
describe.skipIf(process.env.SPACE_AUDIO_CAPTCHA_BROWSER_PROOF !== "1")("NetEase audio CAPTCHA in real Chrome", () => {
  let dir = "", chrome: ChildProcess | undefined, cdp: CdpClient, chromeError = "", clipFetches = 0;
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    // Chrome's singleton socket must fit sockaddr_un's 108-byte path.
    const base = "/var/lib/spaceapp-user/agent-workspace/active/audiocaptcha";
    await mkdir(base, { recursive: true }); dir = await mkdtemp(`${base}/chrome-`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key`, "-out", `${dir}/cert`, "-days", "1", "-subj", "/CN=fixture"], { stdio: "ignore" });
    server = createServer({ key: await readFile(`${dir}/key`), cert: await readFile(`${dir}/cert`) }, (req, res) => {
      const url = new URL(req.url ?? "/", "https://fixture.test");
      if (url.pathname === "/clip") {
        clipFetches++;
        res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(Buffer.from(`RIFF${CODES[Number(url.searchParams.get("n")) % CODES.length]}`, "latin1")); return;
      }
      res.writeHead(200, { "content-type": "text/html" }); res.end(fixture(url));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    chrome = spawn("/usr/bin/google-chrome", ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--disable-background-networking", "--site-per-process", "--ignore-certificate-errors", "--window-size=1100,900", "--mute-audio",
      `--host-resolver-rules=MAP id.huawei.com 127.0.0.1:${port}, MAP c.dun.163.com 127.0.0.1:${port}, MAP necaptcha.nosdn.127.net 127.0.0.1:${port}`,
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
    await sleep(1_000);
    const options = { config: {}, pane: { id: "pane:owned" }, command: {}, checkControl,
      session: { sessionId: "browser:owned", activePageId: targetId, pages: [{ pageId: targetId }] } } as unknown as Parameters<ReturnType<typeof createAudioCaptchaService>>[0];
    const frame = async () => (await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets", {})).targetInfos.find(t => t.type === "iframe");
    // `inFrame` reads the widget's window inside the cross-site popup frame.
    const evaluate = async (expression: string, inFrame = false) => {
      let sid = sessionId;
      if (inFrame) sid = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: (await frame())!.targetId, flatten: true })).sessionId;
      return (await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, sid)).result.value;
    };
    const close = () => cdp.send("Target.closeTarget", { targetId });
    return { options, evaluate, frame, close };
  }

  it("answers the voice challenge in a cross-site popup frame, refreshes after a wrong answer, and returns only a status", async () => {
    const p = await page("https://id.huawei.com/frame?reject=1");
    try {
      const result = await createAudioCaptchaService(undefined, hear())(p.options);
      expect(result).toMatchObject({ status: "CLEARED", cleared: true, attempts: 2, via: "local-sensevoice" });
      expect(Object.keys(result).sort()).toEqual(["attempts", "cleared", "message", "status", "via"]);
      expect(JSON.stringify(result)).not.toMatch(/private-fixture-password|4821|7305|nosdn|clip/);
      expect(await p.evaluate("[window.answers, window.plays, window.refreshes, getComputedStyle(document.querySelector('.yidun')).display]", true)).toEqual([["4821", "7305"], 2, 1, "none"]);
      expect(await p.evaluate("window.siteSubmits")).toBe(0);
    } finally { await p.close(); }
  }, 60_000);

  it("switches an image challenge to voice, skips an unclear clip without answering it, and then reports the verified widget", async () => {
    const p = await page("https://id.huawei.com/inline?image=1"), solve = createAudioCaptchaService(undefined, hear([0]));
    try {
      expect(await solve(p.options)).toMatchObject({ status: "CLEARED", attempts: 2 });
      expect(await p.evaluate("[window.answers, window.refreshes]")).toEqual([["7305"], 1]);
      expect(await solve(p.options)).toMatchObject({ status: "CLEARED", attempts: 0 });
      expect(await p.evaluate("window.answers.length")).toBe(1);
    } finally { await p.close(); }
  }, 60_000);

  it("waits while the voice panel reloads between clips instead of calling it a challenge without voice", async () => {
    const p = await page("https://id.huawei.com/inline?reject=1&reload=1");
    try {
      expect(await createAudioCaptchaService(undefined, hear())(p.options)).toMatchObject({ status: "CLEARED", attempts: 2 });
      expect(await p.evaluate("[window.answers, window.refreshes]")).toEqual([["4821", "7305"], 1]);
    } finally { await p.close(); }
  }, 60_000);

  it("stops after three clips without an accepted answer and hands off", async () => {
    const p = await page("https://id.huawei.com/inline?reject=9");
    try {
      expect(await createAudioCaptchaService(undefined, hear())(p.options)).toMatchObject({ status: "REJECTED", cleared: false, attempts: 3 });
      expect(await p.evaluate("[window.answers, window.refreshes]")).toEqual([["4821", "7305", "1964"], 2]);
    } finally { await p.close(); }
  }, 90_000);

  it("touches nothing on a page without the CAPTCHA, when transcription fails, or after the operator takes control", async () => {
    const plain = await page("https://id.huawei.com/plain");
    try { expect(await createAudioCaptchaService(undefined, hear())(plain.options)).toMatchObject({ status: "NO_CHALLENGE", attempts: 0 }); } finally { await plain.close(); }
    const deaf = await page("https://id.huawei.com/inline");
    try {
      const result = await createAudioCaptchaService(undefined, async () => { throw new Error("Gemini answered HTTP 402; local SenseVoice is not running"); })(deaf.options);
      expect(result).toMatchObject({ status: "TRANSCRIPTION_FAILED", cleared: false, attempts: 1 });
      expect(result.message).toContain("HTTP 402");
      expect(await deaf.evaluate("window.answers.length")).toBe(0);
    } finally { await deaf.close(); }
    const before = clipFetches;
    let checks = 0;
    const held = await page("https://id.huawei.com/inline", async () => { if (++checks > 1) throw new Error("An operator holds browser control."); });
    try {
      await expect(createAudioCaptchaService(undefined, hear())(held.options)).rejects.toThrow(/operator holds/);
      expect(await held.evaluate("[window.answers.length, window.plays]")).toEqual([0, 0]);
      expect(clipFetches - before).toBeLessThanOrEqual(1); // the page's own <audio> preload, never the tool's
    } finally { await held.close(); }
  }, 60_000);
});
