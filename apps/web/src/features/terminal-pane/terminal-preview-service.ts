export interface TerminalPreviewSnapshot {
  lines: string[];
  lastUpdated: number;
}

export interface TerminalPreviewActivity {
  /** What the CLI says it is doing, e.g. "Thinking…". Null when only a timer was seen. */
  label: string | null;
  /** Elapsed time printed next to the spinner, e.g. "1m 3s". */
  elapsed: string | null;
}

export interface TerminalPreviewSummary {
  /** Meaningful output lines (TUI chrome removed), oldest first. */
  lines: string[];
  activity: TerminalPreviewActivity | null;
  /** When the activity line was last redrawn; 0 when it came from a static screen. */
  activityAt: number;
  /** Most recent approval/confirmation prompt still on screen. */
  attention: string | null;
  lastUpdated: number;
}

export type TerminalPreviewLine =
  | { kind: "content"; text: string }
  | { kind: "chrome"; text: string }
  | { kind: "activity"; text: string; activity: TerminalPreviewActivity };

interface PanePreviewState {
  lines: string[];
  pending: string;
  lastUpdated: number;
  activity: TerminalPreviewActivity | null;
  activityAt: number;
  /** When the last real output row arrived; a spinner redrawn after it means the CLI moved on. */
  contentAt: number;
  /** Tracked cursor position, so positioned writes on one row stay one line. Null when unknown. */
  cursorRow: number | null;
  cursorCol: number | null;
}

type TerminalPreviewGetter = () => string[];

const MAX_PREVIEW_LINES = 40;
const MENU_WINDOW = 5;
const QUESTION_WINDOW = 3;
const MENU_QUESTION_WINDOW = 12;

const terminalPreviewGetters = new Map<string, TerminalPreviewGetter>();
const terminalPreviewCache = new Map<string, TerminalPreviewSnapshot>();
const previewStateByPane = new Map<string, PanePreviewState>();
const listeners = new Set<(paneId?: string) => void>();

let throttleTimer: ReturnType<typeof setTimeout> | null = null;
const pendingThrottledPanes = new Set<string>();

