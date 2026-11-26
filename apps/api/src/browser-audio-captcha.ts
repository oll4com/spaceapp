import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { WebSocket as WsClient } from "ws";
import { childProcessEnv } from "./child-process-env.js";
import { CdpClient, pressBrowserKey } from "./browser-sessions.js";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import type { SpaceApiConfig } from "./config.js";
import { spawn } from "./safe-child-process.js";
import { senseVoiceRequest } from "./sensevoice-voice-bridge.js";
import { isLocalSenseVoiceUp, resolveLiveAudioCredentials } from "./voice-transcription.js";

type Client = Pick<CdpClient, "send" | "close">;
type Frame = { frame: { id: string; url: string }; childFrames?: Frame[] };
type Observed = { state: "NONE" | "SUCCESS" | "IMAGE" | "OTHER" | "BUSY" }
  | { state: "VOICE"; src: string; duration: number; error: boolean; maxerror: boolean; busy: boolean };
type Found = Observed & { sid?: string; frameId?: string; context?: number };
type Voice = Extract<Observed, { state: "VOICE" }> & { sid: string; frameId: string; context: number };
export type CaptchaTranscript = { text: string; via: "gemini" | "vercel" | "local-sensevoice" };
export type CaptchaTranscriber = (config: SpaceApiConfig, audio: Buffer) => Promise<CaptchaTranscript>;
type Options = { config: SpaceApiConfig; pane: Pane; session: PaneBrowserSession; command: { pageId?: string }; checkControl: () => Promise<void> };

// NetEase counts every wrong answer against the session and locks it (yidun--maxerror) after a few. Not a Space quota.
const MAX_ANSWERS = 3;
// Three clips with download, transcription and listening take ~45 s; this bounds a stuck browser. space-browser-mcp.mjs waits 110 s.
const OPERATION_MS = 90_000;
// Technical bound: a spoken code is a few seconds of mp3 (~50 KB); anything this large is not a CAPTCHA clip.
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const WORLD = "space-audio-captcha";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

// NetEase Yidun (public core v2.28.5): the voice mode is .yidun_voice with audio.yidun_audio__source, .yidun_audio__play and
// input.yidun_voice__input, where Enter submits; image modes offer .yidun_top__audio ("switch to voice"). State classes sit on .yidun.
const SHOWN = "const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';";
const ROOT = "[...document.querySelectorAll('.yidun')].find(shown)";
const OBSERVE = `(() => { ${SHOWN}
  const root = ${ROOT};
  if (!root) return { state: 'NONE' };
  const c = root.classList;
  if (c.contains('yidun--success')) return { state: 'SUCCESS' };
  const audio = root.querySelector('audio.yidun_audio__source'), input = root.querySelector('input.yidun_voice__input');
  if (shown(root.querySelector('.yidun_voice')) && audio && shown(input)) return { state: 'VOICE', src: audio.currentSrc || audio.src || '',
    duration: Number.isFinite(audio.duration) ? audio.duration : 0, error: c.contains('yidun--error'), maxerror: c.contains('yidun--maxerror'),
    busy: c.contains('yidun--verifying') || c.contains('yidun--loading') };
  return { state: shown(root.querySelector('.yidun_top__audio')) ? 'IMAGE' : 'OTHER' };
})()`;
const FOCUS = (selector: string) => `(() => { ${SHOWN}
  const root = ${ROOT}, el = root && [...root.querySelectorAll(${JSON.stringify(selector)})].find(shown);
  if (!el || el.disabled) return false;
  el.focus();
  return document.activeElement === el;
})()`;

const NUMBER_WORDS: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4",
  five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9", 零: "0", 〇: "0", 一: "1", 幺: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6",
  七: "7", 八: "8", 九: "9" };
/** The digits a transcript names, whether written as numerals, English words or Chinese numerals. */
export function captchaDigits(text: string) {
  return text.toLowerCase().replace(/[a-z]+|[零〇一幺二两三四五六七八九]/g, word => NUMBER_WORDS[word] ?? "").replace(/\D/g, "");
}

