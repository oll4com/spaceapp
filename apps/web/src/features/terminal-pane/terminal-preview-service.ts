export interface TerminalPreviewSnapshot {
  lines: string[];
  lastUpdated: number;
}

interface PanePreviewState {
  lines: string[];
  pending: string;
  lastUpdated: number;
}

type TerminalPreviewGetter = () => string[];

const terminalPreviewGetters = new Map<string, TerminalPreviewGetter>();
const terminalPreviewCache = new Map<string, TerminalPreviewSnapshot>();
const previewStateByPane = new Map<string, PanePreviewState>();
const listeners = new Set<(paneId?: string) => void>();

let throttleTimer: ReturnType<typeof setTimeout> | null = null;
const pendingThrottledPanes = new Set<string>();

export function cleanTerminalAnsi(text: string): string {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
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
  const filtered = lines.filter((l) => typeof l === "string" && l.length > 0);
  previewStateByPane.set(paneId, {
    lines: filtered.slice(-25),
    pending: "",
    lastUpdated: Date.now()
  });
  terminalPreviewCache.set(paneId, {
    lines: filtered.slice(-25),
    lastUpdated: Date.now()
  });
  notifyTerminalPreviewChangedThrottled(paneId);
}

export function appendTerminalPreviewChunk(paneId: string, rawChunk: string): void {
  if (!rawChunk) return;
  const cleaned = cleanTerminalAnsi(rawChunk);
  if (!cleaned) return;

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
      lines: initialLines && initialLines.length > 0 ? initialLines.slice(-20) : [],
      pending: "",
      lastUpdated: Date.now()
    };
    previewStateByPane.set(paneId, state);
  }

  const combined = state.pending + cleaned;
  const parts = combined.split(/\r?\n/);
  state.pending = parts.pop() ?? "";

  for (const part of parts) {
    if (part.includes("\r")) {
      const segments = part.split("\r");
      const last = segments[segments.length - 1];
      if (last !== undefined) {
        state.lines.push(last);
      }
    } else {
      state.lines.push(part);
    }
  }

  if (state.pending.includes("\r")) {
    const segments = state.pending.split("\r");
    state.pending = segments[segments.length - 1] ?? "";
  }

  if (state.lines.length > 30) {
    state.lines = state.lines.slice(-30);
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

export function getTerminalPreviewLines(paneId: string, maxLines = 5): string[] {
  const state = previewStateByPane.get(paneId);
  if (state && (state.lines.length > 0 || state.pending.trim())) {
    const raw = state.pending ? [...state.lines, state.pending] : [...state.lines];
    const filtered = raw.map((l) => l.replace(/\s+$/, ""));
    while (filtered.length > 0 && !filtered[filtered.length - 1]?.trim()) {
      filtered.pop();
    }
    if (filtered.length > 0) {
      return filtered.slice(-maxLines);
    }
  }

  const getter = terminalPreviewGetters.get(paneId);
  if (getter) {
    try {
      const fresh = getter();
      if (fresh && fresh.length > 0) {
        terminalPreviewCache.set(paneId, { lines: fresh, lastUpdated: Date.now() });
        return fresh.slice(-maxLines);
      }
    } catch {}
  }

  const cached = terminalPreviewCache.get(paneId)?.lines ?? [];
  return cached.slice(-maxLines);
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
