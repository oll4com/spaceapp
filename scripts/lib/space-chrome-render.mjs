// Headless Chrome over the DevTools Protocol, shared by the Media Studio engine (scripts/space-media-capture.mjs) and the
// Design pane renderer (scripts/space-design-render.mjs): start Chrome, and render an HTML document at an exact size.
import { childProcessEnv } from "../../packages/runtime/dist/child-process-env.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A minimal Chrome DevTools Protocol client (the space-dots-home-check pattern). `scale`: the window's real device scale,
 * which Page.startScreencast frames follow (an emulated scale alone gives frames at CSS size).
 */
export async function startChrome(profileDir, { scale } = {}) {
  // A killed caller (an MCP server whose session ended, a timed-out test) never reaches close(): the parent-death signal
  // takes Chrome with it (App Studio preview Chromes outlived their server for a day, 2026-10-19). setpriv is util-linux.
  const command = ["/usr/bin/google-chrome", "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "--force-color-profile=srgb", "--window-size=1920,1080", ...(scale ? [`--force-device-scale-factor=${scale}`] : []), "about:blank"];
  const options = { env: { ...childProcessEnv(), TMPDIR: tmpdir() }, stdio: "ignore" };
  const chrome = existsSync("/usr/bin/setpriv") ? spawn("/usr/bin/setpriv", ["--pdeathsig", "KILL", "--", ...command], options) : spawn(command[0], command.slice(1), options);
  let endpoint = null;
  for (let i = 0; i < 100 && !endpoint; i++) {
    await sleep(100);
    const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "")).split("\n");
    if (lines[0] && lines[1]) endpoint = `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
  }
  if (!endpoint) { chrome.kill("SIGKILL"); throw new Error("Chrome did not start."); }
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("The DevTools connection failed.")); });
  let next = 0;
  const pending = new Map();
  const handlers = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      if (message.error) reject(new Error(`CDP ${message.error.message}`)); else resolve(message.result);
      return;
    }
    handlers.get(message.method)?.(message.params, message.sessionId);
  };
  const on = (method, handler) => handlers.set(method, handler);
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = async () => { try { socket.close(); } catch { /* closed */ } chrome.kill("SIGKILL"); await sleep(300); };
  return { send, on, close };
}

/**
 * Renders an HTML document at exactly width x height CSS pixels (device scale 1) and returns the image bytes.
 * `isolated`: no script runs and every network request fails (data: URLs never reach the network), so the document
 * shows only what it carries inline. `fitWithin` (a selector): while anything inside that box sticks out of it, the
 * document's `--fit` factor shrinks by 12% (at most 8 steps); the measuring runs from DevTools, never as page script.
 * Returns the requests it blocked, the fit factor used and whether something still overflows.
 */
export async function renderHtml(chrome, { html, width, height, format = "png", quality, isolated = false, settleMs = 800, fitWithin = null }) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const blocked = [];
  try {
    const { sessionId: sid } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    await chrome.send("Page.enable", {}, sid);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sid);
    if (isolated) {
      await chrome.send("Emulation.setScriptExecutionDisabled", { value: true }, sid);
      chrome.on("Fetch.requestPaused", (params, eventSid) => {
        if (eventSid !== sid) return;
        blocked.push(String(params.request?.url ?? "").slice(0, 120));
        void chrome.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sid).catch(() => undefined);
      });
      await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sid);
    }
    const { frameTree } = await chrome.send("Page.getFrameTree", {}, sid);
    await chrome.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, sid);
    await sleep(settleMs);
    // Fonts inlined as data: URLs (Design's Inter) load asynchronously: text is measured and shot only once they are in.
    await chrome.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true }, sid);
    let fit = 1;
    let overflow = false;
    if (fitWithin) {
      const overflows = `(() => { const box = document.querySelector(${JSON.stringify(fitWithin)}); if (!box) return false;
        const outer = box.getBoundingClientRect();
        return [...box.querySelectorAll("*")].some((element) => { const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1 || rect.left < outer.left - 1 || rect.right > outer.right + 1
            || element.scrollWidth > element.clientWidth + 1); }); })()`;
      for (let step = 0; ; step += 1) {
        const { result } = await chrome.send("Runtime.evaluate", { expression: overflows, returnByValue: true }, sid);
        overflow = result?.value === true;
        if (!overflow || step === 8) break;
        fit = Math.round(fit * 0.88 * 1000) / 1000;
        await chrome.send("Runtime.evaluate", { expression: `document.documentElement.style.setProperty("--fit", "${fit}")` }, sid);
        await sleep(100);
      }
    }
    const { data } = await chrome.send("Page.captureScreenshot", { format, ...(quality && format !== "png" ? { quality } : {}),
      clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: false }, sid);
    return { image: Buffer.from(data, "base64"), blocked, fit, overflow };
  } finally {
    await chrome.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/**
 * Loads `url` in a phone-sized tab (App Studio previews): `width` x `height` CSS pixels at device scale `dpr`, mobile and touch on,
 * and the safe areas the device's status bar, cutout and home indicator take (env(safe-area-inset-*), for pages with
 * viewport-fit=cover). Waits for the load event (at most `timeoutMs`), then `settleMs` for the app to render; returns one PNG per screen
 * (`screens`, the first one plus each further screen the page can scroll to).
 */
export async function captureUrl(chrome, { url, width, height, dpr = 2, safeArea = null, settleMs = 1500, timeoutMs = 60_000, screens = 1 }) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  try {
    const { sessionId: sid } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    await chrome.send("Page.enable", {}, sid);
    await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: true }, sid);
    await chrome.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sid);
    // Experimental in DevTools: a Chrome without it previews with zero safe areas.
    if (safeArea) await chrome.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: safeArea.top, bottom: safeArea.bottom, left: 0, right: 0 } }, sid).catch(() => undefined);
    const loaded = new Promise((resolve) => chrome.on("Page.loadEventFired", (_params, eventSid) => { if (eventSid === sid) resolve(true); }));
    await chrome.send("Page.navigate", { url }, sid);
    const ready = await Promise.race([loaded, sleep(timeoutMs).then(() => false)]);
    if (!ready) throw new Error(`The page did not load within ${Math.round(timeoutMs / 1000)} s.`);
    await sleep(settleMs);
    const shots = [];
    for (let screen = 1; screen <= screens; screen += 1) {
      // Screen 2 onwards: the page's main scroller (React Native Web scrolls a view, not the document) one height further.
      if (screen > 1 && !(await scrollToScreen(chrome, sid, screen - 1))) break;
      const { data } = await chrome.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sid);
      shots.push(Buffer.from(data, "base64"));
    }
    return shots;
  } finally {
    await chrome.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

/** Scrolls the largest scrollable element (or the document) to `step` heights down; false once the page cannot scroll that far. */
async function scrollToScreen(chrome, sid, step) {
  const expression = `(() => {
    const root = document.scrollingElement;
    const scrollers = [root, ...document.querySelectorAll("*")].filter((el) => el && el.scrollHeight > el.clientHeight + 4
      && (el === root || /(auto|scroll)/.test(getComputedStyle(el).overflowY)));
    const target = scrollers.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!target) return false;
    const before = target.scrollTop;
    target.scrollTop = target.clientHeight * ${Number(step)};
    return target.scrollTop > before;
  })()`;
  const { result } = await chrome.send("Runtime.evaluate", { expression, returnByValue: true }, sid);
  if (result?.value !== true) return false;
  await sleep(500);
  return true;
}
