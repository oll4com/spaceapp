import { paneCategoryColors, type PaneCategoryColor } from "@space/contracts";

export const ROOM_CATEGORY_FILTER_STORAGE_PREFIX = "space.activeCategoryColor.";

export function categoryFilterStorageKey(roomId: string): string {
  return `${ROOM_CATEGORY_FILTER_STORAGE_PREFIX}${roomId}`;
}

export function readStoredCategoryFilter(roomId: string): PaneCategoryColor | null {
  if (typeof window === "undefined" || !roomId) return null;
  try {
    const value = window.localStorage.getItem(categoryFilterStorageKey(roomId));
    return value !== null && (paneCategoryColors as readonly string[]).includes(value) ? value as PaneCategoryColor : null;
  } catch {
    return null;
  }
}

export function writeStoredCategoryFilter(roomId: string, color: PaneCategoryColor | null): void {
  if (typeof window === "undefined" || !roomId) return;
  try {
    const key = categoryFilterStorageKey(roomId);
    if (color === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, color);
    }
  } catch {
    // Storage can be unavailable (private mode / quota); the filter still applies for the session.
  }
}

export function roomCategoryColors(
  panes: ReadonlyArray<{ categoryColor: PaneCategoryColor | null }>
): PaneCategoryColor[] {
  return paneCategoryColors.filter((color) => panes.some((pane) => pane.categoryColor === color));
}

export function nextCategoryColor(
  current: PaneCategoryColor | null,
  colors: ReadonlyArray<PaneCategoryColor>,
  deltaY: number
): PaneCategoryColor | null {
  if (colors.length === 0) return null;
  if (deltaY === 0) return current;
  const direction = deltaY > 0 ? 1 : -1;
  const sequence: Array<PaneCategoryColor | null> = [...colors, null];
  const currentIndex = sequence.indexOf(current);
  const index = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (index + direction + sequence.length) % sequence.length;
  return sequence[nextIndex] ?? null;
}
