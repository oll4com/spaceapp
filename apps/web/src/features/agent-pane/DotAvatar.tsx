import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { detectPromptTone, dotPersonalities, type DotCharacter, type DotFeedItem, type DotMood } from "@space/contracts";
import { dotBodies } from "./dot-avatar-art.js";
import "./dot-avatar.css";

type Eyes = "open" | "wide" | "happy" | "closed" | "half" | "narrow" | "heart" | "star" | "wink";
type Mouth = "smile" | "soft" | "grin" | "flat" | "o" | "wobble" | "smirk";
type Brows = "raised" | "focused" | "worried" | "skeptic";
type Fx = "sparkles" | "hearts" | "zzz" | "sweat" | "dots" | "exclaim" | "glow" | "moon" | "scan";
interface Face { eyes: Eyes; mouth: Mouth; brows?: Brows; blush?: boolean; look?: [number, number]; fx?: Fx }
type Point = [number, number];

const faces: Record<DotMood, Face> = {
  idle: { eyes: "open", mouth: "soft" },
  happy: { eyes: "happy", mouth: "smile", brows: "raised", blush: true },
  adoring: { eyes: "heart", mouth: "grin", blush: true, fx: "hearts" },
  excited: { eyes: "star", mouth: "grin", brows: "raised", fx: "sparkles" },
  proud: { eyes: "happy", mouth: "smirk", brows: "raised", fx: "glow" },
  amused: { eyes: "wink", mouth: "smirk" },
  content: { eyes: "half", mouth: "soft", blush: true },
  focused: { eyes: "narrow", mouth: "flat", brows: "focused" },
  thinking: { eyes: "open", look: [0.35, -0.35], mouth: "flat", fx: "dots" },
  working: { eyes: "narrow", mouth: "flat", brows: "focused", fx: "dots" },
  waiting: { eyes: "open", mouth: "o", brows: "raised", fx: "exclaim" },
  cool: { eyes: "half", look: [0.45, 0], mouth: "flat", brows: "skeptic" },
  worried: { eyes: "open", mouth: "wobble", brows: "worried", fx: "sweat" },
  surprised: { eyes: "wide", mouth: "o", brows: "raised" },
  sleepy: { eyes: "closed", mouth: "soft", fx: "zzz" },
  comforting: { eyes: "happy", mouth: "soft", brows: "worried", blush: true, fx: "hearts" }
};