const PROMPT = "This is an audio CAPTCHA that reads out a code. Reply with only the digits spoken, in order, as numerals, and nothing else.";
/** Gemini through the Live voice key, then the Vercel AI Gateway, then the local SenseVoice daemon; all are voice-transcription.ts's own routes. */
export const transcribeCaptchaAudio: CaptchaTranscriber = async (config, audio) => {
  const failures: string[] = [];
  const wav = audio.subarray(0, 4).toString("latin1") === "RIFF", data = audio.toString("base64");
  const vercelBase = (config.vercelVoiceBaseUrl || "https://ai-gateway.vercel.sh").replace(/\/+$/, "");
  const routes = [
    { via: "gemini" as const, name: "Gemini", credentials: await resolveLiveAudioCredentials(config, "google"),
      url: `${config.googleVoiceBaseUrl.replace(/\/+$/, "")}/v1beta/openai/chat/completions`, model: "gemini-3.6-flash",
      audio: { type: "input_audio", input_audio: { data, format: wav ? "wav" : "mp3" } } },
    // The gateway rejects input_audio and takes audio as a file part; its free tier serves gemini-2.5-flash, not 3.x (probe 16/11).
    { via: "vercel" as const, name: "Vercel AI Gateway", credentials: await resolveLiveAudioCredentials(config, "vercel"),
      url: vercelBase.endsWith("/v1") ? `${vercelBase}/chat/completions` : `${vercelBase}/v1/chat/completions`, model: "google/gemini-2.5-flash",
      audio: { type: "file", file: { data, media_type: wav ? "audio/wav" : "audio/mpeg", filename: wav ? "clip.wav" : "clip.mp3" } } }
  ];
  for (const route of routes) {
    if (!route.credentials.apiKey) { failures.push(`${route.name} is unavailable (${route.credentials.missingReason ?? "no key"})`); continue; }
    try {
      const response = await fetch(route.url, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${route.credentials.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: route.model, messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, route.audio] }] }),
        signal: AbortSignal.timeout(config.voiceTranscriptionTimeoutMs || 15_000) });
      const text = response.ok ? ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content?.trim() : "";
      if (text) return { text, via: route.via };
      failures.push(`${route.name} answered HTTP ${response.status}`);
    } catch (error) { failures.push(`${route.name} failed (${error instanceof Error ? error.name : "error"})`); }
  }
  if (await isLocalSenseVoiceUp(config)) {
    try { return { text: await senseVoice(config.localSenseVoiceUrl, await pcm16k(audio)), via: "local-sensevoice" }; }
    catch (error) { failures.push(`local SenseVoice failed (${error instanceof Error ? error.message : "error"})`); }
  } else failures.push("local SenseVoice is not running");
  throw new Error(failures.join("; "));
};

/** Mono 16 kHz float samples, as SenseVoice takes them. Captcha clips stay under its 10 s clean-decoding bound. */
function pcm16k(audio: Buffer) {
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"], { stdio: ["pipe", "pipe", "ignore"], env: childProcessEnv() });
    const chunks: Buffer[] = [], timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      if (code !== 0 || out.length < 4) { reject(new Error(`ffmpeg could not decode the clip (exit ${code})`)); return; }
      resolve(new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + (out.length & ~3))));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(audio);
  });
}

function senseVoice(url: string, samples: Float32Array) {
  return new Promise<string>((resolve, reject) => {
    const ws = new WsClient(url, { maxPayload: 1024 * 1024, handshakeTimeout: 5_000 });
    const finish = (settle: () => void) => { clearTimeout(timer); ws.removeAllListeners(); ws.on("error", () => undefined); ws.terminate(); settle(); };
    const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), 15_000);
    ws.on("open", () => ws.send(senseVoiceRequest(16_000, samples)));
    ws.on("message", (data, isBinary) => {
      let text: unknown;
      try { text = isBinary ? null : (JSON.parse(data.toString()) as { text?: unknown }).text; } catch { text = null; }
      finish(() => typeof text === "string" ? resolve(text) : reject(new Error("invalid reply")));
    });
    ws.on("error", () => finish(() => reject(new Error("unavailable"))));
  });
}

/** API-owned, fixed operation: answers a NetEase Yidun audio CAPTCHA in the active tab (iframes included) and returns only a status.
 * The clip goes through the browser to transcription and the digits into the CAPTCHA; no transcript, URL or page text comes back,
 * so a Vault-fenced pane may run it like a click. */
