import type { ArenaFrameState } from "./arena-types.js";

/**
 * Draws server snapshots of the Asteroids Agent Arena. Frames arrive at 10 fps;
 * the viewer interpolates between two consecutive frames so playback stays
 * smooth at the display refresh rate.
 */

export const WORLD_WIDTH = 960;
export const WORLD_HEIGHT = 540;
const FRAME_SECONDS = 0.1;
const PICKUP_COLORS = ["#4dd8ff", "#7cf29a", "#ffb347"];
const PICKUP_LETTERS = ["S", "R", "B"];
const HOSTILE = "#ff5c5c";

export interface PilotLook {
  color: string;
  label: string;
}

export interface ActiveFx {
  kind: number;
  x: number;
  y: number;
  color: string;
  born: number;
}

const FX_LIFE_MS = [450, 450, 650, 260, 300, 420, 800];

function hash(value: number): number {
  let x = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function lerpWrapped(from: number, to: number, alpha: number, size: number): number {
  const delta = to - from;
  if (Math.abs(delta) > size / 2) return to;
  return from + delta * alpha;
}

function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}

/** Wraps a polygon around the edges by drawing it again on the far side when it overlaps. */
function wrapped(x: number, y: number, radius: number, draw: (ox: number, oy: number) => void): void {
  const offsetsX = [0];
  const offsetsY = [0];
  if (x < radius) offsetsX.push(WORLD_WIDTH);
  if (x > WORLD_WIDTH - radius) offsetsX.push(-WORLD_WIDTH);
  if (y < radius) offsetsY.push(WORLD_HEIGHT);
  if (y > WORLD_HEIGHT - radius) offsetsY.push(-WORLD_HEIGHT);
  for (const ox of offsetsX) for (const oy of offsetsY) draw(x + ox, y + oy);
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#060a11";
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  ctx.strokeStyle = "rgba(142, 230, 255, 0.045)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= WORLD_WIDTH; x += 60) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_HEIGHT);
  }
  for (let y = 0; y <= WORLD_HEIGHT; y += 60) {
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD_WIDTH, y);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  for (let index = 0; index < 60; index += 1) {
    const size = index % 5 === 0 ? 1.6 : 0.9;
    ctx.fillRect(hash(index * 7 + 1) * WORLD_WIDTH, hash(index * 13 + 5) * WORLD_HEIGHT, size, size);
  }
}

