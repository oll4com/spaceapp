import { useEffect, useRef } from "react";
import { projectMemoryPoint, type MemoryPoint3D } from "../memory-workspace/memory-3d.js";

/**
 * Nous's emblem: a brain of memory nodes in 3D, drawn with the Space Memory 3D view's projection and turning slowly.
 * Two hemispheres of points on rippled half-ellipsoids, each node linked to its nearest neighbours. One static frame
 * when the dock is hidden or the user prefers reduced motion; faster while Nous thinks. With `firing` (the maximized view),
 * nodes light up and pass the spark to a neighbour while Nous thinks.
 */
const NODE_COUNT = 110;
const LINKS_PER_NODE = 2;

function brainNodes(): { points: MemoryPoint3D[]; links: Array<[number, number]> } {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: MemoryPoint3D[] = [];
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const y = 1 - (2 * (index + 0.5)) / NODE_COUNT;
    const ring = Math.sqrt(1 - y * y);
    const theta = index * golden;
    const x = Math.cos(theta) * ring;
    const z = Math.sin(theta) * ring;
    // Gyri: a gentle ripple over the surface; the hemispheres part along the middle; the base is flatter.
    const ripple = 1 + 0.07 * Math.sin(theta * 5) * Math.sin(y * 9);
    const side = x >= 0 ? 1 : -1;
    let height = y * 40 * ripple;
    if (height < -22) height = -22 + (height + 22) * 0.45;
    points.push({ x: x * 44 * ripple + side * 5, y: height, z: z * 58 * ripple });
  }
  const links: Array<[number, number]> = [];
  const seen = new Set<string>();
  points.forEach((point, index) => {
    const nearest = points.map((other, at) => ({ at, distance: (other.x - point.x) ** 2 + (other.y - point.y) ** 2 + (other.z - point.z) ** 2 }))
      .filter((entry) => entry.at !== index && Math.sign(points[entry.at]!.x) === Math.sign(point.x))
      .sort((left, right) => left.distance - right.distance).slice(0, LINKS_PER_NODE);
    for (const { at } of nearest) {
      const key = index < at ? `${index}:${at}` : `${at}:${index}`;
      if (!seen.has(key)) { seen.add(key); links.push([index, at]); }
    }
  });
  return { points, links };
}

const brain = brainNodes();

export function NousBrain3D({ size = 88, animate, thinking = false, firing = false }: { size?: number; animate: boolean; thinking?: boolean; firing?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thinkingRef = useRef(thinking);
  thinkingRef.current = thinking;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const color = getComputedStyle(canvas).color || "rgb(125, 211, 252)";
    const scale = size / 150;
    let yaw = 0.6;
    let frame = 0;
    let last = 0;
    // Firing nodes and how much light each has left (1 → 0).
    const sparks = new Map<number, number>();

    const draw = () => {
      context.clearRect(0, 0, size, size);
      const camera = { yaw, pitch: -0.28, zoom: 1 };
      const projected = brain.points.map((point) => projectMemoryPoint(point, camera, scale, size, size));
      context.strokeStyle = color;
      context.lineWidth = 0.6;
      for (const [from, to] of brain.links) {
        const a = projected[from]!;
        const b = projected[to]!;
        const lit = Math.max(sparks.get(from) ?? 0, sparks.get(to) ?? 0);
        context.globalAlpha = Math.max(0.08, Math.min(0.5, 0.3 - (a.z + b.z) / 400)) + lit * 0.5;
        context.lineWidth = 0.6 + lit;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      context.fillStyle = color;
      for (const point of [...projected].sort((left, right) => right.z - left.z)) {
        // Nearer nodes are larger and brighter: the depth reads without shading.
        context.globalAlpha = Math.max(0.25, Math.min(1, 0.7 - point.z / 120));
        context.beginPath();
        context.arc(point.x, point.y, Math.max(0.6, 1.5 * point.perspective * (size / 88)), 0, Math.PI * 2);
        context.fill();
      }
      for (const [index, light] of sparks) {
        const point = projected[index]!;
        const radius = Math.max(0.6, 1.5 * point.perspective * (size / 88));
        context.globalAlpha = light * 0.25;
        context.beginPath();
        context.arc(point.x, point.y, radius * 4, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = Math.min(1, light + 0.2);
        context.beginPath();
        context.arc(point.x, point.y, radius * 1.8, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    const fire = () => {
      for (const [index, light] of sparks) {
        const next = light - 0.05;
        // Halfway out a spark jumps once to a linked node, so thought runs along the network.
        if (light > 0.5 && next <= 0.5) {
          const link = brain.links.filter(([from, to]) => from === index || to === index)[Math.floor(Math.random() * LINKS_PER_NODE)];
          if (link) sparks.set(link[0] === index ? link[1] : link[0], 1);
        }
        if (next <= 0) sparks.delete(index); else sparks.set(index, next);
      }
      if (thinkingRef.current && sparks.size < 12 && Math.random() < 0.35) sparks.set(Math.floor(Math.random() * NODE_COUNT), 1);
    };

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    draw();
    if (!animate || reduced) return;
    const tick = (now: number) => {
      // About 30 frames a second is enough for a slow turn.
      if (now - last >= 33) {
        yaw += (thinkingRef.current ? 0.045 : 0.012) * Math.min(3, (now - (last || now)) / 33 || 1);
        last = now;
        if (firing) fire();
        draw();
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [animate, size, firing]);

  return <canvas ref={canvasRef} className="nous-brain" style={{ width: size, height: size }} role="img" aria-label="Nous, the mind of SpaceApp" />;
}
