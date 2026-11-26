import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { BrowserRuntimeInput, UiLanguage } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceApiError } from "../../runtime/SpaceRuntime.js";
import { modifierMaskFromEvent } from "../browser-pane/BrowserCanvas.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { uiText } from "../ui-language/ui-language.js";
import { ArrowLeft, ExternalLink, Globe, Lock, Monitor, RotateCw, X } from "../ui-theme/app-icons.js";

/**
 * Nous fullscreen never closes for a Go (operator nous_msg:8596b29a, 14/11): the pane opens in a floating window over it. A browser pane
 * (and a copilot's browser) is its live Teleport, a phone-sized page driven here; any other pane shows the card with "Open the pane",
 * whose click is the only thing that leaves fullscreen.
 */
export interface NousFloatTarget { roomId: string; paneId: string; title: string; browser: boolean; pageId?: string }

type Input = BrowserRuntimeInput extends infer T ? T extends unknown ? Omit<T, "leaseId"> : never : never;
type Frame = { src: string; width: number; height: number };

/**
 * Captcha mode (operator 14/11 nous_msg:6345d547): this many frame polls are out at once, so frames come at lanes / round trip (16.7 fps
 * measured at a 670 ms trip; the proxy speaks HTTP/2, so they hold no connection the inputs need), and touches go uncoalesced with their own times.
 */
export const CAPTCHA_LANES = 12;
const fit = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));
/** Only the last of each run of touch moves goes: a slow link sends fewer moves, never late ones. */
export const coalesceMoves = (inputs: Input[]) => inputs.filter((input, index) => !(input.type === "TOUCH" && input.eventType === "touchMove"
  && inputs[index + 1]?.type === "TOUCH" && (inputs[index + 1] as { eventType?: string }).eventType === "touchMove"));
/**
 * A point on the shown frame (object-fit: contain inside `box`) in the page's CSS pixels; null outside the picture. The letterbox follows
 * the picture's own shape (`shown`, its natural size), which a first screenshot may not share with the size it is labelled with.
 */
