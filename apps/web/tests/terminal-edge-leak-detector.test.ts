import { afterEach, describe, expect, it, vi } from "vitest";
import {
  edgeLeakShouldEmit,
  scanTerminalEdgeLeak,
  TERMINAL_EDGE_LEAK_MIN_EMIT_MS
} from "../src/features/terminal-pane/terminal-edge-leak-detector.js";

const STORY = "τέσσερις σελίδες μέσα από το δάσος «Να πάω να δω τι είναι»";

function cellsFromText(text: string, overrides: Record<number, { chars?: string; width?: number; invisible?: boolean }> = {}) {
  const chars = Array.from(text);
  return {
    length: chars.length,
    translateToString: () => text,
    getCell: (x: number) => {
      if (x < 0 || x >= chars.length) return undefined;
      const override = overrides[x] ?? {};
      return {
        getChars: () => override.chars ?? chars[x]!,
        getWidth: () => override.width ?? 1,
        isInvisible: () => override.invisible ?? false
      };
    }
  };
}

function fixture(input: {
  lines?: Array<ReturnType<typeof cellsFromText>>;
  viewportY?: number;
  cols?: number;
  rows?: number;
  hostWidth?: number;
  screenWidth?: number;
  domRows?: string[];
} = {}) {
  const lines = input.lines ?? [cellsFromText(STORY)];
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  host.appendChild(screen);
  const rowsHost = document.createElement("div");
  rowsHost.className = "xterm-rows";
  for (const text of input.domRows ?? []) {
    const row = document.createElement("div");
    row.textContent = text;
    rowsHost.appendChild(row);
  }
  host.appendChild(rowsHost);
  document.body.appendChild(host);
  const hostWidth = input.hostWidth ?? 800;
  const screenWidth = input.screenWidth ?? hostWidth;
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: hostWidth, height: 400 } as DOMRect);
  Object.defineProperty(host, "clientWidth", { configurable: true, value: hostWidth });
  vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ width: screenWidth, height: 400 } as DOMRect);
  const terminal = {
    cols: input.cols ?? 80,
    rows: input.rows ?? lines.length,
    modes: { synchronizedOutputMode: false },
    buffer: {
      active: {
        viewportY: input.viewportY ?? 0,
        getLine: (y: number) => lines[y]
      }
    },
    refresh: vi.fn()
  };
  return { host, terminal };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("terminal edge-leak detector", () => {
  it("reports zero signal for clean wrapped Greek story text", () => {
    const { host, terminal } = fixture({
      lines: [cellsFromText(STORY), cellsFromText("Ο Νικόλας και η Μαρία έμειναν ακίνητοι.")],
      domRows: [STORY, "Ο Νικόλας και η Μαρία έμειναν ακίνητοι."]
    });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result).toMatchObject({
      scannedRows: 2,
      fragRows: 0,
      fragTruecolor: 0,
      frag256: 0,
      fragCup: 0,
      fragPartial: 0,
      fragEsc: 0,
      wideRows: 0,
      ambiguousRows: 0,
      ambiguousCells: 0,
      overflowPx: 0,
      viewportY: 0,
      staleDom: false
    });
    expect(JSON.stringify(result)).not.toContain("τέσσερις");
    expect(JSON.stringify(result)).not.toContain("Νικόλας");
  });

  it("flags buffer-resident truecolor residue without reporting text", () => {
    const { host, terminal } = fixture({
      lines: [cellsFromText(`${STORY} 38;2;255;255;255m`)],
      domRows: [`${STORY} 38;2;255;255;255m`]
    });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result?.fragRows).toBe(1);
    expect(JSON.stringify(result)).not.toContain("38;2");
  });

  it("flags buffer-resident cursor-move residue", () => {
    const { host, terminal } = fixture({ lines: [cellsFromText("12;6H")] });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result?.fragRows).toBe(1);
    expect(result?.fragCup).toBe(1);
  });

  it("classifies bare middles such as ;255; as partial", () => {
    const { host, terminal } = fixture({ lines: [cellsFromText("και ;255; μετά")] });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result?.fragRows).toBe(1);
    expect(result?.fragPartial).toBe(1);
    expect(result?.fragTruecolor).toBe(0);
  });

  it("does not flag an ASCII semicolon followed by prose", () => {
    const { host, terminal } = fixture({ lines: [cellsFromText("τι είναι; ρώτησε")] });
    expect(scanTerminalEdgeLeak(terminal, host)?.fragRows).toBe(0);
  });

  it("ignores concealed cells entirely", () => {
    const line = cellsFromText("38;2;255;255;255m", Object.fromEntries(
      Array.from({ length: 16 }, (_, x) => [x, { invisible: true }])
    ));
    const { host, terminal } = fixture({ lines: [line] });
    expect(scanTerminalEdgeLeak(terminal, host)?.fragRows).toBe(0);
  });

  it("counts wide and ambiguous-width cells as context", () => {
    const { host, terminal } = fixture({ lines: [cellsFromText("— … test")] });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result?.ambiguousCells).toBeGreaterThan(0);
    expect(result?.ambiguousRows).toBe(1);
    expect(result?.fragRows).toBe(0);
  });

  it("marks rows with double-width cells", () => {
    const { host, terminal } = fixture({
      lines: [cellsFromText("ab", { 0: { width: 2 } })]
    });
    expect(scanTerminalEdgeLeak(terminal, host)?.wideRows).toBe(1);
  });

  it("measures horizontal overflow and viewport offset", () => {
    const { host, terminal } = fixture({ hostWidth: 800, screenWidth: 812, viewportY: 120 });
    const result = scanTerminalEdgeLeak(terminal, host);
    expect(result?.overflowPx).toBe(12);
    expect(result?.viewportY).toBe(120);
  });

  it("detects stale DOM rows", () => {
    const { host, terminal } = fixture({
      lines: [cellsFromText("current frame")],
      domRows: ["older frame"]
    });
    expect(scanTerminalEdgeLeak(terminal, host)?.staleDom).toBe(true);
  });

  it("returns null for unusable terminals", () => {
    const { host } = fixture();
    expect(scanTerminalEdgeLeak(null, host)).toBeNull();
    expect(scanTerminalEdgeLeak({}, host)).toBeNull();
  });
});

