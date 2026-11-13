import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { CdpClient } from "./browser-sessions.js";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import type { SpaceApiConfig } from "./config.js";

type Client = Pick<CdpClient, "send" | "close">;
type Frame = { frame: { id: string; url: string }; childFrames?: Frame[] };
type Box = { x: number; y: number; w: number; h: number; objectId: string };
type State = "SLIDER" | "RETRY" | "VERIFIED" | "OTHER" | "NONE" | "BUSY";
type Options = { config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">; pane: Pane; session: PaneBrowserSession;
  command: { pageId?: string }; checkControl: () => Promise<void> };

// Alibaba's own anti-abuse: every rejected slide raises the session's risk score and a few in a row block it. Not a Space quota.
const MAX_SLIDES = 3;
// Three slides with their retries take ~25 s; this bounds a stuck browser. space-browser-mcp.mjs waits 75 s.
const OPERATION_MS = 60_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const between = (min: number, max: number) => min + Math.random() * (max - min);

/** Alibaba Cloud / Aliyun pages and their same-site frames (the baxia `_____tmd_____/punish` frame carries the slider). */
export function alibabaSliderPage(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && !url.username && !url.password && /(^|\.)(alibabacloud|aliyun)\.com$/.test(url.hostname);
  } catch { return false; }
}

// Alibaba NoCaptcha ("nc_") markup: knob .btn_slide in the track .nc_scale; a rejection replaces it with ".errloading" "Click to retry".
const KNOB = "document.querySelector('.nc_wrapper .nc_scale .btn_slide')";
const TRACK = "document.querySelector('.nc_wrapper .nc_scale')";
const RETRY = "[...document.querySelectorAll('.errloading')].find(el => el.getClientRects().length && /retry|刷新|重试/i.test(el.textContent || ''))";
const OBSERVE = `(() => {
  const knob = ${KNOB}, shown = !!knob && knob.getClientRects().length > 0 && getComputedStyle(knob).visibility !== 'hidden';
  if (shown && !knob.classList.contains('btn_ok')) return 'SLIDER';
  if (${RETRY}) return 'RETRY';
  if (knob?.classList.contains('btn_ok')) return 'VERIFIED';
  return document.querySelector('.nc_wrapper') || location.pathname.includes('_____tmd_____/punish') ? 'OTHER' : 'NONE';
})()`;
const UNCOVERED = "function() { const r = this.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === this || this.contains(hit)); }";

/** API-owned, fixed operation: drags the Alibaba slider in the active tab like a person would and returns only a status.
 * No selectors, URLs, page text or images go in or out, so a Vault-fenced pane may run it like a click. */
