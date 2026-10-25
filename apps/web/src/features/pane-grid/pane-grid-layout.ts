import type { Pane, Room } from "@space/contracts";

// Pane-grid geometry for the room workspace. Moved verbatim from App.tsx
// (operator approval 2026-10-11); behavior, constants and timing are unchanged.

export type ShellMode = "desktop" | "tablet" | "mobile";
export type PaneDensity = "regular" | "dense" | "tight";
export type PaneGridPlacement = {
  columnStart: number;
  rowIndex: number;
  effectiveSpan: number;
  canGrow: boolean;
  canReset: boolean;
};
export type PaneGridPlacementSeed = Omit<PaneGridPlacement, "canGrow" | "canReset">;
export type PaneColumnAnchor = number | { columnStart: number; rowIndex?: number };
export type PaneColumnAnchorMap = Map<string, PaneColumnAnchor>;

export const MAX_PANE_COLUMN_SPAN = 4;

export const paneGridDensityMetrics: Record<PaneDensity, { minWidthRem: number; gapRem: number }> = {
  regular: { minWidthRem: 19, gapRem: 0.375 },
  dense: { minWidthRem: 16, gapRem: 0.3125 },
  tight: { minWidthRem: 14, gapRem: 0.25 }
};

export function remToPx(rem: number) {
  if (typeof window === "undefined" || typeof document === "undefined") return rem * 16;
  const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize || "16");
  return rem * (Number.isFinite(rootFontSize) ? rootFontSize : 16);
}

let titleMeasureCanvas: HTMLCanvasElement | null = null;

export function measureSingleLineTitleWidth(element: HTMLElement | null, fallbackRem = 8) {
  if (!element || typeof window === "undefined" || typeof document === "undefined") return remToPx(fallbackRem);
  const text = element.textContent?.trim();
  if (!text) return remToPx(1);
  if (typeof navigator !== "undefined" && /\bjsdom\b/i.test(navigator.userAgent)) {
    return Math.max(element.scrollWidth, remToPx(fallbackRem));
  }

  const computed = window.getComputedStyle(element);
  const font =
    computed.font && computed.font !== ""
      ? computed.font
      : `${computed.fontStyle} ${computed.fontVariant} ${computed.fontWeight} ${computed.fontSize} / ${computed.lineHeight} ${computed.fontFamily}`;
  titleMeasureCanvas ??= document.createElement("canvas");
  const context = titleMeasureCanvas.getContext("2d");
  if (!context) return Math.max(element.scrollWidth, remToPx(fallbackRem));

  context.font = font;
  const letterSpacing = Number.parseFloat(computed.letterSpacing || "");
  const spacingWidth = Number.isFinite(letterSpacing) ? Math.max(text.length - 1, 0) * letterSpacing : 0;
  return Math.ceil(context.measureText(text).width + spacingWidth);
}

export function roomToolbarNeedsSecondRow(input: {
  availableWidth: number;
  titleWidth: number;
  lbWidth: number;
  actionsWidth: number;
  columnGap: number;
}) {
  if (input.availableWidth <= 0) return false;
  const requiredWidth = input.titleWidth + input.lbWidth + input.actionsWidth + input.columnGap * 2;
  return requiredWidth > input.availableWidth + 1;
}

export function paneHeaderNeedsSecondRow(input: {
  availableWidth: number;
  paddingLeft: number;
  paddingRight: number;
  badgeWidth: number;
  titleWidth: number;
  actionsWidth: number;
  fixedWidth: number;
  columnGap: number;
}) {
  if (input.availableWidth <= 0) return false;
  const requiredWidth =
    input.paddingLeft +
    input.paddingRight +
    input.badgeWidth +
    input.titleWidth +
    input.actionsWidth +
    input.fixedWidth +
    input.columnGap * 3;
  return requiredWidth > input.availableWidth + 1;
}

export function clampPaneColumnSpan(columnSpan: number | null | undefined, columnCount: number) {
  return Math.max(1, Math.min(MAX_PANE_COLUMN_SPAN, columnSpan ?? 1, columnCount));
}