describe("terminal edge-leak emission gate", () => {
  const quiet = {
    scannedRows: 24,
    fragRows: 0,
    fragTruecolor: 0,
    frag256: 0,
    fragCup: 0,
    fragPartial: 0,
    fragEsc: 0,
    wideRows: 0,
    ambiguousRows: 2,
    ambiguousCells: 5,
    overflowPx: 0,
    viewportY: 40,
    staleDom: false
  };

  it("stays silent without a signal", () => {
    expect(edgeLeakShouldEmit(quiet, null, 1_000)).toBe(false);
  });

  it("emits on buffer residue, stale DOM, or overflow", () => {
    expect(edgeLeakShouldEmit({ ...quiet, fragRows: 1 }, null, 1_000)).toBe(true);
    expect(edgeLeakShouldEmit({ ...quiet, staleDom: true }, null, 1_000)).toBe(true);
    expect(edgeLeakShouldEmit({ ...quiet, overflowPx: 3 }, null, 1_000)).toBe(true);
    expect(edgeLeakShouldEmit({ ...quiet, overflowPx: 2 }, null, 1_000)).toBe(false);
  });

  it("throttles repeat emissions", () => {
    const signal = { ...quiet, fragRows: 2 };
    expect(edgeLeakShouldEmit(signal, 1_000, 1_000 + TERMINAL_EDGE_LEAK_MIN_EMIT_MS)).toBe(true);
    expect(edgeLeakShouldEmit(signal, 1_000, 1_000 + TERMINAL_EDGE_LEAK_MIN_EMIT_MS - 1)).toBe(false);
  });
});
