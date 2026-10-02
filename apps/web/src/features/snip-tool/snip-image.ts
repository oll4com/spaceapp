export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export type Mark = { kind: "arrow" | "redact"; start: Point; end: Point } | { kind: "text"; start: Point; text: string };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function selection(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function fitRect(rect: Rect, width: number, height: number): Rect {
  const w = clamp(Math.round(rect.width), 1, width), h = clamp(Math.round(rect.height), 1, height);
  return { x: clamp(Math.round(rect.x), 0, width - w), y: clamp(Math.round(rect.y), 0, height - h), width: w, height: h };
}
export function drawMarks(ctx: CanvasRenderingContext2D, marks: Mark[], width: number) {
  const stroke = Math.max(3, width / 350);
  ctx.save();
  ctx.lineWidth = stroke;
  ctx.strokeStyle = "#ef4444";
  ctx.fillStyle = "#ef4444";
  ctx.lineCap = "round";
  for (const mark of marks) {
    // Redactions are composited LAST, including over later annotations.
    if (mark.kind === "redact") continue;
    if (mark.kind === "text") {
      ctx.font = `bold ${Math.max(20, width / 40)}px sans-serif`;
      ctx.textBaseline = "top";
      if (typeof ctx.strokeText === "function") {
        ctx.save();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = stroke + 2;
        ctx.strokeText(mark.text, mark.start.x, mark.start.y);
        ctx.restore();
      }
      ctx.fillText(mark.text, mark.start.x, mark.start.y);
    } else {
      const { start: a, end: b } = mark;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const size = Math.min(stroke * 5, Math.max(14, len * 0.35));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - size * Math.cos(angle - Math.PI / 6), b.y - size * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(b.x - size * Math.cos(angle + Math.PI / 6), b.y - size * Math.sin(angle + Math.PI / 6));
      if (typeof ctx.closePath === "function") ctx.closePath();
      if (typeof ctx.fill === "function") ctx.fill();
      else ctx.stroke();
    }
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
export async function exportSnip(image: HTMLImageElement, rect: Rect, marks: Mark[]): Promise<Blob> {
  const crop = fitRect(rect, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = crop.width; canvas.height = crop.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image editing is unavailable.");
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  ctx.translate(-crop.x, -crop.y);
  drawMarks(ctx, marks, image.naturalWidth);
  return canvasBlob(canvas);
}