export function createSliderCaptchaService(connect: (endpoint: string, timeoutMs: number) => Promise<Client> = CdpClient.connect) {
  const running = new Set<string>();
  return async ({ config, pane, session, command, checkControl }: Options) => {
    const started = Date.now(), page = session.activePageId;
    if (!page || !session.pages.some(tab => tab.pageId === page) || (command.pageId && command.pageId !== page)) throw new SpaceConflictError("The active browser tab is unavailable or differs from pageId.");
    if (running.has(pane.id)) throw new SpaceConflictError("A slider CAPTCHA operation is already running in this pane.");
    running.add(pane.id);
    let client: Client | undefined, top: string | undefined, pressed: { x: number; y: number } | null = null, slides = 0;
    const result = (status: string, message: string) => ({ status, cleared: status === "CLEARED", slides, message });
    try {
      await checkControl();
      const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, session));
      if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
      client = await connect(endpoint, 3_000);
      const cdp = client;
      const sid = top = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page, flatten: true })).sessionId;
      const tree = async () => (await cdp.send<{ frameTree: Frame }>("Page.getFrameTree", {}, sid)).frameTree;
      if (!alibabaSliderPage((await tree()).frame.url)) return result("UNSUPPORTED_PAGE", "This handler supports only the Alibaba Cloud / Aliyun \"Please slide to verify\" slider.");

      // shortcut: same-process frames only (Page.getFrameTree), upgrade when Alibaba serves the slider from another site (OOPIF).
      const find = async (): Promise<{ state: State; context?: number }> => {
        const frames: Frame[] = [], walk = (frame: Frame) => { frames.push(frame); frame.childFrames?.forEach(walk); };
        walk(await tree());
        let busy = false;
        for (const frame of frames.filter(f => alibabaSliderPage(f.frame.url))) {
          try {
            const context = (await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frame.frame.id, worldName: "space-slider-captcha" }, sid)).executionContextId;
            const state = (await cdp.send<{ result?: { value?: State } }>("Runtime.evaluate", { expression: OBSERVE, contextId: context, returnByValue: true, silent: true }, sid)).result?.value;
            if (!state) busy = true;
            else if (state !== "NONE") return { state, context };
          } catch { busy = true; } // A frame mid-navigation has no document yet.
        }
        return { state: busy ? "BUSY" : "NONE" };
      };
      const box = async (context: number, expression: string): Promise<Box> => {
        const objectId = (await cdp.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression, contextId: context, silent: true }, sid)).result.objectId;
        if (!objectId) throw new SpaceConflictError("The slider changed while it was measured; run the tool again.");
        await cdp.send("DOM.scrollIntoViewIfNeeded", { objectId }, sid).catch(() => undefined);
        const q = (await cdp.send<{ model: { border: number[] } }>("DOM.getBoxModel", { objectId }, sid)).model.border;
        const uncovered = (await cdp.send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", { objectId, functionDeclaration: UNCOVERED, returnByValue: true }, sid)).result.value;
        if (!uncovered) throw new SpaceConflictError("The slider is covered by something else on the page; hand it to the operator.");
        return { x: q[0]!, y: q[1]!, w: q[2]! - q[0]!, h: q[5]! - q[1]!, objectId };
      };
      const send = (type: string, x: number, y: number, buttons: number) => cdp.send("Input.dispatchMouseEvent", { type, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
        button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1, ...(buttons ? { force: 0.5 } : {}) }, sid);
      const press = async (x: number, y: number) => { await checkControl(); pressed = { x, y }; await send("mousePressed", x, y, 1); };
      const release = async (x: number, y: number) => { pressed = null; await send("mouseReleased", x, y, 0); };
      const approach = async (x: number, y: number) => {
        const sx = x - between(80, 140), sy = y + between(40, 70);
        for (let i = 1; i <= 14; i++) { const p = i / 14, e = p * p * (3 - 2 * p); void send("mouseMoved", sx + (x - sx) * e, sy + (y - sy) * e, 0).catch(() => undefined); await sleep(between(14, 20)); }
        await sleep(between(180, 380));
      };
      // Each CDP input acknowledgement takes ~80 ms on a loaded host; awaiting every move stretched a slide to 4-9 s, which Alibaba
      // rejected every time (7/7, 13/11). Moves go out on a 16 ms cadence and are awaited together, as a ~0.9 s human slide.
      const slide = async (knob: Box, track: Box) => {
        const x = knob.x + knob.w / 2 + between(-4, 4), y = knob.y + knob.h / 2 + between(-4, 4);
        await approach(x, y);
        await press(x, y);
        await sleep(between(90, 210));
        const end = track.x + track.w - knob.w / 2 + between(4, 10), steps = Math.round(900 / 16), moves: Promise<unknown>[] = [];
        let drift = 0;
        for (let i = 1; i <= steps; i++) {
          const p = i / steps, eased = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
          drift += between(-0.4, 0.4);
          moves.push(send("mouseMoved", x + (end - x) * eased, y + drift, 1));
          await sleep(between(14, 20));
        }
        for (let i = 1; i <= 4; i++) { moves.push(send("mouseMoved", end - i, y + drift, 1)); await sleep(between(20, 40)); }
        await Promise.all(moves);
        await sleep(between(120, 270));
        await release(end - 4, y + drift);
      };

      let last: State | undefined, repeats = 0;
      while (Date.now() - started < OPERATION_MS) {
        const { state, context } = await find();
        repeats = state === last ? repeats + 1 : 1; last = state;
        if (state === "BUSY") { await sleep(500); continue; }
        if (state === "NONE" || state === "VERIFIED" || state === "OTHER") {
          // Two looks a second apart, so a frame that is reloading is not read as a result.
          if (repeats < 2) { await sleep(1_000); continue; }
          if (state === "OTHER") return result("UNSUPPORTED_CHALLENGE", "Alibaba shows a verification other than the slider. Hand it to the operator; nothing more was dragged.");
          return slides ? result("CLEARED", "The Alibaba slider was cleared in this tab. Re-snapshot and continue the original task; the site's next step is not confirmed by this tool.")
            : result("NO_CHALLENGE", "No Alibaba slider is showing in the active tab; nothing was dragged.");
        }
        if (slides >= MAX_SLIDES) return result("REJECTED", `Alibaba rejected ${slides} slides. Hand it to the operator; do not run the tool again on this page soon, repeated slides get the session blocked.`);
        if (state === "RETRY") {
          const retry = await box(context!, RETRY), x = retry.x + retry.w / 2, y = retry.y + retry.h / 2;
          await approach(x, y);
          await press(x, y);
          await sleep(between(60, 120));
          await release(x, y);
          await sleep(2_500);
          continue;
        }
        const knob = await box(context!, KNOB), track = await box(context!, TRACK);
        slides++;
        await slide(knob, track);
        // Alibaba checks the slide server-side; give it time before reading the result.
        for (let i = 0; i < 12 && (await find()).state === "SLIDER"; i++) await sleep(500);
      }
      return result("TIMEOUT", "The slider did not settle in time; no clearance is confirmed. Re-snapshot before anything else.");
    } finally {
      if (client) {
        const held = pressed as { x: number; y: number } | null;
        if (held && top) await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: held.x, y: held.y, button: "left", buttons: 0, clickCount: 1 }, top).catch(() => undefined);
        if (top) await client.send("Target.detachFromTarget", { sessionId: top }).catch(() => undefined);
        client.close();
      }
      running.delete(pane.id);
    }
  };
}