/** Where each Dot's face sits on its body, its colours, its blink rhythm and how its personality changes a mood. */
interface Anchor {
  eyes: [Point, Point]; rx: number; ry: number; mouth: Point; width: number; ink: string; mouthInk: string;
  /** LED faces glow on a visor or screen. */
  led?: boolean; rotate?: [number, number, number]; cheeks?: [Point, Point]; blush?: string;
  top: Point; side: Point; scan?: [number, number, number, number]; blink: [number, number];
  overrides?: Partial<Record<DotMood, Partial<Face>>>;
}
const anchors: Record<DotCharacter, Anchor> = {
  astronaut: { eyes: [[140, 112], [178, 112]], rx: 7, ry: 9, mouth: [159, 131], width: 18, ink: "#A6ECF2", mouthInk: "#A6ECF2", led: true,
    cheeks: [[127, 126], [191, 126]], blush: "#F6A6B8", top: [160, 46], side: [214, 92], scan: [118, 88, 84, 56], blink: [4500, 7000],
    overrides: { working: { fx: "scan" } } },
  star: { eyes: [[132, 150], [180, 148]], rx: 8, ry: 10.5, mouth: [158, 174], width: 22, ink: "#263447", mouthInk: "#5B3D35",
    cheeks: [[114, 173], [196, 170]], blush: "#F49A86", top: [158, 58], side: [208, 116], blink: [2500, 4200],
    overrides: { idle: { mouth: "smile", blush: true } } },
  robot: { eyes: [[135.5, 128.5], [184.5, 127.5]], rx: 7, ry: 10, mouth: [159, 146], width: 18, ink: "#D8F3E9", mouthInk: "#D8F3E9", led: true,
    top: [159, 34], side: [222, 98], scan: [110, 106, 98, 50], blink: [4000, 4000],
    overrides: { working: { fx: "scan" }, adoring: { mouth: "smile" }, excited: { mouth: "smile" } } },
  comet: { eyes: [[103, 174], [147, 172]], rx: 8, ry: 10.5, mouth: [126, 194], width: 22, ink: "#29374A", mouthInk: "#684347",
    rotate: [-10, 123, 185], cheeks: [[88, 194], [161, 183]], blush: "#F49A8C", top: [112, 112], side: [60, 158], blink: [1800, 3200],
    overrides: { idle: { mouth: "smile" } } },
  moon: { eyes: [[108, 155], [139, 157]], rx: 7.5, ry: 9.5, mouth: [124, 178], width: 18, ink: "#2A384C", mouthInk: "#41536C",
    rotate: [6, 124, 166], cheeks: [[97, 178], [147, 180]], blush: "#E7A8B5", top: [150, 56], side: [78, 128], blink: [6000, 9500],
    overrides: { idle: { eyes: "half" }, happy: { mouth: "soft" }, adoring: { eyes: "half", mouth: "soft", fx: undefined },
      excited: { eyes: "happy", mouth: "smile" } } },
  planet: { eyes: [[132, 140], [180, 140]], rx: 7.5, ry: 10, mouth: [157, 162], width: 20, ink: "#2D354E", mouthInk: "#4A4162",
    rotate: [5, 158, 146], cheeks: [[114, 155], [199, 160]], blush: "#D9A0C6", top: [160, 58], side: [228, 106], blink: [4000, 6500],
    overrides: { idle: { mouth: "smile" }, thinking: { fx: "moon" }, working: { fx: "moon" } } }
};

const heart = "M0 .9C-1.6-.1-1-1.3 0-.55C1-1.3 1.6-.1 0 .9Z";
const sparkle = "M0-1C.12-.2.2-.12 1 0C.2.12.12.2 0 1C-.12.2-.2.12-1 0C-.2-.12-.12-.2 0-1Z";
const drop = "M0-1C.5-.2.7.2.7.45A.7.7 0 0 1-.7.45C-.7.2-.5-.2 0-1Z";
const blinkable = new Set<Eyes>(["open", "wide", "half", "narrow"]);

function Eye({ shape, at: [x, y], a }: { shape: Eyes; at: Point; a: Anchor }): ReactElement {
  const { rx, ry, ink, led } = a;
  const stroke = { stroke: ink, strokeWidth: rx * 0.62, strokeLinecap: "round" as const, fill: "none" };
  if (shape === "happy") return <path d={`M${x - rx * 1.1} ${y + ry * 0.25}Q${x} ${y - ry * 1.05} ${x + rx * 1.1} ${y + ry * 0.25}`} {...stroke} />;
  if (shape === "closed") return <path d={`M${x - rx * 1.05} ${y}Q${x} ${y + ry * 0.75} ${x + rx * 1.05} ${y}`} {...stroke} />;
  if (shape === "heart") return <path transform={`translate(${x} ${y}) scale(${rx * 1.3})`} d={heart} fill={led ? "#FF9FB4" : "#EC5B76"} />;
  if (shape === "star") return <path transform={`translate(${x} ${y}) scale(${rx * 1.55})`} d={sparkle} fill={led ? ink : "#F2B437"} />;
  if (shape === "half") {
    // Relaxed lids: the lower half of the eye under a thin lash line.
    const cy = y + ry * 0.15;
    return <>
      <path d={`M${x - rx} ${cy}A${rx} ${ry * 0.85} 0 0 0 ${x + rx} ${cy}Z`} fill={ink} />
      <path d={`M${x - rx * 1.15} ${cy - 0.5}Q${x} ${cy - ry * 0.18} ${x + rx * 1.15} ${cy - 0.5}`} stroke={ink} strokeWidth={rx * 0.3} strokeLinecap="round" fill="none" />
      {led ? null : <ellipse cx={x - rx * 0.35} cy={cy + ry * 0.3} rx={rx * 0.22} ry={ry * 0.16} fill="#FFF8E6" opacity=".8" />}
    </>;
  }
  const grow = shape === "wide" ? 1.22 : 1;
  const w = rx * grow, h = ry * grow * (shape === "narrow" ? 0.45 : 1);
  return <>
    {led ? <rect x={x - w} y={y - h} width={w * 2} height={h * 2} rx={Math.min(w, h) * 0.8} fill={ink} />
      : <ellipse cx={x} cy={y} rx={w} ry={h} fill={ink} />}
    {led ? null : <ellipse cx={x - w * 0.32} cy={y - h * 0.38} rx={w * 0.28} ry={h * 0.25} fill="#FFF8E6" opacity=".85" />}
    {shape === "wide" && !led ? <circle cx={x + w * 0.3} cy={y + h * 0.3} r={w * 0.14} fill="#FFF8E6" opacity=".6" /> : null}
  </>;
}

