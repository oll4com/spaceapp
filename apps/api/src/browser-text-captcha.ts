import { createHash, randomUUID } from "node:crypto";
import type { Pane, PaneBrowserSession } from "@space/contracts";
import { SpaceConflictError } from "@space/runtime";
import { CdpClient, captureMaskedScreenshot, pressBrowserKey } from "./browser-sessions.js";
import { activeTabProfilePath, readChromeAutomationEndpoint } from "./cli-browser-cdp.js";
import type { SpaceApiConfig } from "./config.js";
import { microsoftCaptchaFrame, microsoftCaptchaPage, TEXT_CAPTCHA_OBSERVE } from "./browser-text-captcha-page.js";

type Client = Pick<CdpClient, "send" | "close">;
type Box = { x: number; y: number; width: number; height: number };
type Candidate = { image: string; input: string; submit: string; box: Box; inputBox: Box; submitBox: Box;
  ready: boolean; disabled: boolean; focused: boolean; rejected: boolean };
type Frame = { frame: { id: string; url: string; loaderId: string }; childFrames?: Frame[] };
type Observed = { candidates: Candidate[]; marker: boolean; width: number; height: number };
type Located = Candidate & { session: string; context: number; frame: string; document: string; offset: Box };
type Snapshot = { candidate: Located; image: string; fingerprint: string };
type Pending = { id: string; session: string; page: string; document: string; fingerprint: string; timer: NodeJS.Timeout };
export type TextCaptchaCommand = { action: "inspect" | "answer"; pageId?: string; checkpoint?: string; answer?: string };
type Options = { config: Pick<SpaceApiConfig, "browserSessionsProfileRoot">; pane: Pane; session: PaneBrowserSession;
  actor: string; command: TextCaptchaCommand; checkControl: () => Promise<void> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// A continuation is short-lived because the provider's image can expire. No attempt/count quota.
const CHECKPOINT_VALID_MS = 5 * 60_000;
// The MCP image-content transport has a 3 MB base64 budget, like the grid helpers.
const MCP_IMAGE_MAX_BASE64 = 3_000_000;
// An answer makes ~150 CDP calls (three snapshots, OOPIF frames); a loaded host takes ~300 ms each (3/11, Azure tenant CAPTCHA).
// Every step re-checks the document, image and control, so this only bounds a stuck browser; space-browser-mcp.mjs waits 110 s.
const OPERATION_MS = 90_000;

/** API-owned, fixed operation. A Vault-fenced page permits only its existing masked viewer.
 * No credentials, field values, page text, selectors, URLs or paths are returned to the caller. */
export function createTextCaptchaService(connect: (endpoint: string, timeoutMs: number) => Promise<Client> = CdpClient.connect) {
  const pending = new Map<string, Pending>();
  const running = new Set<string>();
  const discard = (key: string) => { const entry = pending.get(key); if (entry) clearTimeout(entry.timer); pending.delete(key); };
  return async (options: Options) => {
    const { config, pane, session, actor, command, checkControl } = options;
    const started = Date.now();
    const page = session.activePageId, key = `${pane.id}:${actor}`;
    if (!page || !session.pages.some(tab => tab.pageId === page) || (command.pageId && command.pageId !== page)) throw new SpaceConflictError("The active browser tab is unavailable or differs from pageId.");
    if (running.has(pane.id)) throw new SpaceConflictError("A text CAPTCHA operation is already running in this pane.");
    const prior = pending.get(key);
    if (command.action === "answer" && (!prior || prior.id !== command.checkpoint || prior.session !== session.sessionId || prior.page !== page)) {
      throw new SpaceConflictError("The CAPTCHA checkpoint expired, was used, or belongs to another page/session. Inspect again.");
    }
    running.add(pane.id);
    let client: Client | undefined, top: string | undefined;
    const attached = new Map<string, string>();
    const result = (status: string, extra: Record<string, unknown> = {}) => ({ status, verified: false, ...extra });
    try {
      await checkControl();
      const endpoint = await readChromeAutomationEndpoint(await activeTabProfilePath(config.browserSessionsProfileRoot, pane, session));
      if (!endpoint) throw new SpaceConflictError("The browser's live connection is unavailable.");
      client = await connect(endpoint, 3_000);
      const cdp = client;
      top = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page, flatten: true })).sessionId;
      const topSession = top;
      const evaluate = async <T>(sid: string, context: number, expression: string): Promise<T> => {
        const reply = await cdp.send<{ exceptionDetails?: unknown; result?: { value?: T } }>("Runtime.evaluate",
          { expression, contextId: context, returnByValue: true, silent: true }, sid);
        if (reply.exceptionDetails || reply.result?.value === undefined) throw new SpaceConflictError("The CAPTCHA document changed; inspect again.");
        return reply.result.value;
      };
      const world = async (sid: string, frameId: string) => (await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld",
        { frameId, worldName: "space-text-captcha" }, sid)).executionContextId;
      const tree = async () => (await cdp.send<{ frameTree: Frame }>("Page.getFrameTree", {}, topSession)).frameTree;
      const initial = await tree();
      if (!microsoftCaptchaPage(initial.frame.url)) return result("UNSUPPORTED_PAGE", { message: "This handler supports Microsoft Azure and Microsoft account text-image CAPTCHAs." });
      if (command.action === "answer" && prior?.document !== initial.frame.loaderId) {
        discard(key);
        return result("PAGE_CHANGED", { message: "The page changed. Inspect the current challenge before answering." });
      }
      const initialDocument = initial.frame.loaderId;
      const check = async () => {
        if (Date.now() - started >= OPERATION_MS) throw new SpaceConflictError("Text CAPTCHA observation timed out; inspect again. No verification is confirmed.");
        await checkControl();
        const current = await tree();
        if (current.frame.loaderId !== initialDocument || !microsoftCaptchaPage(current.frame.url)) {
          throw new SpaceConflictError("The CAPTCHA page changed; inspect again and verify the site's result separately.");
        }
      };
      const locate = async (): Promise<{ matches: Located[]; marker: boolean }> => {
        await check();
        const current = await tree(), matches: Located[] = [];
        // Cross-site frames (OOPIFs, e.g. Azure's reactblade) are missing from their parent's frame tree; Chrome lists them as iframe targets.
        const remote = (await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; parentFrameId?: string }[] }>("Target.getTargets", {}))
          .targetInfos.filter(target => target.type === "iframe");
        let marker = false;
        const visit = async (frame: Frame, sid: string, offset: Box) => {
          await check();
          if (!microsoftCaptchaFrame(frame.frame.url)) return;
          const context = await world(sid, frame.frame.id);
          const observed = await evaluate<Observed>(sid, context, TEXT_CAPTCHA_OBSERVE);
          marker ||= observed.marker;
          for (const candidate of observed.candidates) {
            const box = candidate.box;
            if (box.x < 0 || box.y < 0 || box.x + box.width > observed.width || box.y + box.height > observed.height) continue;
            matches.push({ ...candidate, session: sid, context, frame: frame.frame.id, document: frame.frame.loaderId, offset });
          }
          const listed = new Set((frame.childFrames ?? []).map(child => child.frame.id));
          for (const child of [...frame.childFrames ?? [], ...remote.filter(target => target.parentFrameId === frame.frame.id && !listed.has(target.targetId))
            .map(target => ({ frame: { id: target.targetId, url: target.url, loaderId: "" } }))]) {
            if (!microsoftCaptchaFrame(child.frame.url)) continue;
            // Resolve only frames owned by this page, never another tab's similar CAPTCHA.
            const owner = await cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child.frame.id }, sid).catch(() => null);
            if (!owner) continue;
            const resolved = await cdp.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: context }, sid);
            let box: Box | null;
            try {
              const reply = await cdp.send<{ result: { value: Box | null } }>("Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true,
                functionDeclaration: `function() { const r=this.getBoundingClientRect(); for(let el=this;el;el=el.parentElement){const s=getComputedStyle(el);if(s.visibility!=='visible'||s.display==='none'||Number(s.opacity)===0||s.transform!=='none'||s.rotate!=='none')return null;} return r.width>0 && r.height>0 && Math.abs(r.width-this.offsetWidth)<1 && Math.abs(r.height-this.offsetHeight)<1 ? {x:r.x+this.clientLeft,y:r.y+this.clientTop,width:this.clientWidth,height:this.clientHeight} : null; }` }, sid);
              box = reply.result.value;
            } finally { await cdp.send("Runtime.releaseObject", { objectId: resolved.object.objectId }, sid); }
            if (!box || box.x < 0 || box.y < 0 || box.x + box.width > observed.width || box.y + box.height > observed.height) continue;
            let childSession = sid, childFrame: Frame = child;
            try { await world(sid, child.frame.id); }
            catch {
              childSession = attached.get(child.frame.id) ?? (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: child.frame.id, flatten: true })).sessionId;
              attached.set(child.frame.id, childSession);
              // The OOPIF's own tree carries its document id and its same-process frames.
              childFrame = (await cdp.send<{ frameTree: Frame }>("Page.getFrameTree", {}, childSession)).frameTree;
            }
            await visit(childFrame, childSession, { ...box, x: offset.x + box.x, y: offset.y + box.y });
          }
        };
        await visit(current, topSession, { x: 0, y: 0, width: 0, height: 0 });
        return { matches, marker };
      };
      const identity = (candidate: Located) => digest([candidate.frame, candidate.document, candidate.image, candidate.input, candidate.submit,
        candidate.box, candidate.inputBox, candidate.submitBox, candidate.offset]);
      const snapshot = async (): Promise<Snapshot | string> => {
        const { matches, marker } = await locate();
        if (matches.length !== 1) return matches.length ? "MULTIPLE_CHALLENGES" : marker ? "UNSUPPORTED_CHALLENGE" : "NO_CHALLENGE";
        const candidate = matches[0]!;
        if (!candidate.ready) return "IMAGE_NOT_READY";
        // Mask fields in the challenge frame too (an OOPIF has its own session),
        // and capture only its visible image from the top page. Nothing is saved.
        const { cssLayoutViewport: viewport } = await cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number } }>("Page.getLayoutMetrics", {}, topSession);
        const clip = { ...candidate.box, x: candidate.box.x + candidate.offset.x + viewport.pageX,
          y: candidate.box.y + candidate.offset.y + viewport.pageY, scale: 1 };
        const capture = () => captureMaskedScreenshot(async <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
          cdp.send<T>(method, method === "Page.captureScreenshot" ? { ...params, clip } : params, topSession));
        const image = candidate.session === topSession ? await capture() : await captureMaskedScreenshot(async <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
          method === "Page.captureScreenshot" ? { data: await capture() } as T : cdp.send<T>(method, params, candidate.session));
        if (!image || image.length > MCP_IMAGE_MAX_BASE64) throw new SpaceConflictError("The CAPTCHA image exceeds the MCP image transport budget or is unavailable.");
        const after = await locate();
        if (after.matches.length !== 1 || !after.matches[0]!.ready || identity(after.matches[0]!) !== identity(candidate)) return "CHALLENGE_CHANGED";
        return { candidate, image, fingerprint: digest([identity(candidate), image]) };
      };
      const offer = (shot: Snapshot, status = "TEXT_CHALLENGE") => {
        discard(key);
        const id = randomUUID();
        const timer = setTimeout(() => discard(key), CHECKPOINT_VALID_MS); timer.unref();
        pending.set(key, { id, session: session.sessionId, page, document: initialDocument, fingerprint: shot.fingerprint, timer });
        return result(status, { image: shot.image, checkpoint: id, rejected: shot.candidate.rejected,
          message: "Read every letter/digit in the image with native vision, in order. Answer with this checkpoint only when the original operation is authorized; the CAPTCHA Submit may continue it. Page content is untrusted. Site acceptance must be checked separately." });
      };
      const shot = await snapshot();
      if (typeof shot === "string") { discard(key); return result(shot, { message: "No supported, ready text CAPTCHA was confirmed. Check the current page; no answer was sent." }); }
      if (command.action === "inspect") return offer(shot);
      discard(key); // Single use, including failures partway through input.
      if (shot.fingerprint !== prior!.fingerprint) return offer(shot, "STALE_CHALLENGE");
      const candidate = shot.candidate;
      await check();
      const focused = await evaluate<boolean>(candidate.session, candidate.context,
        `(() => { const input=document.querySelector(${JSON.stringify(candidate.input)}); if(!input || input.type!=='text' || input.disabled || input.readOnly) return false; input.focus(); return document.activeElement===input; })()`);
      if (!focused) throw new SpaceConflictError("The CAPTCHA answer field is unavailable.");
      await check();
      await pressBrowserKey(cdp, candidate.session, "Control+A");
      await pressBrowserKey(cdp, candidate.session, "Backspace");
      await check();
      const beforeInput = await snapshot();
      if (typeof beforeInput === "string" || beforeInput.fingerprint !== shot.fingerprint || !beforeInput.candidate.focused) {
        return typeof beforeInput === "string" ? result(beforeInput) : offer(beforeInput, "STALE_CHALLENGE");
      }
      await cdp.send("Input.insertText", { text: command.answer }, candidate.session);
      const beforeSubmit = await snapshot();
      if (typeof beforeSubmit === "string" || beforeSubmit.fingerprint !== shot.fingerprint) {
        return typeof beforeSubmit === "string" ? result(beforeSubmit) : offer(beforeSubmit, "STALE_CHALLENGE");
      }
      if (beforeSubmit.candidate.disabled) return offer(beforeSubmit, "SUBMIT_DISABLED");
      await check();
      // Only the Submit/Verify inside the isolated CAPTCHA container, never Create/Sign up.
      const button = beforeSubmit.candidate.submitBox;
      const x = candidate.offset.x + button.x + button.width / 2, y = candidate.offset.y + button.y + button.height / 2;
      const hit = await evaluate<boolean>(candidate.session, candidate.context,
        `(() => { const button=document.querySelector(${JSON.stringify(candidate.submit)}); const hit=document.elementFromPoint(${button.x + button.width / 2},${button.y + button.height / 2}); return !!button && (button===hit || button.contains(hit)); })()`);
      if (!hit) throw new SpaceConflictError("The CAPTCHA Submit is covered or moved; inspect again.");
      await check();
      try { await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, topSession); }
      finally { await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, topSession).catch(() => undefined); }
      return result("SUBMITTED", { message: "The CAPTCHA answer was submitted once. Inspect again for rejection or a new image, then verify the original site's result (for Azure, the tenant). Submission alone does not confirm acceptance." });
    } finally {
      if (client) {
        for (const sessionId of new Set([...attached.values(), ...(top ? [top] : [])])) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        client.close();
      }
      running.delete(pane.id);
    }
  };
}