export function toPage(clientX: number, clientY: number, box: { left: number; top: number; width: number; height: number }, page: { width: number; height: number },
  shown: { width: number; height: number } = page) {
  const scale = Math.min(box.width / shown.width, box.height / shown.height);
  if (!scale) return null;
  const x = ((clientX - box.left - (box.width - shown.width * scale) / 2) / scale) * (page.width / shown.width);
  const y = ((clientY - box.top - (box.height - shown.height * scale) / 2) / scale) * (page.height / shown.height);
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** The window's place and size (operator nous_msg:154cee76 «θέλω να θυμάται το μέγεθος και τη θέση που επιλέγω»), kept across opens and reloads. */
export interface FloatBounds { x: number; y: number; width: number; height: number }
export const FLOAT_BOUNDS_KEY = "space.nous.floatWindow.bounds.v1";
const MARGIN = 12;
const MIN_SIZE = { width: 360, height: 320 };
type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
/** On screen with a 12 px margin, at least 360x320 unless the screen is smaller (then the screen wins). */
export function clampBounds(bounds: FloatBounds, view = viewport()): FloatBounds {
  const width = Math.round(Math.min(view.width - 2 * MARGIN, Math.max(MIN_SIZE.width, bounds.width)));
  const height = Math.round(Math.min(view.height - 2 * MARGIN, Math.max(MIN_SIZE.height, bounds.height)));
  return { width, height, x: Math.round(Math.max(MARGIN, Math.min(view.width - MARGIN - width, bounds.x))),
    y: Math.round(Math.max(MARGIN, Math.min(view.height - MARGIN - height, bounds.y))) };
}
/** A resize from `from` by the pointer's travel: the opposite edge stays put. */
export function resizeBounds(from: FloatBounds, edge: Edge, dx: number, dy: number, view = viewport()): FloatBounds {
  let { x, y, width, height } = from;
  if (edge.includes("e")) width = Math.min(view.width - MARGIN - from.x, from.width + dx);
  if (edge.includes("s")) height = Math.min(view.height - MARGIN - from.y, from.height + dy);
  if (edge.includes("w")) { width = Math.min(from.x + from.width - MARGIN, Math.max(MIN_SIZE.width, from.width - dx)); x = from.x + from.width - width; }
  if (edge.includes("n")) { height = Math.min(from.y + from.height - MARGIN, Math.max(MIN_SIZE.height, from.height - dy)); y = from.y + from.height - height; }
  return clampBounds({ x, y, width, height }, view);
}
const PRESETS = {
  Normal: (view: { width: number; height: number }) => ({ width: 400, height: Math.min(760, view.height) }),
  Large: (view: { width: number; height: number }) => ({ width: Math.max(760, view.width * 0.5), height: view.height * 0.85 }),
  Full: (view: { width: number; height: number }) => ({ width: view.width, height: view.height }),
} as const;
const defaultBounds = (view = viewport()): FloatBounds => {
  const size = PRESETS.Normal(view);
  return clampBounds({ ...size, x: view.width - size.width, y: view.height - size.height }, view);
};
export function readFloatBounds(view = viewport()): FloatBounds {
  try {
    const saved = JSON.parse(window.localStorage.getItem(FLOAT_BOUNDS_KEY) ?? "null") as Partial<FloatBounds> | null;
    if (saved && [saved.x, saved.y, saved.width, saved.height].every((value) => typeof value === "number" && Number.isFinite(value))) return clampBounds(saved as FloatBounds, view);
  } catch { /* unreadable: the default place */ }
  return defaultBounds(view);
}
const saveFloatBounds = (bounds: FloatBounds) => { try { window.localStorage.setItem(FLOAT_BOUNDS_KEY, JSON.stringify(bounds)); } catch { /* storage full or off: this open keeps it */ } };

export function NousFloat({ target, language, onClose, onOpen, children }: {
  target: NousFloatTarget; language: UiLanguage; onClose(): void; onOpen(): void; children?: ReactNode;
}) {
  const t = (text: string) => uiText(language, text);
  const [bounds, setBounds] = useState(readFloatBounds);
  const gesture = useRef<{ edge: Edge | null; x: number; y: number; from: FloatBounds } | null>(null);
  // Only his own gestures write it: a smaller window (a rotate) shows it clamped, and what was saved comes back exactly when it fits again.
  useEffect(() => {
    const refit = () => setBounds(readFloatBounds());
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);
  const grab = (edge: Edge | null) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      gesture.current = { edge, x: event.clientX, y: event.clientY, from: bounds };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const at = gesture.current;
      if (!at) return;
      const dx = event.clientX - at.x;
      const dy = event.clientY - at.y;
      const next = at.edge ? resizeBounds(at.from, at.edge, dx, dy) : clampBounds({ ...at.from, x: at.from.x + dx, y: at.from.y + dy });
      setBounds(next);
      // Saved on every change (nous_msg after 154cee76: «να ΘΥΜΑΤΑΙ τις διαστάσεις που επιλέγω και τη θέση»).
      saveFloatBounds(next);
    },
    onPointerUp: () => { gesture.current = null; },
    onPointerCancel: () => { gesture.current = null; },
  });
  const preset = (name: keyof typeof PRESETS) => {
    const view = viewport();
    const size = PRESETS[name](view);
    const next = clampBounds(name === "Full" ? { ...size, x: 0, y: 0 } : { ...bounds, ...size }, view);
    setBounds(next);
    saveFloatBounds(next);
  };
  // The highlighted preset is the one the window's size matches now; a hand resize leaves none lit.
  const view = viewport();
  const active = (Object.keys(PRESETS) as Array<keyof typeof PRESETS>).find((name) => {
    const size = clampBounds({ ...bounds, ...PRESETS[name](view) }, view);
    return size.width === bounds.width && size.height === bounds.height;
  });
  return (
    <section className={`nous-float${target.browser ? " is-teleport" : ""}`} role="dialog" aria-label={target.title} data-nous-float={target.paneId}
      style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
      // Escape closes only this window: fullscreen Nous behind it stays (its own Escape listener is on window).
      onKeyDown={(event) => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); onClose(); }}>
      {EDGES.map((edge) => <div key={edge} className="nous-float-edge" data-edge={edge} aria-hidden="true" {...grab(edge)} />)}
      <header className="nous-float-bar" {...grab(null)}>
        <span className="nous-float-icon" aria-hidden="true">{target.browser ? <Globe /> : <Monitor />}</span>
        <span className="nous-float-heading">
          <span className="nous-float-title">{target.title}</span>
          {target.browser ? <span className="nous-float-sub">{t("Live Teleport")}</span> : null}
        </span>
        <span className="nous-float-sizes" role="group" aria-label={t("Window size")}>
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((name) => (
            <button key={name} type="button" data-nous-float-size={name} className={name === active ? "is-active" : undefined} aria-pressed={name === active}
              onClick={() => preset(name)}>{t(name)}</button>
          ))}
        </span>
        <button type="button" data-nous-float="open" aria-label={t("Open the pane")} title={t("Open the pane")} onClick={onOpen}><ExternalLink aria-hidden="true" /></button>
        <button type="button" data-nous-float="close" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {children}
      {target.browser ? <TeleportView paneId={target.paneId} pageId={target.pageId} title={target.title} language={language} /> : null}
      {!target.browser ? <button type="button" className="nous-float-open" onClick={onOpen}>{t("Open the pane")}</button> : null}
    </section>
  );
}