function brow(kind: Brows, side: 0 | 1, [x, y]: Point, rx: number, ry: number): string {
  const by = y - ry * 1.75;
  const inner = side === 0 ? 1 : -1; // the end nearer the nose
  const ix = x + inner * rx, ox = x - inner * rx * 1.1;
  if (kind === "focused") return `M${ox} ${by - 2}L${ix} ${by + ry * 0.35}`;
  if (kind === "worried") return `M${ox} ${by + ry * 0.3}L${ix} ${by - ry * 0.2}`;
  if (kind === "skeptic" && side === 0) return `M${ox} ${by}L${ix} ${by}`;
  const lift = kind === "skeptic" ? ry * 0.45 : 0;
  return `M${x - rx} ${by + 2 - lift}Q${x} ${by - ry * 0.5 - lift} ${x + rx} ${by + 2 - lift}`;
}

function mouthShape(kind: Mouth, [x, y]: Point, w: number, ink: string, led?: boolean): ReactElement {
  const stroke = { stroke: ink, strokeWidth: w * 0.17, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  switch (kind) {
    case "smile": return <path d={`M${x - w / 2} ${y}Q${x} ${y + w * 0.5} ${x + w / 2} ${y}`} {...stroke} />;
    case "soft": return <path d={`M${x - w * 0.32} ${y}Q${x} ${y + w * 0.28} ${x + w * 0.32} ${y}`} {...stroke} />;
    case "flat": return <path d={`M${x - w * 0.3} ${y + w * 0.05}H${x + w * 0.3}`} {...stroke} />;
    case "smirk": return <path d={`M${x - w * 0.35} ${y + w * 0.08}Q${x + w * 0.05} ${y + w * 0.3} ${x + w * 0.42} ${y - w * 0.1}`} {...stroke} />;
    case "wobble": return <path d={`M${x - w * 0.42} ${y + w * 0.1}q${w * 0.105} ${-w * 0.16} ${w * 0.21} 0t${w * 0.21} 0t${w * 0.21} 0t${w * 0.21} 0`} {...stroke} />;
    case "o": return <ellipse cx={x} cy={y + w * 0.12} rx={w * 0.17} ry={w * 0.21} fill={ink} />;
    case "grin": return <>
      <path d={`M${x - w / 2} ${y}Q${x} ${y + w * 0.95} ${x + w / 2} ${y}Z`} fill={ink} />
      {led ? null : <ellipse cx={x} cy={y + w * 0.36} rx={w * 0.19} ry={w * 0.1} fill="#E58C8C" />}
    </>;
  }
}

function Effect({ fx, a }: { fx: Fx; a: Anchor }): ReactElement | null {
  const [tx, ty] = a.top;
  const place = (x: number, y: number, scale: number, className: string, child: ReactElement, delay = 0, key?: number) =>
    <g key={key} transform={`translate(${x} ${y})`}><g className={className} style={delay ? { animationDelay: `${delay}s` } : undefined}>
      <g transform={`scale(${scale})`}>{child}</g></g></g>;
  switch (fx) {
    case "sparkles": return <>{([[-44, 14, 10], [40, 0, 8], [8, -22, 12]] as const).map(([dx, dy, s], i) =>
      place(tx + dx, ty + dy, s, "dot-fx-twinkle", <path d={sparkle} fill="#FFD66B" />, i * 0.35, i))}</>;
    case "hearts": return <>{([[-30, 10, 8], [30, -4, 10]] as const).map(([dx, dy, s], i) =>
      place(tx + dx, ty + dy, s, "dot-fx-rise", <path d={heart} fill="#F0607A" />, i * 0.6, i))}</>;
    case "zzz": return <>{([[34, 8, 7], [48, -10, 9], [64, -30, 11]] as const).map(([dx, dy, s], i) =>
      place(tx + dx, ty + dy, s, "dot-fx-rise slow", <path d="M-.5-.5H.5L-.5.5H.5" stroke="#8EA2C4" strokeWidth=".26" strokeLinecap="round" strokeLinejoin="round" fill="none" />, i * 0.8, i))}</>;
    case "sweat": return place(a.side[0], a.side[1], 9, "dot-fx-drip", <path d={drop} fill="#9FD3F2" />);
    case "dots": return <>{[-16, 0, 16].map((dx, i) => place(tx + dx, ty + 4, 5, "dot-fx-dot", <circle r="1" fill="#8EA2C4" />, i * 0.18, i))}</>;
    case "exclaim": return place(tx + 34, ty + 2, 14, "dot-fx-pop", <>
      <circle r="1" fill="#FFC857" /><path d="M0-.55V.12" stroke="#263447" strokeWidth=".2" strokeLinecap="round" /><circle cy=".42" r=".11" fill="#263447" /></>);
    case "moon": return <g className="dot-fx-orbit"><circle cx="278" cy="120" r="10" fill="#E9E4F5" /><circle cx="275" cy="117" r="3" fill="#C8C0DD" /></g>;
    case "scan": return a.scan ? <rect className="dot-fx-scan" x={a.scan[0]} y={a.scan[1]} width={a.scan[2]} height="3" rx="1.5" fill={a.ink} opacity=".55" /> : null;
    case "glow": return null; // drawn behind the body
  }
}

function useBlink(active: boolean, [min, max]: [number, number]): boolean {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => { setClosed(true); timer = setTimeout(() => { setClosed(false); schedule(); }, 140); }, min + Math.random() * (max - min));
    };
    schedule();
    return () => { clearTimeout(timer); setClosed(false); };
  }, [active, min, max]);
  return closed;
}