function drawRock(ctx: CanvasRenderingContext2D, id: number, x: number, y: number, size: number, angle: number): void {
  const radius = size === 3 ? 38 : size === 2 ? 22 : 12;
  const points = 9 + (id % 4);
  wrapped(x, y, radius, (ox, oy) => {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(angle);
    ctx.beginPath();
    for (let index = 0; index < points; index += 1) {
      const r = radius * (0.74 + hash(id * 31 + index) * 0.3);
      const a = (index / points) * Math.PI * 2;
      if (index === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = "#121821";
    ctx.fill();
    ctx.strokeStyle = size === 1 ? "#c9d4e2" : "#8b97a8";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  });
}

function drawDrone(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, angle: number, hp: number): void {
  wrapped(x, y, 18, (ox, oy) => {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.rotate(angle);
    ctx.shadowColor = HOSTILE;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = kind === 0 ? HOSTILE : "#ff9d3d";
    ctx.fillStyle = kind === 0 ? "rgba(255,92,92,0.18)" : "rgba(255,157,61,0.16)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (kind === 0) {
      ctx.moveTo(13, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-8, 9);
    } else {
      for (let index = 0; index < 6; index += 1) {
        const a = (index / 6) * Math.PI * 2;
        if (index === 0) ctx.moveTo(Math.cos(a) * 15, Math.sin(a) * 15);
        else ctx.lineTo(Math.cos(a) * 15, Math.sin(a) * 15);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (hp > 1) {
      ctx.fillStyle = "#ffd1d1";
      ctx.font = "bold 9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(hp), ox, oy + 3);
    }
  });
}

function drawShip(ctx: CanvasRenderingContext2D, ship: number[], look: PilotLook, time: number, showLabel: boolean): void {
  const [, x = 0, y = 0, angleCenti = 0, hull = 0, shield = 0, flags = 0] = ship;
  if ((flags & 1) === 0) return;
  const angle = angleCenti / 100;
  const immune = (flags & 4) !== 0;
  wrapped(x, y, 24, (ox, oy) => {
    ctx.save();
    ctx.translate(ox, oy);
    if (shield > 0) {
      ctx.strokeStyle = look.color;
      ctx.globalAlpha = 0.25 + shield * 0.12;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, 21, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.rotate(angle);
    if ((flags & 2) !== 0) {
      ctx.fillStyle = (flags & 8) !== 0 ? "#ffffff" : "#ffb347";
      ctx.beginPath();
      ctx.moveTo(-9, -4);
      ctx.lineTo(-17 - (Math.sin(time / 40) + 1) * 4, 0);
      ctx.lineTo(-9, 4);
      ctx.fill();
    }
    ctx.globalAlpha = immune ? 0.45 + 0.45 * Math.abs(Math.sin(time / 90)) : 1;
    ctx.shadowColor = look.color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = "#0d1420";
    ctx.strokeStyle = look.color;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-11, -9);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-11, 9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
  if (showLabel) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.fillStyle = look.color;
    ctx.fillText(look.label, x, y - 27);
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = hull > 2 ? "#7cf29a" : "#ff5c7a";
    ctx.fillText("■".repeat(Math.max(0, hull)) + "□".repeat(Math.max(0, 5 - hull)), x, y + 30);
    ctx.restore();
  }
}

function drawFx(ctx: CanvasRenderingContext2D, effects: ActiveFx[], now: number): void {
  for (const effect of effects) {
    const life = FX_LIFE_MS[effect.kind] ?? 400;
    const progress = (now - effect.born) / life;
    if (progress < 0 || progress > 1) continue;
    const maxRadius = effect.kind === 2 ? 220 : effect.kind === 6 ? 60 : effect.kind === 1 ? 34 : effect.kind === 0 ? 28 : effect.kind === 4 ? 22 : 16;
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = effect.kind === 2 ? 3 : 2;
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, 4 + maxRadius * progress, 0, Math.PI * 2);
    ctx.stroke();
    if (effect.kind === 0 || effect.kind === 1 || effect.kind === 6) {
      for (let index = 0; index < 8; index += 1) {
        const a = (index / 8) * Math.PI * 2 + effect.x;
        const r = maxRadius * progress * (0.6 + hash(index + effect.y) * 0.6);
        ctx.fillStyle = effect.color;
        ctx.fillRect(effect.x + Math.cos(a) * r, effect.y + Math.sin(a) * r, 2, 2);
      }
    }
    ctx.restore();
  }
}

export function fxColor(kind: number, slot: number, looks: PilotLook[]): string {
  if (kind === 3) return "#ffffff";
  if (kind === 5) return "#7cf29a";
  if (slot >= 0 && looks[slot]) return looks[slot]!.color;
  return kind === 1 ? "#ff9d3d" : "#c9d4e2";
}

/**
 * Renders one arena: `from` is the frame being left, `to` the frame being
 * approached (or null), and `alpha` how far between them playback is.
 */
export function drawArenaFrame(
  ctx: CanvasRenderingContext2D,
  from: ArenaFrameState,
  to: ArenaFrameState | null,
  alpha: number,
  looks: PilotLook[],
  options: { labels: boolean; effects: ActiveFx[]; now: number; overlay?: string | null }
): void {
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WORLD_WIDTH, 0, 0, canvas.height / WORLD_HEIGHT, 0, 0);
  drawBackground(ctx);
  const next = to ?? from;
  const t = to ? Math.max(0, Math.min(1, alpha)) : 0;

  const oldRocks = new Map(from.r.map((rock) => [rock[0], rock]));
  for (const rock of next.r) {
    const [id = 0, x = 0, y = 0, size = 3, angle = 0] = rock;
    const previous = oldRocks.get(id);
    const px = previous ? lerpWrapped(previous[1] ?? x, x, t, WORLD_WIDTH) : x;
    const py = previous ? lerpWrapped(previous[2] ?? y, y, t, WORLD_HEIGHT) : y;
    const pa = previous ? lerpAngle((previous[4] ?? angle) / 100, angle / 100, t) : angle / 100;
    drawRock(ctx, id, px, py, size, pa);
  }

  for (const pickup of next.p) {
    const [kind = 0, x = 0, y = 0, ttl = 0] = pickup;
    const blink = ttl < 25 && Math.floor(options.now / 150) % 2 === 0;
    if (blink) continue;
    ctx.save();
    ctx.strokeStyle = PICKUP_COLORS[kind] ?? "#fff";
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 11 + Math.sin(options.now / 200) * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(PICKUP_LETTERS[kind] ?? "?", x, y + 4);
    ctx.restore();
  }

  const oldDrones = new Map(from.d.map((drone) => [drone[5], drone]));
  for (const drone of next.d) {
    const [kind = 0, x = 0, y = 0, angle = 0, hp = 1, id = 0] = drone;
    const previous = oldDrones.get(id);
    const px = previous ? lerpWrapped(previous[1] ?? x, x, t, WORLD_WIDTH) : x;
    const py = previous ? lerpWrapped(previous[2] ?? y, y, t, WORLD_HEIGHT) : y;
    drawDrone(ctx, kind, px, py, previous ? lerpAngle((previous[3] ?? angle) / 100, angle / 100, t) : angle / 100, hp);
  }

  // Shots move in straight lines: advance the older frame's shots by elapsed time.
  for (const shot of from.b) {
    const [x = 0, y = 0, vx = 0, vy = 0, owner = -1] = shot;
    const sx = (((x + vx * FRAME_SECONDS * t) % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH;
    const sy = (((y + vy * FRAME_SECONDS * t) % WORLD_HEIGHT) + WORLD_HEIGHT) % WORLD_HEIGHT;
    ctx.save();
    if (owner < 0) {
      ctx.fillStyle = HOSTILE;
      ctx.shadowColor = HOSTILE;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const color = looks[owner]?.color ?? "#ffffff";
      const speed = Math.hypot(vx, vy) || 1;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - (vx / speed) * 10, sy - (vy / speed) * 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  const oldShips = new Map(from.s.map((ship) => [ship[0], ship]));
  for (const ship of next.s) {
    const slot = ship[0] ?? 0;
    const previous = oldShips.get(slot);
    const look = looks[slot] ?? { color: "#ffffff", label: `P${slot + 1}` };
    if (!previous || ((previous[6] ?? 0) & 1) === 0) {
      drawShip(ctx, ship, look, options.now, options.labels);
      continue;
    }
    const blended = [...ship];
    blended[1] = lerpWrapped(previous[1] ?? 0, ship[1] ?? 0, t, WORLD_WIDTH);
    blended[2] = lerpWrapped(previous[2] ?? 0, ship[2] ?? 0, t, WORLD_HEIGHT);
    blended[3] = lerpAngle((previous[3] ?? 0) / 100, (ship[3] ?? 0) / 100, t) * 100;
    drawShip(ctx, blended, look, options.now, options.labels);
  }

  drawFx(ctx, options.effects, options.now);

  if (options.overlay) {
    ctx.save();
    ctx.fillStyle = "rgba(6,10,17,0.62)";
    ctx.fillRect(0, WORLD_HEIGHT / 2 - 26, WORLD_WIDTH, 52);
    ctx.fillStyle = "#e6f6ff";
    ctx.font = "600 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(options.overlay, WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    ctx.restore();
  }
}

export function drawIdleArena(ctx: CanvasRenderingContext2D, title: string, subtitle: string): void {
  const canvas = ctx.canvas;
  ctx.setTransform(canvas.width / WORLD_WIDTH, 0, 0, canvas.height / WORLD_HEIGHT, 0, 0);
  drawBackground(ctx);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#8ee6ff";
  ctx.font = "600 24px system-ui, sans-serif";
  ctx.fillText(title, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 16);
  ctx.fillStyle = "#9aa4b2";
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillText(subtitle, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 18);
  ctx.restore();
}