export function createAudioCaptchaService(connect: (endpoint: string, timeoutMs: number) => Promise<Client> = CdpClient.connect,
  transcribe: CaptchaTranscriber = transcribeCaptchaAudio) {
  const running = new Set<string>();
  return async ({ config, pane, session, command, checkControl }: Options) => {
    const started = Date.now(), page = session.activePageId;
    if (!page || !session.pages.some(tab => tab.pageId === page) || (command.pageId && command.pageId !== page)) throw new SpaceConflictError("The active browser tab is unavailable or differs from pageId.");
    if (running.has(pane.id)) throw new SpaceConflictError("An audio CAPTCHA operation is already running in this pane.");
    running.add(pane.id);
    let client: Client | undefined, top: string | undefined, attempts = 0, via: CaptchaTranscript["via"] | undefined;
    const attached = new Map<string, string>();
    const result = (status: string, message: string) => ({ status, cleared: status === "CLEARED", attempts, ...(via ? { via } : {}), message });
    try {
      await checkControl();
      const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, session));
      if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
      client = await connect(endpoint, 3_000);
      const cdp = client;
      const sid = top = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page, flatten: true })).sessionId;
      const tree = async (session: string) => (await cdp.send<{ frameTree: Frame }>("Page.getFrameTree", {}, session)).frameTree;

      const find = async (): Promise<Found> => {
        // Cross-site frames (OOPIFs) are missing from their parent's frame tree; Chrome lists them as iframe targets of this page's frames.
        const remote = (await cdp.send<{ targetInfos: { targetId: string; type: string; parentFrameId?: string }[] }>("Target.getTargets", {}))
          .targetInfos.filter(target => target.type === "iframe");
        const remoteIds = new Set(remote.map(target => target.targetId));
        let busy = false;
        const visit = async (frame: Frame, session: string): Promise<Found | null> => {
          try {
            const context = (await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.frame.id, worldName: WORLD }, session)).executionContextId;
            const seen = (await cdp.send<{ result?: { value?: Observed } }>("Runtime.evaluate", { expression: OBSERVE, contextId: context, returnByValue: true, silent: true }, session)).result?.value;
            if (!seen) busy = true;
            else if (seen.state !== "NONE") return { ...seen, sid: session, frameId: frame.frame.id, context };
          } catch { busy = true; } // A frame mid-navigation has no document yet.
          for (const child of (frame.childFrames ?? []).filter(child => !remoteIds.has(child.frame.id))) {
            const hit = await visit(child, session);
            if (hit) return hit;
          }
          for (const target of remote.filter(target => target.parentFrameId === frame.frame.id)) {
            const child = attached.get(target.targetId) ?? (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
            attached.set(target.targetId, child);
            const hit = await visit(await tree(child), child).catch(() => { busy = true; return null; });
            if (hit) return hit;
          }
          return null;
        };
        return await visit(await tree(sid), sid) ?? { state: busy ? "BUSY" : "NONE" };
      };
      let last: Found["state"] | undefined, repeats = 0, switched = false, submitted = false, answered = "", waits = 0;
      const focus = async (found: Found, selector: string) =>
        (await cdp.send<{ result?: { value?: boolean } }>("Runtime.evaluate", { expression: FOCUS(selector), contextId: found.context, returnByValue: true, silent: true }, found.sid)).result?.value === true;
      // Keyboard only: focus and Enter reach a button in any frame without screen coordinates, as trusted input.
      const press = async (found: Found, selector: string) => {
        if (!await focus(found, selector)) return false;
        await checkControl();
        await pressBrowserKey(cdp, found.sid!, "Enter");
        return true;
      };
      // The browser fetches the clip as the page did (never this server: no page-supplied URL leaves the browser), without cookies.
      const download = async (found: Voice) => {
        let url: URL;
        try { url = new URL(found.src); } catch { return null; }
        if (url.protocol !== "https:") return null;
        const { resource } = await cdp.send<{ resource: { success: boolean; httpStatusCode?: number; stream?: string } }>("Network.loadNetworkResource",
          { frameId: found.frameId, url: url.href, options: { disableCache: false, includeCredentials: false } }, found.sid);
        if (!resource.stream) return null;
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          if (!resource.success || (resource.httpStatusCode && resource.httpStatusCode !== 200)) return null;
          for (;;) {
            const part = await cdp.send<{ data: string; eof: boolean; base64Encoded?: boolean }>("IO.read", { handle: resource.stream, size: 65_536 }, found.sid);
            const chunk = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8");
            size += chunk.length;
            if (size > MAX_AUDIO_BYTES) return null;
            chunks.push(chunk);
            if (part.eof) break;
          }
        } finally { await cdp.send("IO.close", { handle: resource.stream }, found.sid).catch(() => undefined); }
        return size ? Buffer.concat(chunks) : null;
      };
      const refresh = async (found: Voice) => {
        if (!await press(found, ".yidun_audio__refresh, .yidun_voice__refresh")) throw new SpaceConflictError("The CAPTCHA's refresh button is unavailable; hand it to the operator.");
        await sleep(1_500);
      };

      while (Date.now() - started < OPERATION_MS) {
        await checkControl();
        const found = await find();
        repeats = found.state === last ? repeats + 1 : 1; last = found.state;
        // Frames that never settle (ads, a frame without a document) count as no challenge after ~3 s.
        if (found.state === "BUSY" && repeats < 6) { await sleep(500); continue; }
        if (found.state === "SUCCESS") return result("CLEARED", "The NetEase audio CAPTCHA accepted the answer. Re-snapshot and continue the original task; the site's next step is not confirmed by this tool.");
        if (found.state === "NONE" || found.state === "BUSY") {
          // Two looks a second apart, so a popup that is reloading is not read as a result.
          if (repeats < 2) { await sleep(1_000); continue; }
          return submitted ? result("CLEARED", "The NetEase CAPTCHA closed after the answer. Re-snapshot and continue the original task; the site's next step is not confirmed by this tool.")
            : result("NO_CHALLENGE", "No NetEase CAPTCHA is showing in the active tab; nothing was typed.");
        }
        if (found.state === "OTHER") {
          // The voice panel hides while NetEase loads the next clip; only a steady OTHER is a challenge without voice.
          if (repeats < 6) { await sleep(500); continue; }
          return result("UNSUPPORTED_CHALLENGE", "NetEase shows a challenge without a voice option. Hand it to the operator; nothing was typed.");
        }
        if (found.state === "IMAGE") {
          if (!switched) { switched = await press(found, ".yidun_top__audio"); await sleep(1_500); continue; }
          if (repeats < 6) { await sleep(500); continue; }
          return result("UNSUPPORTED_CHALLENGE", "NetEase did not open its voice challenge. Hand it to the operator; nothing was typed.");
        }
        const voice = found as Voice;
        if (voice.maxerror) return result("REJECTED", `NetEase locked the CAPTCHA after ${attempts} clip(s). Hand it to the operator; do not run the tool again on this page soon.`);
        // Loading, verifying, or the answered clip still showing: give NetEase time to load a new clip itself, then press its refresh.
        if (voice.busy || !voice.src || voice.error || voice.src === answered) {
          if (++waits < 6) { await sleep(500); continue; }
          waits = 0;
          if (voice.busy || !voice.src) continue;
          if (attempts >= MAX_ANSWERS) return result("REJECTED", `NetEase accepted no answer in ${attempts} clip(s). Hand it to the operator; do not run the tool again on this page soon, repeated answers lock the session.`);
          await refresh(voice);
          continue;
        }
        waits = 0;
        if (attempts >= MAX_ANSWERS) return result("REJECTED", `NetEase accepted no answer in ${attempts} clip(s). Hand it to the operator; do not run the tool again on this page soon, repeated answers lock the session.`);
        attempts++;
        // Play first, as a person would: NetEase times the answer from the play press.
        await press(voice, ".yidun_audio__play");
        const played = Date.now(), audio = await download(voice);
        if (!audio) return result("AUDIO_UNAVAILABLE", "The CAPTCHA's audio clip could not be read through the browser. Hand it to the operator; nothing was typed.");
        let digits = "";
        try {
          const heard = await transcribe(config, audio);
          via = heard.via;
          digits = captchaDigits(heard.text);
        } catch (error) {
          return result("TRANSCRIPTION_FAILED", `The clip could not be transcribed: ${error instanceof Error ? error.message : "unknown error"}. Hand it to the operator; nothing was typed.`);
        }
        // An unclear clip: ask for another rather than spend a wrong answer.
        if (digits.length < 3 || digits.length > 10) { answered = voice.src; await refresh(voice); continue; }
        await sleep(Math.max(0, played + Math.min(voice.duration, 20) * 1_000 + between(600, 1_400) - Date.now()));
        const current = await find();
        if (current.state !== "VOICE" || current.src !== voice.src) continue;
        if (!await focus(current, "input.yidun_voice__input")) throw new SpaceConflictError("The CAPTCHA's answer field could not be focused; hand it to the operator.");
        await checkControl();
        await pressBrowserKey(cdp, current.sid!, "Control+A");
        await pressBrowserKey(cdp, current.sid!, "Backspace");
        await cdp.send("Input.insertText", { text: digits }, current.sid);
        await sleep(between(250, 600));
        await pressBrowserKey(cdp, current.sid!, "Enter");
        answered = voice.src;
        submitted = true;
        for (let i = 0; i < 16; i++) {
          await sleep(500);
          const now = await find();
          if (now.state !== "VOICE" || now.error || now.maxerror || now.src !== answered) break;
        }
      }
      return result("TIMEOUT", "The CAPTCHA did not settle in time; no clearance is confirmed. Re-snapshot before anything else.");
    } finally {
      if (client) {
        for (const session of attached.values()) await client.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
        if (top) await client.send("Target.detachFromTarget", { sessionId: top }).catch(() => undefined);
        client.close();
      }
      running.delete(pane.id);
    }
  };
}