/** The live page, as the Nous app's Teleport: one long poll at a time (CAPTCHA_LANES in Captcha mode), touch and keys under the operator's lease, off and released on close. */
function TeleportView({ paneId, pageId, title, language }: { paneId: string; pageId?: string; title: string; language: UiLanguage }) {
  const t = (text: string) => uiText(language, text);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  const [fps, setFps] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState(false);
  const captchaRef = useRef(captcha);
  captchaRef.current = captcha;
  const lease = useRef<string | null>(null);
  const queue = useRef<Array<{ input: Input; at: number }>>([]);
  const polls = useRef({ shown: 0, waiting: [] as number[], frames: 0 });
  const flushing = useRef(false);
  const refused = (cause: unknown) => cause instanceof SpaceApiError && cause.status === 409
    ? t("An agent is using this browser now. Touch works again when it lets go.") : cause instanceof Error ? cause.message : t("The teleport failed.");

  // The page takes the stage's shape, again whenever the window is resized (nous_msg:154cee76: a stage measured once left a strip and black below).
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useLayoutEffect(() => {
    const box = area.current;
    if (!box) return;
    const measure = () => setSize((now) => {
      const next = { width: fit(box.clientWidth, 240, 2560), height: fit(box.clientHeight, 180, 1600) };
      return now && Math.abs(now.width - next.width) < 8 && Math.abs(now.height - next.height) < 8 ? now : next;
    });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const sent = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!size || !sent.current || sent.current === size) return;
    // Once the resize settles: the open teleport takes the new shape, its poll goes on.
    const timer = window.setTimeout(() => { sent.current = size; void api.teleport(paneId, { on: true, dimensions: size }).catch(() => undefined); }, 300);
    return () => window.clearTimeout(timer);
  }, [paneId, size]);

  // One long poll for a frame no other poll waits for; answers its trip's length when another poll had brought that frame already.
  const pollFrame = async (live: () => boolean) => {
    const state = polls.current;
    let after = state.shown;
    while (state.waiting.includes(after)) after += 1;
    state.waiting.push(after);
    const started = performance.now();
    const result = await api.teleportFrame(paneId, after).finally(() => state.waiting.splice(state.waiting.indexOf(after), 1));
    if (!live() || !result.frame) return 0;
    if (result.frame.sequence <= state.shown) return performance.now() - started;
    state.shown = result.frame.sequence;
    state.frames += 1;
    setFrame({ src: `data:${result.frame.mimeType};base64,${result.frame.data}`, width: result.frame.width, height: result.frame.height });
    return 0;
  };
  // A frame another poll brought sends this one back a share of its trip later, so the polls stay out of step.
  const pause = (trip: number) => trip / CAPTCHA_LANES;

  const opened = Boolean(size);
  useEffect(() => {
    if (!opened) return;
    let live = true;
    const dimensions = () => { sent.current = sizeRef.current; return sizeRef.current ?? undefined; };
    const open = () => api.teleport(paneId, { on: true, dimensions: dimensions() }).then(() => { setError(null); return 0; }, (cause: unknown) => { setError(refused(cause)); return 5_000; });
    void (async () => {
      // The tab the card is about comes forward once, on open.
      let wait = await api.teleport(paneId, { on: true, dimensions: dimensions(), ...(pageId ? { pageId } : {}) }).then(() => 0, (cause: unknown) => { setError(refused(cause)); return 0; });
      while (live) {
        if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
        wait = 0;
        if (!live) return;
        try {
          wait = pause(await pollFrame(() => live));
        } catch (cause) {
          if (!live) return;
          // Ended while away (30 s without a poll, a browser restart) or refused: open it again as it is now.
          if (cause instanceof SpaceApiError && cause.status === 409) { polls.current.shown = 0; wait = await open(); } else wait = 1_000;
        }
      }
    })();
    const count = window.setInterval(() => { setFps(polls.current.frames); polls.current.frames = 0; }, 1_000);
    const beat = window.setInterval(() => {
      const leaseId = lease.current;
      if (leaseId) void api.heartbeatBrowserControl(paneId, { leaseId, ttlSeconds: 60, present: true })
        .then((result) => { if (result.lease.status !== "ACTIVE") lease.current = null; }, () => { lease.current = null; });
    }, 15_000);
    return () => {
      live = false;
      window.clearInterval(count);
      window.clearInterval(beat);
      const leaseId = lease.current;
      lease.current = null;
      // Off first so the pane is a desktop again, then the control goes back to the agent.
      void api.teleport(paneId, { on: false }).catch(() => undefined)
        .finally(() => { if (leaseId) void api.releaseBrowserControl(paneId, { leaseId }).catch(() => undefined); });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opened once per pane; the tab is chosen on open.
  }, [paneId, opened]);
  // Captcha mode's other polls; the first one above reopens an ended teleport.
  useEffect(() => {
    if (!captcha || !opened) return;
    let live = true;
    const lane = async () => {
      while (live) {
        const wait = await pollFrame(() => live).then(pause, () => 1_000);
        if (wait && live) await new Promise((resolve) => window.setTimeout(resolve, wait));
      }
    };
    for (let index = 1; index < CAPTCHA_LANES; index += 1) void lane();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pollFrame reads refs.
  }, [paneId, opened, captcha]);

  const acquire = async () => {
    const result = await api.acquireBrowserControl(paneId, { holderType: "OPERATOR", holderId: "space-user", reason: "Teleport in Nous fullscreen", ttlSeconds: 60 });
    lease.current = result.lease.leaseId;
    return result.lease.leaseId;
  };
  // In order, one request at a time; what waits behind a slow request goes together.
  const flush = async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (queue.current.length) {
        const taken = queue.current.splice(0);
        // Captcha mode: every move goes with its own time, and the server plays them with the finger's gaps.
        const timed = captchaRef.current;
        const batch = timed ? taken.map((entry) => entry.input) : coalesceMoves(taken.map((entry) => entry.input));
        const post = (leaseId: string) => api.teleportInput(paneId, batch.map((input) => ({ ...input, leaseId }) as BrowserRuntimeInput), timed ? taken.map((entry) => entry.at) : undefined);
        try { await post(lease.current ?? await acquire()); } catch { lease.current = null; await post(await acquire()); }
      }
      setError(null);
    } catch (cause) {
      queue.current = [];
      setError(refused(cause));
    } finally {
      flushing.current = false;
    }
  };
  const stamped = (at: number, ...inputs: Input[]) => { queue.current.push(...inputs.map((input) => ({ input, at }))); void flush(); };
  const send = (...inputs: Input[]) => stamped(performance.now(), ...inputs);

  const point = (event: { clientX: number; clientY: number }, element: HTMLElement) => {
    const page = frameRef.current;
    const picture = element as HTMLImageElement;
    return page ? toPage(event.clientX, event.clientY, element.getBoundingClientRect(), page,
      picture.naturalWidth && picture.naturalHeight ? { width: picture.naturalWidth, height: picture.naturalHeight } : page) : null;
  };
  const touch = (eventType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel") => (event: PointerEvent<HTMLImageElement>) => {
    if (eventType === "touchMove" && !event.buttons && event.pointerType === "mouse") return;
    const at = point(event, event.currentTarget);
    if (eventType !== "touchEnd" && eventType !== "touchCancel" && !at) return;
    event.preventDefault();
    stamped(event.timeStamp, { type: "TOUCH", eventType, touchPoints: at && eventType !== "touchEnd" && eventType !== "touchCancel" ? [{ ...at, id: Math.max(0, event.pointerId) % 100 }] : [] });
  };
  // React's wheel listener is passive: a local one keeps the scroll inside the page.
  const picture = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const element = picture.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const at = point(event, element);
      if (!at) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      send({ type: "POINTER", eventType: "mouseWheel", ...at, button: "none", deltaX: fit(event.deltaX * unit, -10000, 10000), deltaY: fit(event.deltaY * unit, -10000, 10000) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- point and send read refs; the picture mounts with the first frame.
  }, [Boolean(frame)]);
  // Keys as the dock's canvas sends them (BrowserCanvas): Ctrl+V is left to the paste event.
  const key = (eventType: "keyDown" | "keyUp") => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest("button, input")) return;
    if (event.key === "Escape") return;
    if (((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === "KeyV" || event.key.toLowerCase() === "v")) || (event.shiftKey && event.key === "Insert")) return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: "KEY", eventType, key: event.key, code: event.code || undefined,
      ...(eventType === "keyDown" ? event.key === "Enter" ? { text: "\r" } : event.key.length === 1 ? { text: event.key } : {} : {}), modifiers: modifierMaskFromEvent(event) });
  };

  return (
    <div className="nous-teleport" tabIndex={0} onKeyDown={key("keyDown")} onKeyUp={key("keyUp")}
      onPaste={(event) => { const text = event.clipboardData?.getData("text"); if (!text) return; event.preventDefault(); send({ type: "KEY", eventType: "char", key: "Unidentified", text }); }}>
      <div className="nous-teleport-tools">
        <button type="button" aria-label={t("Back")} title={t("Back")} onClick={() => send({ type: "NAVIGATION", action: "BACK" })}><ArrowLeft aria-hidden="true" /></button>
        <button type="button" aria-label={t("Reload the page")} title={t("Reload the page")} onClick={() => send({ type: "NAVIGATION", action: "RELOAD" })}><RotateCw aria-hidden="true" /></button>
        <span className="nous-teleport-address"><Lock aria-hidden="true" /><span>{title}</span></span>
        <SpaceToggle compact label={t("Captcha mode")} title={t("More frames, and every move of your finger played with its own timing")} checked={captcha} onChange={setCaptcha} />
        {/* A still page sends no frame (only changes travel): it is live, not stuck at 0 fps. */}
        <span className={`nous-teleport-fps${frame ? " is-live" : ""}`} aria-live="off">{frame ? fps ? `${fps} fps` : t("Live") : t("Opening the page…")}</span>
      </div>
      <div className="nous-teleport-page" ref={area}>
        {frame ? <img ref={picture} src={frame.src} alt={t("Live page")} draggable={false} onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); event.currentTarget.closest<HTMLElement>(".nous-teleport")?.focus({ preventScroll: true }); touch("touchStart")(event); }}
          onPointerMove={touch("touchMove")} onPointerUp={touch("touchEnd")} onPointerCancel={touch("touchCancel")} /> : null}
      </div>
      {error ? <p className="nous-teleport-error" role="alert">{error}</p> : null}
    </div>
  );
}
