export interface TerminalGeometryTerminal {
  cols: number;
  rows: number;
  clearTextureAtlas?: () => void;
  refresh: (start: number, end: number) => void;
  resize?: (cols: number, rows: number) => void;
}

export interface TerminalGeometryFitAddon {
  fit: () => void;
  proposeDimensions?: () => { cols: number; rows: number } | undefined;
}

export interface TerminalResizeIdentity {
  socketGeneration: number;
  sessionId: string;
  leaseId: string | null;
}

export interface TerminalResizeFrame {
  cols: number;
  rows: number;
  leaseId: string | null;
}

export type TerminalRepaintPhase = "initial" | "reveal" | "refit" | "delayed" | "force" | "background";

export interface TerminalRepaintInfo {
  phase: TerminalRepaintPhase;
  cols: number;
  rows: number;
  width: number;
  height: number;
  suspect: boolean;
  canvasWidth: number;
  canvasHeight: number;
  canvasBlank: boolean;
  darkPixelRatio?: number;
  rowCount: number;
  populatedRowCount: number;
  blankRowRatio?: number;
}

export interface TerminalGeometryCoordinatorOptions {
  ownerDocument: Document;
  host: HTMLElement;
  getTerminal: () => TerminalGeometryTerminal | null;
  getFitAddon: () => TerminalGeometryFitAddon | null;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  measureCharacterSize: (terminal: TerminalGeometryTerminal | null) => void;
  invalidateWidthMeasurements: (terminal: TerminalGeometryTerminal) => void;
  getResizeIdentity: () => TerminalResizeIdentity | null;
  sendResize: (frame: TerminalResizeFrame) => void;
  isScrolledToBottom?: () => boolean;
  scrollToBottom?: () => void;
  onReady?: (frame: TerminalResizeFrame & { width: number; height: number; repaired: boolean }) => void;
  onRepaint?: (info: TerminalRepaintInfo) => void;
}

export interface TerminalRefitOptions {
  delayedPass?: boolean;
  repair?: boolean;
}

const LEGACY_COLLAPSE_MAX_COLS = 8;
const GEOMETRY_COLLAPSE_RATIO = 0.7;
const STABLE_LAYOUT_TOLERANCE_PX = 1;
const REFIT_STABILIZE_DELAY_MS = 48;

interface LayoutSample {
  width: number;
  height: number;
}

interface StableGeometry {
  sample: LayoutSample;
  cols: number;
  rows: number;
}

export interface InitialTerminalGeometry {
  cols: number;
  rows: number;
}

export interface InitialTerminalFitOptions {
  ownerDocument: Document;
  host: HTMLElement;
  terminal: TerminalGeometryTerminal;
  fitAddon: TerminalGeometryFitAddon;
  maxFrameSamples?: number;
  onRepaint?: (info: TerminalRepaintInfo) => void;
}

function positiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hostLayoutSample(host: HTMLElement): LayoutSample | null {
  const bounds = host.getBoundingClientRect();
  const width = positiveDimension(host.clientWidth || bounds.width);
  const height = positiveDimension(host.clientHeight || bounds.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function screenRectSample(host: HTMLElement): LayoutSample | null {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;
  const bounds = screen.getBoundingClientRect();
  const width = positiveDimension(bounds.width);
  const height = positiveDimension(bounds.height);
  return width > 0 && height > 0 ? { width, height } : null;
}

function suspectBlankPaint(host: HTMLElement, sample: LayoutSample): boolean {
  const screen = screenRectSample(host);
  return !screen || screen.width < sample.width * GEOMETRY_COLLAPSE_RATIO;
}

function canvasBackingSample(host: HTMLElement): { width: number; height: number; present: boolean } {
  const canvas = host.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
  if (!canvas) return { width: 0, height: 0, present: false };
  return {
    width: positiveDimension(canvas.width),
    height: positiveDimension(canvas.height),
    present: true
  };
}

function domRowSample(host: HTMLElement): { rowCount: number; populatedRowCount: number; blankRowRatio: number | undefined } {
  const rows = host.querySelector<HTMLElement>(".xterm-rows");
  if (!rows || rows.children.length === 0) {
    return { rowCount: 0, populatedRowCount: 0, blankRowRatio: undefined };
  }
  const rowCount = rows.children.length;
  let populatedRowCount = 0;
  for (const child of Array.from(rows.children)) {
    const el = child as HTMLElement;
    if (el.children.length > 0 || (el.textContent ?? "").length > 0) populatedRowCount += 1;
  }
  return {
    rowCount,
    populatedRowCount,
    blankRowRatio: rowCount > 0 ? (rowCount - populatedRowCount) / rowCount : undefined
  };
}

function sampleCanvasDarkness(host: HTMLElement): number | undefined {
  const canvas = host.querySelector<HTMLCanvasElement>(".xterm-screen canvas");
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return undefined;
  const ownerDocument = host.ownerDocument;
  try {
    const target = ownerDocument.createElement("canvas");
    target.width = 64;
    target.height = 64;
    const ctx = target.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(canvas, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let dark = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += 1;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (r < 40 && g < 40 && b < 40) dark += 1;
    }
    return total > 0 ? dark / total : undefined;
  } catch {
    return undefined;
  }
}

function stableSamples(left: LayoutSample, right: LayoutSample): boolean {
  return (
    Math.abs(left.width - right.width) <= STABLE_LAYOUT_TOLERANCE_PX &&
    Math.abs(left.height - right.height) <= STABLE_LAYOUT_TOLERANCE_PX
  );
}

function nextAnimationFrame(ownerWindow: Window): Promise<void> {
  return new Promise((resolve) => ownerWindow.requestAnimationFrame(() => resolve()));
}

export async function fitTerminalForInitialAttach(
  options: InitialTerminalFitOptions
): Promise<InitialTerminalGeometry | null> {
  const ownerWindow = options.ownerDocument.defaultView ?? window;
  const maxFrameSamples = Math.max(2, Math.min(12, options.maxFrameSamples ?? 8));
  let previousSample: LayoutSample | null = null;
  for (let sampleIndex = 0; sampleIndex < maxFrameSamples; sampleIndex += 1) {
    await nextAnimationFrame(ownerWindow);
    const sample = hostLayoutSample(options.host);
    if (!sample) {
      previousSample = null;
      continue;
    }
    if (!previousSample || !stableSamples(previousSample, sample)) {
      previousSample = sample;
      continue;
    }
    options.fitAddon.fit();
    const { cols, rows } = options.terminal;
    if (
      !Number.isInteger(cols) ||
      cols < 2 ||
      cols > 400 ||
      !Number.isInteger(rows) ||
      rows < 2 ||
      rows > 200
    ) {
      return null;
    }
    options.terminal.refresh(0, rows - 1);
    const paintScreen = screenRectSample(options.host);
    const backing = canvasBackingSample(options.host);
    const rowSample = domRowSample(options.host);
    options.onRepaint?.({
      phase: "initial",
      cols,
      rows,
      width: paintScreen?.width ?? sample.width,
      height: paintScreen?.height ?? sample.height,
      suspect: !paintScreen || paintScreen.width < sample.width * GEOMETRY_COLLAPSE_RATIO,
      canvasWidth: backing.width,
      canvasHeight: backing.height,
      canvasBlank: backing.present && (backing.width <= 0 || backing.height <= 0),
      darkPixelRatio: sampleCanvasDarkness(options.host),
      rowCount: rowSample.rowCount,
      populatedRowCount: rowSample.populatedRowCount,
      blankRowRatio: rowSample.blankRowRatio
    });
    await nextAnimationFrame(ownerWindow);
    return { cols, rows };
  }
  return null;
}

function geometryIsBroken(
  terminal: TerminalGeometryTerminal,
  fitAddon: TerminalGeometryFitAddon,
  host: HTMLElement
): boolean {
  if (terminal.cols <= LEGACY_COLLAPSE_MAX_COLS) return true;
  const proposed = fitAddon.proposeDimensions?.();
  if (
    proposed &&
    Number.isFinite(proposed.cols) &&
    proposed.cols > 0 &&
    terminal.cols < proposed.cols * GEOMETRY_COLLAPSE_RATIO
  ) {
    return true;
  }
  const hostWidth = hostLayoutSample(host)?.width ?? 0;
  const screenWidth = positiveDimension(
    host.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect().width ?? 0
  );
  return hostWidth > 0 && screenWidth > 0 && screenWidth < hostWidth * GEOMETRY_COLLAPSE_RATIO;
}

export function createTerminalGeometryCoordinator(options: TerminalGeometryCoordinatorOptions) {
  const ownerWindow = options.ownerDocument.defaultView ?? window;
  let active = false;
  let disposed = false;
  let fontTicket = 0;
  let frame: number | null = null;
  let pendingRefit = false;
  let repairRequested = false;
  let restoreSample: LayoutSample | null = null;
  let stabilizingRestore = false;
  let lastStableGeometry: StableGeometry | null = null;
  let timer: number | null = null;
  let lastResizeKey: string | null = null;
  let viewportMeasurementKey = JSON.stringify([
    ownerWindow.devicePixelRatio || 1,
    ownerWindow.visualViewport?.scale ?? 1
  ]);

  const isEligible = () =>
    !disposed &&
    options.isVisible() &&
    !options.isMinimized() &&
    options.ownerDocument.visibilityState !== "hidden" &&
    options.host.isConnected;

  const cancelScheduledWork = () => {
    if (frame !== null) {
      ownerWindow.cancelAnimationFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      ownerWindow.clearTimeout(timer);
      timer = null;
    }
    fontTicket += 1;
  };

  const updateGeometryDataset = (
    terminal: TerminalGeometryTerminal,
    sample: LayoutSample,
    repaired: boolean
  ) => {
    const screenWidth = positiveDimension(
      options.host.querySelector<HTMLElement>(".xterm-screen")?.getBoundingClientRect().width ?? 0
    );
    options.host.dataset.terminalCols = String(terminal.cols);
    options.host.dataset.terminalRows = String(terminal.rows);
    options.host.dataset.terminalHostWidth = String(Math.round(sample.width * 10) / 10);
    options.host.dataset.terminalHostHeight = String(Math.round(sample.height * 10) / 10);
    options.host.dataset.terminalScreenWidth = String(Math.round(screenWidth * 10) / 10);
    options.host.dataset.terminalGeometryRepaired = String(repaired);
  };

  const sendResizeBackground = (cols: number, rows: number) => {
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return;
    const identity = options.getResizeIdentity();
    if (
      !identity ||
      !Number.isInteger(identity.socketGeneration) ||
      identity.socketGeneration <= 0 ||
      !identity.sessionId
    ) {
      return;
    }
    const key = JSON.stringify([
      identity.socketGeneration,
      identity.sessionId,
      identity.leaseId,
      cols,
      rows
    ]);
    if (key === lastResizeKey) return;
    lastResizeKey = key;
    options.sendResize({ cols, rows, leaseId: identity.leaseId });
  };

  const sendResizeOnce = (cols: number, rows: number) => {
    if (!isEligible() || !Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return;
    const identity = options.getResizeIdentity();
    if (
      !identity ||
      !Number.isInteger(identity.socketGeneration) ||
      identity.socketGeneration <= 0 ||
      !identity.sessionId
    ) {
      return;
    }
    const key = JSON.stringify([
      identity.socketGeneration,
      identity.sessionId,
      identity.leaseId,
      cols,
      rows
    ]);
    if (key === lastResizeKey) return;
    lastResizeKey = key;
    options.sendResize({ cols, rows, leaseId: identity.leaseId });
  };

  const applyGeometry = (sample: LayoutSample) => {
    if (!isEligible()) {
      pendingRefit = true;
      return;
    }
    const terminal = options.getTerminal();
    const fitAddon = options.getFitAddon();
    if (!terminal || !fitAddon) {
      pendingRefit = true;
      return;
    }
    const broken = repairRequested || geometryIsBroken(terminal, fitAddon, options.host);
    repairRequested = false;
    if (broken) {
      options.invalidateWidthMeasurements(terminal);
      options.measureCharacterSize(terminal);
      terminal.clearTextureAtlas?.();
    }
    const keepAtBottom = options.isScrolledToBottom?.() ?? false;
    fitAddon.fit();
    if (!Number.isInteger(terminal.cols) || terminal.cols <= 0 || !Number.isInteger(terminal.rows) || terminal.rows <= 0) {
      pendingRefit = true;
      return;
    }
    terminal.refresh(0, terminal.rows - 1);
    const paintScreen = screenRectSample(options.host);
    const backing = canvasBackingSample(options.host);
    const rowSample = domRowSample(options.host);
    options.onRepaint?.({
      phase: "refit",
      cols: terminal.cols,
      rows: terminal.rows,
      width: paintScreen?.width ?? sample.width,
      height: paintScreen?.height ?? sample.height,
      suspect: broken || suspectBlankPaint(options.host, sample),
      canvasWidth: backing.width,
      canvasHeight: backing.height,
      canvasBlank: backing.present && (backing.width <= 0 || backing.height <= 0),
      darkPixelRatio: sampleCanvasDarkness(options.host),
      rowCount: rowSample.rowCount,
      populatedRowCount: rowSample.populatedRowCount,
      blankRowRatio: rowSample.blankRowRatio
    });
    if (keepAtBottom) options.scrollToBottom?.();
    updateGeometryDataset(terminal, sample, broken);
    sendResizeOnce(terminal.cols, terminal.rows);
    lastStableGeometry = {
      sample,
      cols: terminal.cols,
      rows: terminal.rows
    };
    pendingRefit = false;
    options.onReady?.({
      cols: terminal.cols,
      rows: terminal.rows,
      leaseId: options.getResizeIdentity()?.leaseId ?? null,
      width: sample.width,
      height: sample.height,
      repaired: broken
    });
  };

  const reuseStableGeometry = (sample: LayoutSample): boolean => {
    const terminal = options.getTerminal();
    const fitAddon = options.getFitAddon();
    const cached = lastStableGeometry;
    if (
      repairRequested ||
      !terminal ||
      !fitAddon ||
      !cached ||
      terminal.cols !== cached.cols ||
      terminal.rows !== cached.rows ||
      !stableSamples(cached.sample, sample) ||
      geometryIsBroken(terminal, fitAddon, options.host)
    ) {
      return false;
    }
    updateGeometryDataset(terminal, sample, false);
    sendResizeOnce(terminal.cols, terminal.rows);
    terminal.refresh(0, terminal.rows - 1);
    const paintScreen = screenRectSample(options.host);
    const backing = canvasBackingSample(options.host);
    const rowSample = domRowSample(options.host);
    options.onRepaint?.({
      phase: "reveal",
      cols: terminal.cols,
      rows: terminal.rows,
      width: paintScreen?.width ?? sample.width,
      height: paintScreen?.height ?? sample.height,
      suspect: suspectBlankPaint(options.host, sample),
      canvasWidth: backing.width,
      canvasHeight: backing.height,
      canvasBlank: backing.present && (backing.width <= 0 || backing.height <= 0),
      darkPixelRatio: sampleCanvasDarkness(options.host),
      rowCount: rowSample.rowCount,
      populatedRowCount: rowSample.populatedRowCount,
      blankRowRatio: rowSample.blankRowRatio
    });
    pendingRefit = false;
    options.onReady?.({
      cols: terminal.cols,
      rows: terminal.rows,
      leaseId: options.getResizeIdentity()?.leaseId ?? null,
      width: sample.width,
      height: sample.height,
      repaired: false
    });
    return true;
  };

  const runFrame = () => {
    frame = null;
    if (!isEligible()) {
      pendingRefit = true;
      return;
    }
    const sample = hostLayoutSample(options.host);
    if (!sample) {
      pendingRefit = true;
      restoreSample = null;
      return;
    }
    if (stabilizingRestore) {
      if (!restoreSample || !stableSamples(restoreSample, sample)) {
        restoreSample = sample;
        frame = ownerWindow.requestAnimationFrame(runFrame);
        return;
      }
      stabilizingRestore = false;
      restoreSample = null;
      if (reuseStableGeometry(sample)) return;
    }
    applyGeometry(sample);
  };

  const scheduleFrame = () => {
    if (!isEligible()) {
      cancelScheduledWork();
      pendingRefit = true;
      return;
    }
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    frame = ownerWindow.requestAnimationFrame(runFrame);
  };

  const requestRefit = (request: TerminalRefitOptions = {}) => {
    repairRequested ||= request.repair === true;
    pendingRefit = true;
    scheduleFrame();
    if (!isEligible()) return;

    if (timer !== null) ownerWindow.clearTimeout(timer);
    if (request.delayedPass !== false) {
      timer = ownerWindow.setTimeout(() => {
        timer = null;
        scheduleFrame();
      }, REFIT_STABILIZE_DELAY_MS);
    }
    const ready = options.ownerDocument.fonts?.ready;
    if (ready) {
      const ticket = fontTicket + 1;
      fontTicket = ticket;
      void ready.then(() => {
        if (ticket !== fontTicket || !isEligible()) return;
        scheduleFrame();
      });
    }
  };

  const repaintNow = (phase: TerminalRepaintPhase): boolean => {
    if (!isEligible()) return false;
    if (lastStableGeometry === null && phase !== "force") return false;
    const terminal = options.getTerminal();
    if (!terminal || !Number.isInteger(terminal.rows) || terminal.rows <= 0) return false;
    terminal.refresh(0, terminal.rows - 1);
    const sample = hostLayoutSample(options.host);
    if (sample) {
      const paintScreen = screenRectSample(options.host);
      const backing = canvasBackingSample(options.host);
      const rowSample = domRowSample(options.host);
      options.onRepaint?.({
        phase,
        cols: terminal.cols,
        rows: terminal.rows,
        width: paintScreen?.width ?? sample.width,
        height: paintScreen?.height ?? sample.height,
        suspect: suspectBlankPaint(options.host, sample),
        canvasWidth: backing.width,
        canvasHeight: backing.height,
        canvasBlank: backing.present && (backing.width <= 0 || backing.height <= 0),
        darkPixelRatio: sampleCanvasDarkness(options.host),
        rowCount: rowSample.rowCount,
        populatedRowCount: rowSample.populatedRowCount,
        blankRowRatio: rowSample.blankRowRatio
      });
    }
    return true;
  };

  const syncVisibility = () => {
    const eligible = isEligible();
    if (!eligible) {
      active = false;
      pendingRefit = true;
      stabilizingRestore = true;
      restoreSample = null;
      cancelScheduledWork();
      return;
    }
    if (!active) {
      active = true;
      stabilizingRestore = true;
      restoreSample = null;
      requestRefit({ delayedPass: false });
      if (timer !== null) ownerWindow.clearTimeout(timer);
      timer = ownerWindow.setTimeout(() => {
        timer = null;
        repaintNow("delayed");
      }, REFIT_STABILIZE_DELAY_MS);
      return;
    }
    if (pendingRefit) requestRefit({ delayedPass: false });
  };

  const handleViewportChange = () => {
    const nextViewportMeasurementKey = JSON.stringify([
      ownerWindow.devicePixelRatio || 1,
      ownerWindow.visualViewport?.scale ?? 1
    ]);
    const measurementChanged = nextViewportMeasurementKey !== viewportMeasurementKey;
    viewportMeasurementKey = nextViewportMeasurementKey;
    if (!isEligible()) {
      repairRequested ||= measurementChanged;
      syncVisibility();
      return;
    }
    requestRefit({ repair: measurementChanged });
  };
  const handleFontChange = () => requestRefit({ repair: true });
  ownerWindow.addEventListener("resize", handleViewportChange);
  ownerWindow.visualViewport?.addEventListener("resize", handleViewportChange);
  options.ownerDocument.fonts?.addEventListener("loadingdone", handleFontChange);
  options.ownerDocument.fonts?.addEventListener("loadingerror", handleFontChange);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelScheduledWork();
      ownerWindow.removeEventListener("resize", handleViewportChange);
      ownerWindow.visualViewport?.removeEventListener("resize", handleViewportChange);
      options.ownerDocument.fonts?.removeEventListener("loadingdone", handleFontChange);
      options.ownerDocument.fonts?.removeEventListener("loadingerror", handleFontChange);
    },
    handleTerminalResize(cols: number, rows: number) {
      sendResizeOnce(cols, rows);
    },
    repairIfBroken(): boolean {
      const terminal = options.getTerminal();
      const fitAddon = options.getFitAddon();
      if (!isEligible() || !terminal || !fitAddon || !geometryIsBroken(terminal, fitAddon, options.host)) {
        return false;
      }
      requestRefit({ delayedPass: true, repair: true });
      return true;
    },
    requestRefit,
    syncVisibility,
    forceRepaint: () => repaintNow("force"),
    backgroundResize(cols: number, rows: number): boolean {
      if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return false;
      const terminal = options.getTerminal();
      if (!terminal) return false;
      terminal.resize?.(cols, rows);
      terminal.refresh(0, rows - 1);
      sendResizeBackground(cols, rows);
      const rowSample = domRowSample(options.host);
      options.onRepaint?.({
        phase: "background",
        cols,
        rows,
        width: 0,
        height: 0,
        suspect: false,
        canvasWidth: 0,
        canvasHeight: 0,
        canvasBlank: false,
        rowCount: rowSample.rowCount,
        populatedRowCount: rowSample.populatedRowCount,
        blankRowRatio: rowSample.blankRowRatio
      });
      return true;
    }
  };
}
