export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface MarkStyle { color?: string; size?: number }
export type ShapeKind = "arrow" | "rect" | "highlight" | "redact";
export type Mark =
  | ({ kind: ShapeKind; start: Point; end: Point } & MarkStyle)
  | ({ kind: "pen"; points: Point[] } & MarkStyle)
  | ({ kind: "text"; start: Point; text: string } & MarkStyle);

/** A decoded capture held in memory; crops and annotations are rendered from it once on export. */
export interface SnipFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
}

export const DEFAULT_MARK_COLOR = "#ef4444";
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function selection(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function fitRect(rect: Rect, width: number, height: number): Rect {
  const w = clamp(Math.round(rect.width), 1, width), h = clamp(Math.round(rect.height), 1, height);
  return { x: clamp(Math.round(rect.x), 0, width - w), y: clamp(Math.round(rect.y), 0, height - h), width: w, height: h };
}
export function strokeWidth(imageWidth: number, size = 1) {
  return Math.max(3, imageWidth / 350) * size;
}
export function textSize(imageWidth: number, size = 1) {
  return Math.max(20, imageWidth / 40) * size;
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Point, b: Point, stroke: number) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const head = Math.min(stroke * 5, Math.max(14, len * 0.35));
  // End the shaft inside the head so the round cap never pokes through the tip.
  const shaft = Math.max(0, len - head * 0.6);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x + Math.cos(angle) * shaft, a.y + Math.sin(angle) * shaft);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
  if (typeof ctx.closePath === "function") ctx.closePath();
  if (typeof ctx.fill === "function") ctx.fill();
  else ctx.stroke();
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Exclude<Mark, { kind: "redact" }>, width: number) {
  const color = mark.color || DEFAULT_MARK_COLOR;
  const stroke = strokeWidth(width, mark.size);
  ctx.lineWidth = stroke;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (mark.kind === "text") {
    ctx.font = `bold ${textSize(width, mark.size)}px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    if (typeof ctx.strokeText === "function") {
      ctx.save();
      ctx.strokeStyle = color === "#000000" ? "#ffffff" : "#000000";
      ctx.lineWidth = Math.max(3, stroke * 0.9);
      ctx.lineJoin = "round";
      ctx.strokeText(mark.text, mark.start.x, mark.start.y);
      ctx.restore();
    }
    ctx.fillText(mark.text, mark.start.x, mark.start.y);
  } else if (mark.kind === "pen") {
    const [first, ...rest] = mark.points;
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    if (!rest.length) ctx.lineTo(first.x + 0.01, first.y);
    for (const p of rest) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else if (mark.kind === "rect") {
    const r = selection(mark.start, mark.end);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
  } else if (mark.kind === "highlight") {
    const r = selection(mark.start, mark.end);
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.restore();
  } else {
    drawArrow(ctx, mark.start, mark.end, stroke);
  }
}

export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], width: number) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const mark of marks) {
    // Redactions are composited LAST, including over later annotations.
    if (mark.kind === "redact") continue;
    drawMark(ctx, mark, width);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000000";
  for (const mark of marks) {
    if (mark.kind !== "redact") continue;
    const r = selection(mark.start, mark.end);
    ctx.fillRect(Math.floor(r.x), Math.floor(r.y), Math.ceil(r.x + r.width) - Math.floor(r.x), Math.ceil(r.y + r.height) - Math.floor(r.y));
  }
  ctx.restore();
}
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image export failed. Please retry.")), "image/png"));
}
/** Renders the crop and annotations straight from the in-memory frame: a single PNG encode. */
export async function exportSnip(frame: SnipFrame, rect: Rect, marks: Mark[]): Promise<Blob> {
  const crop = fitRect(rect, frame.width, frame.height);
  const canvas = document.createElement("canvas");
  canvas.width = crop.width; canvas.height = crop.height;
  // A software canvas encodes without a GPU readback, which dominates export time on large snips.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Image editing is unavailable.");
  ctx.drawImage(frame.source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  if (marks.length) {
    ctx.translate(-crop.x, -crop.y);
    drawMarks(ctx, marks, frame.width);
  }
  return canvasBlob(canvas);
}
export function canvasFrame(canvas: HTMLCanvasElement): SnipFrame {
  return { source: canvas, width: canvas.width, height: canvas.height, close: () => { canvas.width = 0; canvas.height = 0; } };
}
/** Copies a region into its own frame so the editor works at the snip's scale. Returns the input when no copy is needed or possible. */
export function cropFrame(frame: SnipFrame, rect: Rect): SnipFrame {
  const r = fitRect(rect, frame.width, frame.height);
  if (r.x === 0 && r.y === 0 && r.width === frame.width && r.height === frame.height) return frame;
  const canvas = document.createElement("canvas");
  canvas.width = r.width; canvas.height = r.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return frame;
  ctx.drawImage(frame.source, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return canvasFrame(canvas);
}
/** Decodes an image file or capture blob, off the main thread when the browser supports it. */
export async function frameFromBlob(blob: Blob): Promise<SnipFrame> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch { /* Fall back to an image element below. */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("The image could not be opened.");
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
