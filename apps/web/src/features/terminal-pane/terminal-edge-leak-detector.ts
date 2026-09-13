import { terminalPaintIsStale } from "./terminal-paint-recovery.js";

interface EdgeLeakCell {
  getChars: () => string;
  getWidth: () => number;
  isInvisible: () => boolean;
}

interface EdgeLeakLine {
  length: number;
  getCell: (x: number) => EdgeLeakCell | undefined;
}

interface EdgeLeakTerminal {
  cols: number;
  rows: number;
  modes?: { synchronizedOutputMode?: boolean };
  buffer: {
    active: {
      viewportY: number;
      getLine: (y: number) => EdgeLeakLine | undefined | null;
    };
  };
}

export interface TerminalEdgeLeakCounters {
  scannedRows: number;
  fragRows: number;
  fragTruecolor: number;
  frag256: number;
  fragCup: number;
  fragPartial: number;
  fragEsc: number;
  wideRows: number;
  ambiguousRows: number;
  ambiguousCells: number;
  overflowPx: number;
  viewportY: number;
  staleDom: boolean;
}

/**
 * ANSI residue that must never survive into the visible xterm buffer as
 * plain text. Opentui run-length emission occasionally drops the CSI
 * introducer at style-run boundaries; the output coordinator repairs the
 * known truecolor/CUP shapes, but any residue that still reaches the grid
 * (or a future unknown shape) shows up as visible `38;2;…`, `;255;` or
 * `row;colH` fragments — exactly the side garbage reported on scrollback.
 * Matching is in-memory only; the function returns counts, never text.
 */
const BUFFER_FRAG_PATTERN = /\x1b|(?:38|48|58);(?:2|5);|\d+;\d+H|;\d/;

/**
 * Redacted shape of a buffer-resident fragment: which ANSI family the
 * residue belongs to, or `partial` for bare middles such as `;255;`.
 * Returns a bucket id only — never the matched text.
 */
function classifyFragShape(visibleText: string): "esc" | "truecolor" | "pal256" | "cup" | "partial" {
  if (visibleText.includes("\x1b")) return "esc";
  if (/(?:38|48|58);2;/.test(visibleText)) return "truecolor";
  if (/(?:38|48|58);5;/.test(visibleText)) return "pal256";
  if (/\d+;\d+H/.test(visibleText)) return "cup";
  return "partial";
}

function isAmbiguousCodePoint(code: number): boolean {
  return (
    (code >= 0x2013 && code <= 0x2014) ||
    (code >= 0x2018 && code <= 0x201f) ||
    code === 0x2026 ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Scan the currently visible grid for edge-leak evidence. Returns numeric
 * counters only — row text is tested in memory and discarded, so terminal
 * input/output, clipboard and file content can never leave this function.
 */
export function scanTerminalEdgeLeak(
  terminal: unknown,
  host: HTMLElement
): TerminalEdgeLeakCounters | null {
  if (!terminal || typeof terminal !== "object") return null;
  const grid = terminal as EdgeLeakTerminal;
  const rows = grid.rows;
  const cols = grid.cols;
  const active = grid.buffer?.active;
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(cols) || cols <= 0 || !active) {
    return null;
  }
  const viewportY = Number.isInteger(active.viewportY) && active.viewportY >= 0 ? active.viewportY : 0;
  let scannedRows = 0;
  let fragRows = 0;
  let fragTruecolor = 0;
  let frag256 = 0;
  let fragCup = 0;
  let fragPartial = 0;
  let fragEsc = 0;
  let wideRows = 0;
  let ambiguousRows = 0;
  let ambiguousCells = 0;
  for (let y = 0; y < rows; y += 1) {
    let line: EdgeLeakLine | undefined | null = null;
    try {
      line = active.getLine(viewportY + y);
    } catch {
      continue;
    }
    if (!line) continue;
    scannedRows += 1;
    // Build the tested string from visible cells only, mirroring
    // terminalPaintIsStale: concealed cells must never influence the result.
    const cellCount = Math.min(line.length, cols);
    let visibleText = "";
    let rowHasWide = false;
    let rowHasAmbiguous = false;
    for (let x = 0; x < cellCount && visibleText.length <= 2048; x += 1) {
      let cell: EdgeLeakCell | undefined = undefined;
      try {
        cell = line.getCell(x);
      } catch {
        continue;
      }
      if (!cell) continue;
      let invisible = false;
      let width = 0;
      let chars = "";
      try {
        invisible = cell.isInvisible();
        if (invisible) continue;
        width = cell.getWidth();
        chars = cell.getChars() ?? "";
      } catch {
        continue;
      }
      if (chars.length === 0) continue;
      visibleText += chars;
      if (width === 2) rowHasWide = true;
      const code = chars.codePointAt(0);
      if (code !== undefined && isAmbiguousCodePoint(code)) {
        rowHasAmbiguous = true;
        ambiguousCells += 1;
      }
    }
    if (visibleText.length > 0 && BUFFER_FRAG_PATTERN.test(visibleText)) {
      fragRows += 1;
      const shape = classifyFragShape(visibleText);
      if (shape === "esc") fragEsc += 1;
      else if (shape === "truecolor") fragTruecolor += 1;
      else if (shape === "pal256") frag256 += 1;
      else if (shape === "cup") fragCup += 1;
      else fragPartial += 1;
    }
    if (rowHasWide) wideRows += 1;
    if (rowHasAmbiguous) ambiguousRows += 1;
  }
  let overflowPx = 0;
  try {
    const hostWidth = positiveDimension(
      (host as HTMLElement).clientWidth || host.getBoundingClientRect().width || 0
    );
    const screenWidth = positiveDimension(
      host.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect().width ?? 0
    );
    if (hostWidth > 0 && screenWidth > hostWidth) overflowPx = Math.round(screenWidth - hostWidth);
  } catch {
    overflowPx = 0;
  }
  let staleDom = false;
  try {
    staleDom = terminalPaintIsStale(
      terminal as unknown as Parameters<typeof terminalPaintIsStale>[0],
      host
    );
  } catch {
    staleDom = false;
  }
  return {
    scannedRows,
    fragRows,
    fragTruecolor,
    frag256,
    fragCup,
    fragPartial,
    fragEsc,
    wideRows,
    ambiguousRows,
    ambiguousCells,
    overflowPx,
    viewportY,
    staleDom
  };
}

export const TERMINAL_EDGE_LEAK_MIN_EMIT_MS = 10_000;

/**
 * Emission gate: record only when there is a real signal (buffer-resident
 * ANSI residue, stale DOM rows, or horizontal overflow) and at most once
 * per throttle window per pane, so idle terminals stay silent.
 */
export function edgeLeakShouldEmit(
  counters: TerminalEdgeLeakCounters,
  lastEmitAtMs: number | null,
  nowMs: number
): boolean {
  const signal = counters.fragRows > 0 || counters.staleDom || counters.overflowPx > 2;
  if (!signal) return false;
  if (lastEmitAtMs === null) return true;
  return nowMs - lastEmitAtMs >= TERMINAL_EDGE_LEAK_MIN_EMIT_MS;
}