/** The face a Dot shows for a mood: the shared expression plus the Dot's own take on it. */
export function dotFace(character: DotCharacter, mood: DotMood): Face {
  return { ...faces[mood], ...anchors[character].overrides?.[mood] };
}

/**
 * An animated Dot: its body, a face for the mood and the Dot's own motion. Decorative (the status text stays the
 * accessible source). motion "on" idles and blinks, "hover" moves only under the pointer, "off" pauses everything.
 */
export function DotAvatar({ character, mood = "idle", size, motion = "on", className }: {
  character: DotCharacter; mood?: DotMood; size: number; motion?: "on" | "hover" | "off"; className?: string;
}) {
  // The character keeps ids apart even across React roots, whose useId values repeat.
  const p = `dot-${character}-${useId().replace(/[^a-zA-Z0-9]/g, "")}-`;
  const a = anchors[character];
  const face = dotFace(character, mood);
  const blink = useBlink(motion === "on" && blinkable.has(face.eyes), a.blink);
  const body = useMemo(() => dotBodies[character](p), [character, p]);
  const blush = face.blush && a.cheeks && a.blush;
  const [left, right] = a.eyes;
  const look = face.look ? `translate(${face.look[0] * a.rx} ${face.look[1] * a.ry})` : undefined;
  return <span className={`dot-avatar${className ? ` ${className}` : ""}`} data-character={character} data-mood={mood} data-motion={motion}
    data-blink={blink ? "true" : undefined} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="16 14 288 288" width={size} height={size} focusable="false">
      <defs><filter id={`${p}led`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        <radialGradient id={`${p}halo`}><stop stopColor="#FFE7A3" stopOpacity=".55" /><stop offset="1" stopColor="#FFE7A3" stopOpacity="0" /></radialGradient></defs>
      {face.fx === "glow" ? <circle className="dot-fx-halo" cx="160" cy="158" r="128" fill={`url(#${p}halo)`} /> : null}
      {/* The source drawings set fill="none" on their root: their stroke-only paths must not fill. */}
      <g className="dot-av-figure" fill="none">{body}</g>
      <g className="dot-av-face" transform={a.rotate ? `rotate(${a.rotate.join(" ")})` : undefined} filter={a.led ? `url(#${p}led)` : undefined}>
        {blush ? a.cheeks!.map(([x, y], i) => <ellipse key={i} className="dot-av-blush" cx={x} cy={y} rx="13" ry="8" fill={a.blush} opacity=".55" />) : null}
        {face.brows ? <g stroke={a.ink} strokeWidth={a.rx * 0.45} strokeLinecap="round" fill="none">
          <path d={brow(face.brows, 0, left, a.rx, a.ry)} /><path d={brow(face.brows, 1, right, a.rx, a.ry)} /></g> : null}
        <g transform={look}>
          <g className="dot-av-eye"><Eye shape={face.eyes === "wink" ? "open" : face.eyes} at={left} a={a} /></g>
          <g className="dot-av-eye"><Eye shape={face.eyes === "wink" ? "happy" : face.eyes} at={right} a={a} /></g>
        </g>
        {mouthShape(face.mouth, a.mouth, a.width, a.mouthInk, a.led)}
      </g>
      {face.fx ? <g className="dot-av-fx"><Effect fx={face.fx} a={a} /></g> : null}
    </svg>
  </span>;
}

export function statusMood(status: string): DotMood {
  return status === "Working" ? "working" : status === "Waiting for approval" ? "waiting"
    : status === "Offline" || status === "Paused" ? "sleepy" : "idle";
}

const REACTION_MS = 5_000;

/**
 * A Dot's live mood: a short reaction to the tone of the user's newest message and to its own finished reply,
 * otherwise the mood of its status. Messages already on screen when a Dot is opened never trigger a reaction.
 */
export function useDotMood(character: DotCharacter | null, dotId: string | null, status: string,
  items: ReadonlyArray<Pick<DotFeedItem, "kind" | "author" | "content" | "status">>): DotMood {
  const [reaction, setReaction] = useState<DotMood | null>(null);
  const user = items.findLast((item) => item.kind === "MESSAGE" && item.author === "USER");
  const reply = items.findLast((item) => item.kind === "MESSAGE" && item.author === "DOT");
  // Live and stored copies of one message have different ids, so the content identifies it.
  const userKey = user ? user.content.slice(0, 500) : null;
  const replyKey = reply && (reply.status === "COMPLETED" || reply.status === "FAILED") ? `${reply.status}:${reply.content.slice(0, 500)}` : null;
  const seen = useRef<{ dotId: string | null; userKey: string | null; replyKey: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const previous = seen.current;
    seen.current = { dotId, userKey, replyKey };
    if (!character || !previous || previous.dotId !== dotId) { clearTimeout(timer.current); setReaction(null); return; }
    const personality = dotPersonalities[character];
    const mood = replyKey && replyKey !== previous.replyKey ? (reply!.status === "FAILED" ? "worried" : personality.onReply)
      : userKey && userKey !== previous.userKey ? personality.reactions[detectPromptTone(user!.content)] : null;
    // A reply that starts streaming changes nothing; a running reaction keeps its own end.
    if (!mood) return;
    clearTimeout(timer.current);
    setReaction(mood);
    timer.current = setTimeout(() => setReaction(null), REACTION_MS);
  }, [character, dotId, userKey, replyKey]);
  return reaction ?? statusMood(status);
}