export function sortPanesForGrid(panes: Pane[]) {
  return [...panes].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

export function detectPaneGridColumnCount(input: { shellMode: ShellMode; paneDensity: PaneDensity; containerWidth: number; rootRemSize: number }) {
  if (input.shellMode === "mobile") return 1;
  if (input.shellMode === "tablet") return 2;
  const metrics = paneGridDensityMetrics[input.paneDensity];
  const minWidthPx = metrics.minWidthRem * input.rootRemSize;
  const gapPx = metrics.gapRem * input.rootRemSize;
  return Math.max(1, Math.floor((Math.max(input.containerWidth, minWidthPx) + gapPx) / (minWidthPx + gapPx)));
}

export function resolvePaneGridColumnCount(input: {
  shellMode: ShellMode;
  paneDensity: PaneDensity;
  containerWidth: number;
  rootRemSize: number;
  paneLayoutColumns: Room["paneLayoutColumns"];
  visiblePaneCount: number;
  forceTabletTwoColumns?: boolean;
}) {
  if (input.containerWidth > 0 && input.containerWidth <= 768) return 1;
  if (input.paneLayoutColumns === 0) return 1;
  const requestedColumns = input.paneLayoutColumns ?? Math.min(4, detectPaneGridColumnCount(input));
  const responsiveColumns =
    input.shellMode === "mobile"
      ? 1
      : input.shellMode === "tablet"
        ? input.forceTabletTwoColumns && input.paneLayoutColumns === null && input.visiblePaneCount > 1
          ? 2
          : Math.min(requestedColumns, 2)
        : requestedColumns;
  return Math.max(1, Math.min(responsiveColumns, Math.max(input.visiblePaneCount, 1)));
}

export function computePaneGridPlacements(panes: Pane[], columnCount: number, anchoredColumnStarts: PaneColumnAnchorMap = new Map()) {
  const placements = new Map<string, PaneGridPlacementSeed>();
  const occupancy: boolean[][] = [];
  let cursorRow = 0;
  let cursorColumn = 1;

  const ensureRow = (rowIndex: number) => {
    while (occupancy.length <= rowIndex) {
      occupancy.push(Array.from({ length: columnCount }, () => false));
    }
  };

  const rangeIsAvailable = (row: boolean[], columnStart: number, span: number) => {
    if (columnStart + span - 1 > columnCount) return false;
    for (let offset = 0; offset < span; offset += 1) {
      if (row[columnStart - 1 + offset]) return false;
    }
    return true;
  };

  const placeAutoFlowPane = (span: number) => {
    let rowIndex = 0;
    let columnStart = 1;

    while (true) {
      if (columnStart > columnCount) {
        rowIndex += 1;
        columnStart = 1;
        continue;
      }
      ensureRow(rowIndex);
      if (columnStart + span - 1 > columnCount) {
        rowIndex += 1;
        columnStart = 1;
        continue;
      }
      if (!rangeIsAvailable(occupancy[rowIndex] ?? [], columnStart, span)) {
        columnStart += 1;
        continue;
      }
      return { rowIndex, columnStart };
    }
  };

  const placeAnchoredPane = (anchorColumnStart: number, span: number, startRow: number) => {
    const columnStart = Math.max(1, Math.min(anchorColumnStart, columnCount - span + 1));
    let rowIndex = startRow;

    while (true) {
      ensureRow(rowIndex);
      if (rangeIsAvailable(occupancy[rowIndex] ?? [], columnStart, span)) {
        return { rowIndex, columnStart };
      }
      rowIndex += 1;
    }
  };

  for (const pane of sortPanesForGrid(panes)) {
    const effectiveSpan = clampPaneColumnSpan(pane.columnSpan, columnCount);
    const anchorData = anchoredColumnStarts.get(pane.id);
    const anchoredColumnStart = typeof anchorData === "number" ? anchorData : anchorData?.columnStart;
    const anchoredRowIndex = typeof anchorData === "object" ? anchorData?.rowIndex : undefined;
    const placement =
      anchoredColumnStart === undefined
        ? placeAutoFlowPane(effectiveSpan)
        : placeAnchoredPane(anchoredColumnStart, effectiveSpan, anchoredRowIndex ?? cursorRow);

    for (let offset = 0; offset < effectiveSpan; offset += 1) {
      occupancy[placement.rowIndex]![placement.columnStart - 1 + offset] = true;
    }
    placements.set(pane.id, {
      columnStart: placement.columnStart,
      rowIndex: placement.rowIndex,
      effectiveSpan
    });
    cursorRow = placement.rowIndex;
    cursorColumn = placement.columnStart + effectiveSpan;
  }

  return placements;
}

export function canPaneGrowAtCurrentPlacement(input: {
  pane: Pane;
  columnCount: number;
  basePlacements: Map<string, PaneGridPlacementSeed>;
}) {
  const currentPlacement = input.basePlacements.get(input.pane.id);
  if (!currentPlacement || input.pane.isMaximized) return false;

  const nextColumnSpan = clampPaneColumnSpan((input.pane.columnSpan ?? 1) + 1, input.columnCount);
  return nextColumnSpan > currentPlacement.effectiveSpan;
}

export function resolvePaneGridPlacements(panes: Pane[], columnCount: number, anchoredColumnStarts: PaneColumnAnchorMap = new Map()) {
  const placements = new Map<string, PaneGridPlacement>();
  const basePlacements = computePaneGridPlacements(panes, columnCount, anchoredColumnStarts);

  for (const pane of sortPanesForGrid(panes)) {
    const basePlacement = basePlacements.get(pane.id);
    if (!basePlacement) continue;
    placements.set(pane.id, {
      ...basePlacement,
      canGrow: canPaneGrowAtCurrentPlacement({
        pane,
        columnCount,
        basePlacements
      }),
      canReset: !pane.isMaximized && (pane.columnSpan ?? 1) > 1
    });
  }

  return placements;
}

export function calculatePaneGridBaseRows(input: {
  placements: Map<string, { rowIndex: number; effectiveSpan?: number }>;
  visiblePaneCount: number;
  columnCount: number;
  targetEmptySlots?: number;
}): {
  naturalRows: number;
  naturalEmptySlots: number;
  actualBaseRows: number;
  targetEmptySlots: number;
  minCount: number;
  maxCount: number;
} {
  const { placements, visiblePaneCount, columnCount, targetEmptySlots: storedTarget } = input;
  const maxPaneRowIndex =
    placements.size > 0
      ? Math.max(0, ...Array.from(placements.values(), (placement) => placement.rowIndex))
      : (visiblePaneCount > 0 ? Math.ceil(visiblePaneCount / Math.max(columnCount, 1)) - 1 : 0);
  const naturalRows = Math.max(1, maxPaneRowIndex + 1);
  const occupiedCells =
    placements.size > 0
      ? Array.from(placements.values()).reduce((sum, p) => sum + (p.effectiveSpan ?? 1), 0)
      : visiblePaneCount;
  const naturalCapacity = naturalRows * columnCount;
  const naturalEmptySlots = Math.max(0, naturalCapacity - occupiedCells);
  const MAX_ROOM_EMPTY_SLOTS = 6;
  const minCount = 0;
  const maxCount = Math.min(MAX_ROOM_EMPTY_SLOTS, Math.max(minCount, 16 - visiblePaneCount));
  const targetEmptySlots = typeof storedTarget === "number"
    ? Math.max(minCount, Math.min(maxCount, storedTarget))
    : 0;
  const additionalSlotsNeeded = Math.max(0, targetEmptySlots - naturalEmptySlots);
  const neededCells = Math.min(16, naturalCapacity + additionalSlotsNeeded);
  const rowsForSlots = Math.ceil(neededCells / Math.max(columnCount, 1));
  const maxPossibleRows = Math.max(1, Math.ceil(16 / Math.max(columnCount, 1)));
  const actualBaseRows = Math.min(
    maxPossibleRows,
    Math.max(naturalRows, rowsForSlots, 1)
  );
  return { naturalRows, naturalEmptySlots, actualBaseRows, targetEmptySlots, minCount, maxCount };
}