// Cursor moves and cursor restores; see flattenCursorMoves.
const CURSOR_MOVE = /\x1b\[(\d*)(?:;(\d*))?([HfGCABEFd])|\x1b8|\x1b\[u/g;
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const BOX_BORDER_LEFT = /^\s*[│┃║▌▎]\s?/;
const BOX_BORDER_RIGHT = /\s*[│┃║]\s*$/;
const HAS_TWO_LETTERS = /\p{L}.*\p{L}/su;
// Spinners print the hint inside their parentheses: "(12s · esc to interrupt)", "(esc to cancel, 5s)".
const SPINNER_INTERRUPT = /\([^)]*\besc to (?:interrupt|cancel)\b/i;
const SPINNER_VERB = /^\s*[✢✳✶✻✽✺✹✸✷*·⠁-⣿]\s+[A-Z][a-z]+(?:\s[a-z]+){0,3}(?:…|\.\.\.)/;
// OpenCode shows a sliding "■⬝⬝⬝⬝" bar and "esc interrupt" while it works, with no step label.
const BUSY_BAR = /[■⬝]{4,}|\besc interrupt\b/i;
const ELAPSED = /\b(?:\d+h\s*)?(?:\d+m\s*)?\d+s\b/;
const KEY_HINT = /\b(?:ctrl|alt|shift|cmd|option)\s*\+|[⌃⇧⌥⌘⏎]/gi;
const FOOTER_HINT = new RegExp(
  [
    "bypass permissions",
    "shift\\+tab",
    "\\? for shortcuts",
    "auto-accept edits",
    "accept edits on",
    "plan mode on",
    "context left",
    "until auto-compact",
    "\\bno sandbox\\b",
    "\\byolo mode\\b",
    "^\\s*using:? \\d+ .*\\b(?:files?|servers?)\\b",
    "\\bctrl\\+[a-z] to (?:expand|show|hide|toggle|cycle|quit|exit|edit|open)\\b",
    "\\btokens? (?:remaining|left|used)\\b",
    "\\bcontext (?:remaining|used|window)\\b",
    "^\\s*\\d+(?:\\.\\d+)?k\\s+context\\b",
    "\\bpress (?:esc|ctrl\\+c) (?:again |twice )?to\\b",
    "\\benter to (?:confirm|select|submit)\\b",
    "\\besc to (?:cancel|go back|exit)\\b",
    "\\b(?:tab|ctrl\\+[a-z]) (?:agents|commands|sessions|models)\\b",
    "^\\s*(?:build|plan) · ",
    "^\\s*(?:~|\\/)\\S*\\/\\S*.*\\s{2,}\\S",
    "\\s·\\s~\\/",
    "\\b\\d+(?:\\.\\d+)?K \\(\\d+%\\)",
    "^\\s*▣\\s",
    "\\bMCPs? /status\\b",
    "^\\s*/update to upgrade\\b"
  ].join("|"),
  "i"
);
const INPUT_PLACEHOLDER =
  /^\s*(?:[>❯›»]\s+Try "|(?:[>❯›»]\s+)?(?:Type your message|Ask Codex to do anything|Ask anything…|Send a message))/i;
// A highlighted numbered option means the CLI is waiting for a choice: "❯ 1. Yes", "● 1. Trust folder".
const SELECTION_MENU = /^\s*[❯›>●◉▸]\s*\d+\.\s+\S/;
const ATTENTION = new RegExp(
  [
    "\\bdo you want to\\b",
    "\\bdo you trust\\b",
    "\\bone you trust\\b",
    "\\bwould you like to (?:proceed|run|allow|apply|continue)\\b",
    "\\ballow (?:this|execution|command|once|always|access|tool)\\b",
    "\\bpermission (?:required|needed|request)",
    "\\bwaiting for (?:your )?(?:approval|confirmation|input|response)\\b",
    "\\(y/n\\)|\\[y/n\\]",
    "\\bpress enter to (?:continue|confirm)\\b",
    "\\byes, and don't ask again\\b",
    "\\bapply (?:this|these) changes?\\?"
  ].join("|"),
  "i"
);

export function cleanTerminalAnsi(text: string): string {
  if (!text) return "";
  return text
    .replace(CSI_SEQUENCE, "")
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "")
    .replace(/\x1b[\x20-\x7e]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function printedLength(segment: string): number {
  return segment.includes("\x1b") ? segment.replace(CSI_SEQUENCE, "").length : segment.length;
}

/**
 * TUIs place text with cursor jumps instead of spaces and newlines. A jump to
 * another row becomes a line break; a jump along the same row becomes spaces
 * (or nothing when the text simply continues), so words stay on one line.
 * Columns are measured only when a same-row jump needs them.
 */
function flattenCursorMoves(chunk: string, state: PanePreviewState): string {
  let scanned = 0;
  let colBase = state.cursorCol;
  let colFrom = 0;
  const consumeLineFeeds = (end: number) => {
    let feed = chunk.indexOf("\n", scanned);
    let lastFeed = -1;
    let count = 0;
    while (feed !== -1 && feed < end) {
      count++;
      lastFeed = feed;
      feed = chunk.indexOf("\n", feed + 1);
    }
    scanned = end;
    if (count === 0) return;
    if (state.cursorRow !== null) state.cursorRow += count;
    colBase = 1;
    colFrom = lastFeed + 1;
  };
  const columnAt = (end: number): number | null => {
    let base = colBase;
    let from = colFrom;
    const carriage = chunk.lastIndexOf("\r", end - 1);
    if (carriage >= from) {
      base = 1;
      from = carriage + 1;
    }
    return base === null ? null : base + printedLength(chunk.slice(from, end));
  };
  const moveColumn = (col: number | null, from: number) => {
    colBase = col;
    colFrom = from;
  };

  const flattened = chunk.replace(
    CURSOR_MOVE,
    (match: string, first: string | undefined, second: string | undefined, op: string | undefined, offset: number) => {
      consumeLineFeeds(offset);
      const after = offset + match.length;
      scanned = after;
      const sameRowJump = (target: number): string => {
        const col = columnAt(offset);
        moveColumn(target, after);
        // Back to column 1 rewrites the row, exactly like a carriage return.
        if (target === 1 && col !== 1) return "\r";
        if (col === null) return " ";
        if (target > col) return " ".repeat(Math.min(target - col, 8));
        return target === col ? "" : "\n";
      };
      switch (op) {
        case "H":
        case "f": {
          const row = Number(first || 1);
          if (state.cursorRow === row) return sameRowJump(Number(second || 1));
          state.cursorRow = row;
          moveColumn(Number(second || 1), after);
          return "\n";
        }
        case "G":
          return sameRowJump(Number(first || 1));
        case "C": {
          const col = columnAt(offset);
          moveColumn(col === null ? null : col + Number(first || 1), after);
          return " ";
        }
        case "d":
          state.cursorRow = Number(first || 1);
          moveColumn(null, after);
          return "\n";
        default:
          // Relative vertical moves (A/B/E/F) and cursor restores.
          state.cursorRow = null;
          moveColumn(op === "E" || op === "F" ? 1 : null, after);
          return "\n";
      }
    }
  );
  consumeLineFeeds(chunk.length);
  state.cursorCol = chunk.length - colFrom > 512 ? null : columnAt(chunk.length);
  return flattened;
}

/** Text after the last carriage return wins, as on a real screen; "\r\r\n" endings keep their row. */
function lastCarriageSegment(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  const index = trimmed.lastIndexOf("\r");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function normalizePreviewLine(raw: string): string {
  let line = raw.replace(/\s+$/, "");
  if (BOX_BORDER_LEFT.test(line)) {
    line = line.replace(BOX_BORDER_LEFT, "").replace(BOX_BORDER_RIGHT, "");
  }
  line = line
    .replace(/^(\s*)⏺(?=\s)/, "$1●")
    .replace(/^(\s*)⎿(?=\s)/, "$1└")
    .replace(/(\S)\s{4,}(?=\S)/g, "$1   ")
    .replace(/^\s{5,}/, "    ")
    .replace(/\s*[─━―═╌┄-]{3,}$/, "");
  return line.length > 240 ? line.slice(0, 240) : line;
}

function parseActivity(text: string): TerminalPreviewActivity {
  const body = text.replace(/^[^\p{L}\p{N}]+/u, "");
  const label = body.split("(")[0]?.replace(/[\s·•,]+$/, "").trim() ?? "";
  const elapsed = text.match(ELAPSED)?.[0].replace(/\s+/g, " ") ?? null;
  return {
    label: label && /^\p{L}/u.test(label) ? label.slice(0, 48) : null,
    elapsed
  };
}

function mergeActivity(
  previous: TerminalPreviewActivity | null,
  next: TerminalPreviewActivity
): TerminalPreviewActivity {
  return { label: next.label ?? previous?.label ?? null, elapsed: next.elapsed ?? previous?.elapsed ?? null };
}

// TUIs redraw the same separator, prompt and footer rows every frame, so most rows repeat.
const classifiedLineCache = new Map<string, TerminalPreviewLine>();
const CLASSIFIED_LINE_CACHE_LIMIT = 512;
const BLANK_LINE: TerminalPreviewLine = { kind: "chrome", text: "" };

/** Sorts one terminal row into real output, TUI chrome (borders, prompts, key hints) or a spinner. */
export function classifyTerminalPreviewLine(raw: string): TerminalPreviewLine {
  if (!/\S/.test(raw)) return BLANK_LINE;
  const cached = classifiedLineCache.get(raw);
  if (cached) return cached;
  const classified = classifyNormalizedLine(normalizePreviewLine(raw));
  if (classifiedLineCache.size >= CLASSIFIED_LINE_CACHE_LIMIT) classifiedLineCache.clear();
  classifiedLineCache.set(raw, classified);
  return classified;
}

function classifyNormalizedLine(text: string): TerminalPreviewLine {
  if (text.trim().length < 3) return { kind: "chrome", text };
  if (SPINNER_INTERRUPT.test(text) || SPINNER_VERB.test(text)) {
    return { kind: "activity", text, activity: parseActivity(text) };
  }
  if (BUSY_BAR.test(text)) return { kind: "activity", text, activity: { label: null, elapsed: null } };
  if (ATTENTION.test(text) || SELECTION_MENU.test(text)) return { kind: "content", text };
  if (!HAS_TWO_LETTERS.test(text)) return { kind: "chrome", text };
  if (FOOTER_HINT.test(text) || INPUT_PLACEHOLDER.test(text)) return { kind: "chrome", text };
  if ((text.match(KEY_HINT)?.length ?? 0) >= 2) return { kind: "chrome", text };
  return { kind: "content", text };
}

function pushContentLine(lines: string[], text: string): void {
  if (lines[lines.length - 1] === text) return;
  lines.push(text);
}

/** Newest-first walk that keeps the latest copy of each line, so TUI redraws do not repeat. */
function latestUniqueLines(lines: readonly string[], maxLines: number): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (let i = lines.length - 1; i >= 0 && picked.length < maxLines; i--) {
    const line = lines[i]!;
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(line);
  }
  return picked.reverse();
}

function questionText(line: string): string {
  const trimmed = line.trim();
  const mark = trimmed.indexOf("?");
  return mark === -1 ? trimmed : trimmed.slice(0, mark + 1);
}

/**
 * A pending choice: a highlighted numbered option near the bottom (its question
 * may sit a few rows higher), or an approval question on the last rows.
 */
function detectAttention(lines: readonly string[]): string | null {
  if (lines.slice(-MENU_WINDOW).some((line) => SELECTION_MENU.test(line))) {
    const question = lines.slice(-MENU_QUESTION_WINDOW).findLast((line) => line.includes("?") && !SELECTION_MENU.test(line));
    return question ? questionText(question) : "Waiting for a choice";
  }
  const prompt = lines.slice(-QUESTION_WINDOW).findLast((line) => ATTENTION.test(line));
  return prompt ? questionText(prompt) : null;
}

function ingestLines(rawLines: readonly string[]): {
  lines: string[];
  activity: TerminalPreviewActivity | null;
} {
  const lines: string[] = [];
  let activity: TerminalPreviewActivity | null = null;
  for (const raw of rawLines) {
    if (typeof raw !== "string") continue;
    const classified = classifyTerminalPreviewLine(raw);
    if (classified.kind === "content") pushContentLine(lines, classified.text);
    else if (classified.kind === "activity") activity = mergeActivity(activity, classified.activity);
  }
  return { lines: lines.slice(-MAX_PREVIEW_LINES), activity };
}

/** Summarizes a static screen (xterm viewport or transcript) the same way as streamed output. */
export function summarizeTerminalPreviewLines(
  rawLines: readonly string[],
  maxLines = 5,
  lastUpdated = 0
): TerminalPreviewSummary {
  const { lines, activity } = ingestLines(rawLines);
  return {
    lines: latestUniqueLines(lines, maxLines),
    activity,
    activityAt: 0,
    attention: detectAttention(lines),
    lastUpdated
  };
}

export function registerTerminalPreviewGetter(paneId: string, getter: TerminalPreviewGetter): () => void {
  terminalPreviewGetters.set(paneId, getter);
  notifyTerminalPreviewChanged(paneId);
  return () => {
    if (terminalPreviewGetters.get(paneId) === getter) {
      terminalPreviewGetters.delete(paneId);
      previewStateByPane.delete(paneId);
      terminalPreviewCache.delete(paneId);
      notifyTerminalPreviewChanged(paneId);
    }
  };
}

export function seedTerminalPreviewLines(paneId: string, lines: string[]): void {
  if (!lines || lines.length === 0) return;
  const now = Date.now();
  const ingested = ingestLines(lines);
  previewStateByPane.set(paneId, {
    lines: ingested.lines,
    pending: "",
    lastUpdated: now,
    activity: ingested.activity,
    activityAt: ingested.activity ? now : 0,
    contentAt: now,
    cursorRow: null,
    cursorCol: null
  });
  terminalPreviewCache.set(paneId, {
    lines: ingested.lines,
    lastUpdated: now
  });
  notifyTerminalPreviewChangedThrottled(paneId);
}

export function appendTerminalPreviewChunk(paneId: string, rawChunk: string): void {
  if (!rawChunk) return;

  let state = previewStateByPane.get(paneId);
  if (!state) {
    const getter = terminalPreviewGetters.get(paneId);
    let initialLines: string[] = [];
    if (getter) {
      try {
        initialLines = getter();
      } catch {}
    }
    state = {
      lines: ingestLines(initialLines ?? []).lines,
      pending: "",
      lastUpdated: Date.now(),
      activity: null,
      activityAt: 0,
      contentAt: 0,
      cursorRow: null,
      cursorCol: null
    };
    previewStateByPane.set(paneId, state);
  }

  const cleaned = cleanTerminalAnsi(flattenCursorMoves(rawChunk, state));
  if (!cleaned) return;

  const combined = state.pending + cleaned;
  const parts = combined.split(/\r?\n/);
  state.pending = parts.pop() ?? "";

  // Only the tail can survive the line cap, so large dumps are not classified line by line.
  for (const part of parts.slice(-MAX_PREVIEW_LINES * 2)) {
    const classified = classifyTerminalPreviewLine(lastCarriageSegment(part));
    if (classified.kind === "content") {
      pushContentLine(state.lines, classified.text);
      state.contentAt = Date.now();
    } else if (classified.kind === "activity") {
      state.activity = mergeActivity(state.activity, classified.activity);
      state.activityAt = Date.now();
    }
  }

  if (state.pending.includes("\r")) {
    state.pending = lastCarriageSegment(state.pending);
  }

  if (state.lines.length > MAX_PREVIEW_LINES) {
    state.lines = state.lines.slice(-MAX_PREVIEW_LINES);
  }
  state.lastUpdated = Date.now();

  terminalPreviewCache.set(paneId, {
    lines: state.pending ? [...state.lines, state.pending] : [...state.lines],
    lastUpdated: state.lastUpdated
  });

  notifyTerminalPreviewChangedThrottled(paneId);
}

export function updateTerminalPreviewCache(paneId: string, lines: string[]): void {
  terminalPreviewCache.set(paneId, { lines, lastUpdated: Date.now() });
  notifyTerminalPreviewChanged(paneId);
}

export function notifyTerminalPreviewChanged(paneId?: string): void {
  listeners.forEach((fn) => {
    try {
      fn(paneId);
    } catch {}
  });
}

export function notifyTerminalPreviewChangedThrottled(paneId: string): void {
  pendingThrottledPanes.add(paneId);
  if (!throttleTimer) {
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      const panes = Array.from(pendingThrottledPanes);
      pendingThrottledPanes.clear();
      panes.forEach((id) => notifyTerminalPreviewChanged(id));
    }, 120);
  }
}

export function subscribeTerminalPreview(listener: (paneId?: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTerminalPreviewSummary(paneId: string, maxLines = 5): TerminalPreviewSummary {
  const state = previewStateByPane.get(paneId);
  if (state) {
    const lines = [...state.lines];
    let activity = state.activity;
    let activityAt = state.activityAt;
    if (state.pending.trim()) {
      const classified = classifyTerminalPreviewLine(state.pending);
      if (classified.kind === "content") {
        pushContentLine(lines, classified.text);
      } else if (classified.kind === "activity") {
        activity = mergeActivity(activity, classified.activity);
        activityAt = state.lastUpdated;
      }
    }
    if (lines.length > 0 || activity) {
      return {
        lines: latestUniqueLines(lines, maxLines),
        activity,
        activityAt,
        attention: activityAt > state.contentAt ? null : detectAttention(lines),
        lastUpdated: state.lastUpdated
      };
    }
  }

  const getter = terminalPreviewGetters.get(paneId);
  if (getter) {
    try {
      const fresh = getter();
      if (fresh && fresh.length > 0) {
        const now = Date.now();
        terminalPreviewCache.set(paneId, { lines: fresh, lastUpdated: now });
        const summary = summarizeTerminalPreviewLines(fresh, maxLines, state?.lastUpdated ?? 0);
        if (summary.lines.length > 0 || summary.activity) return summary;
      }
    } catch {}
  }

  const cached = terminalPreviewCache.get(paneId);
  return summarizeTerminalPreviewLines(cached?.lines ?? [], maxLines, cached?.lastUpdated ?? 0);
}

export function getTerminalPreviewLines(paneId: string, maxLines = 5): string[] {
  return getTerminalPreviewSummary(paneId, maxLines).lines;
}

export function extractRecentTerminalLines(terminal: any, maxLines = 8): string[] {
  if (!terminal?.buffer?.active) return [];
  const buffer = terminal.buffer.active;
  const totalLength = buffer.length;

  const firstLine = Math.max(0, buffer.baseY ?? 0);
  const rows = Math.max(1, terminal.rows ?? maxLines);
  const lastLine = Math.min(totalLength, firstLine + rows);

  const viewportLines: string[] = [];
  for (let i = firstLine; i < lastLine; i++) {
    const line = buffer.getLine(i);
    if (line) {
      viewportLines.push(line.translateToString(true));
    }
  }

  while (viewportLines.length > 0 && !viewportLines[viewportLines.length - 1]?.trim()) {
    viewportLines.pop();
  }

  if (viewportLines.length > 0) {
    return viewportLines.slice(-maxLines);
  }

  const backwardLines: string[] = [];
  for (let i = totalLength - 1; i >= 0 && backwardLines.length < maxLines; i--) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const str = line.translateToString(true);
    if (str.trim() || backwardLines.length > 0) {
      backwardLines.unshift(str);
    }
  }
  return backwardLines;
}

export function extractTranscriptLines(transcript?: Array<{ content: string }>, maxLines = 8): string[] {
  if (!transcript || transcript.length === 0) return [];
  const fullText = transcript.map((chunk) => chunk.content).join("");
  const cleanText = cleanTerminalAnsi(fullText);
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-maxLines);
}
