export interface RailScalingOptions {
  viewportHeight: number;
  toolbarButtonCount: number;
  isHealthExpanded: boolean;
  healthItemCount: number;
  hasHealthRail?: boolean;
  hasLiveOrb?: boolean;
  hasTitlebar?: boolean;
  hasMinToggle?: boolean;
}

export const BASE_CONTROL_SIZE = 44; // px
export const MIN_CONTROL_SIZE = 31; // px
export const BASE_RAIL_WIDTH = 50; // px
export const MIN_RAIL_WIDTH = 36; // px
export const MIN_RAIL_SCALE = 0.70; // 30% reduction maximum
export const MAX_RAIL_SCALE = 1.00; // Normal size

/**
 * Calculates dynamic rail scale based on the vertical space required by the icons
 * versus the available height in the window/viewport.
 *
 * If the window has sufficient space for all icons at natural size (e.g. enlarged window),
 * scale is 1.0 (normal size).
 *
 * If space is constrained, scale smoothly decreases down to MIN_RAIL_SCALE (0.70)
 * proportionally to available space, ensuring icons never overlap and always fit.
 */
export function calculateRailScale(options: RailScalingOptions): number {
  const {
    viewportHeight,
    toolbarButtonCount,
    isHealthExpanded,
    healthItemCount,
    hasHealthRail = true,
    hasLiveOrb = true,
    hasTitlebar = false,
    hasMinToggle = false,
  } = options;

  if (viewportHeight <= 0) return MAX_RAIL_SCALE;

  // Insets: titlebar if present + padding/margin
  const topInset = (hasTitlebar ? 32 : 0) + 12;
  const bottomInset = 12;

  // Health rail count: if expanded, items + expander + minToggle; if collapsed, expander + minToggle
  const healthCount = hasHealthRail
    ? (isHealthExpanded ? Math.max(1, healthItemCount) : (1 + (hasMinToggle ? 1 : 0)))
    : 0;
  const toolbarCount = Math.max(0, toolbarButtonCount);

  // Clearance for Live AI orb and breathing room between rails
  // Live AI orb button is 44px (or 48px unscaled) + margins above and below (at least 12px each = 24px)
  const liveOrbSlot = hasLiveOrb ? 68 : (healthCount > 0 && toolbarCount > 0 ? 24 : 0);

  const totalItems = healthCount + toolbarCount;
  if (totalItems === 0) return MAX_RAIL_SCALE;

  // Natural unscaled item slot = 44px control + 2px gap = 46px
  const ITEM_SLOT = 46;
  const naturalItemsHeight = totalItems * ITEM_SLOT;
  const totalNeededHeight = topInset + bottomInset + liveOrbSlot + naturalItemsHeight;

  // If there is enough room for full natural size, scale is 1.0 (normal size)
  if (viewportHeight >= totalNeededHeight) {
    return MAX_RAIL_SCALE;
  }

  // Not enough room: calculate exact scale needed to fit
  const availableForItems = Math.max(0, viewportHeight - topInset - bottomInset - liveOrbSlot);
  const rawScale = availableForItems / naturalItemsHeight;

  return Math.min(MAX_RAIL_SCALE, Math.max(MIN_RAIL_SCALE, Number(rawScale.toFixed(3))));
}

/**
 * Applies calculated dynamic rail scale and derived CSS variables directly to the shell.
 * When scale is 1.0 (normal size), custom properties are removed so clean stylesheet defaults apply.
 */
export function applyRailScaleToShell(shell: HTMLElement, scale: number): void {
  if (scale >= MAX_RAIL_SCALE) {
    shell.style.removeProperty("--rail-scale");
    shell.style.removeProperty("--toolbar-control-size");
    shell.style.removeProperty("--toolbar-icon-size");
    shell.style.removeProperty("--rail-width");
    shell.style.removeProperty("--rail-indicator-w");
    shell.style.removeProperty("--rail-indicator-h");
    shell.style.removeProperty("--rail-indicator-svg");
    shell.style.removeProperty("--rail-indicator-font");
    shell.style.removeProperty("--rail-tag-font");
    const rails = shell.querySelectorAll<HTMLElement>(".health-indicator-rail, .room-toolbar-collapsed");
    rails.forEach((r) => {
      r.style.removeProperty("--toolbar-control-size");
      r.style.removeProperty("--toolbar-icon-size");
      r.style.removeProperty("--rail-width");
    });
    delete shell.dataset.railDownscaled;
  } else {
    const t = Math.max(0, Math.min(1, (scale - MIN_RAIL_SCALE) / (MAX_RAIL_SCALE - MIN_RAIL_SCALE)));
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const width = round1(36 + 14 * t);
    const controlSize = round1(31 + 13 * t);
    const iconSize = round1(14 + 6 * t);
    const indSvg = round1(11 + 4 * t);
    const indFont = round1(8.5 + 2.5 * t);
    const tagFont = round1(6.5 + 1.5 * t);
    const padRight = round1(46 + 18 * t);

    shell.dataset.railDownscaled = "true";
    shell.style.setProperty("--rail-scale", scale.toString());
    shell.style.setProperty("--toolbar-control-size", `${controlSize}px`, "important");
    shell.style.setProperty("--toolbar-icon-size", `${iconSize}px`, "important");
    shell.style.setProperty("--rail-width", `${width}px`, "important");
    // Unified sizing: upper indicators and lower toolbar controls have the exact same size
    shell.style.setProperty("--rail-indicator-w", `${controlSize}px`, "important");
    shell.style.setProperty("--rail-indicator-h", `${controlSize}px`, "important");
    shell.style.setProperty("--rail-indicator-svg", `${indSvg}px`, "important");
    shell.style.setProperty("--rail-indicator-font", `${indFont}px`, "important");
    shell.style.setProperty("--rail-tag-font", `${tagFont}px`, "important");
    shell.style.setProperty("--rail-padding-right", `${padRight}px`, "important");

    const rails = shell.querySelectorAll<HTMLElement>(".health-indicator-rail, .room-toolbar-collapsed");
    rails.forEach((r) => {
      r.style.setProperty("--toolbar-control-size", `${controlSize}px`, "important");
      r.style.setProperty("--toolbar-icon-size", `${iconSize}px`, "important");
      r.style.setProperty("--rail-width", `${width}px`, "important");
    });
  }
}

let resizeListenerAttached = false;

export function ensureRailScalingListener(): void {
  if (typeof window === "undefined" || resizeListenerAttached) return;
  window.addEventListener("resize", () => {
    syncRailScale();
  }, { passive: true });
  resizeListenerAttached = true;
}

/**
 * Reads live DOM state (shell, toolbar, health rail, window.innerHeight)
 * and applies the dynamically calculated rail scale.
 */
export function syncRailScale(targetShell?: HTMLElement | null): number {
  if (typeof document === "undefined") return MAX_RAIL_SCALE;
  const shell = targetShell ?? document.querySelector<HTMLElement>(".space-shell");
  if (!shell) return MAX_RAIL_SCALE;

  ensureRailScalingListener();

  const toolbar = shell.querySelector<HTMLElement>(".room-toolbar-collapsed");
  const healthRail = shell.querySelector<HTMLElement>(".health-indicator-rail");

  const hasHealthRail = Boolean(healthRail);
  const itemsContainer = healthRail?.querySelector<HTMLElement>(".health-rail-items");
  const isItemsVisible = itemsContainer
    ? (typeof window !== "undefined"
        ? window.getComputedStyle(itemsContainer).display !== "none"
        : false)
    : false;
  const isHealthExpanded = Boolean(
    shell.dataset.resourceRailExpanded === "true" ||
    healthRail?.classList.contains("is-expanded") ||
    healthRail?.dataset.expanded === "true" ||
    isItemsVisible
  );

  let healthItemCount = 0;
  const minToggle = healthRail?.querySelector(".minimized-pane-bar-toggle");
  const hasMinToggle = Boolean(minToggle);
  if (healthRail && isHealthExpanded) {
    const items = Array.from(healthRail.querySelectorAll(".health-rail-items > button, .health-rail-items > *")).filter((item) => {
      if (typeof window !== "undefined") {
        return window.getComputedStyle(item as HTMLElement).display !== "none";
      }
      return true;
    });
    const expander = healthRail.querySelector(".health-rail-expander");
    healthItemCount = items.length + (expander ? 1 : 0) + (hasMinToggle ? 1 : 0);
  }

  let toolbarButtonCount = 0;
  let hasLiveOrb = false;
  if (toolbar) {
    const orbButton = toolbar.querySelector<HTMLElement>(".room-live-rail-button, .live-pane-orb-button");
    const isOrbVisible = orbButton
      ? (typeof window !== "undefined" ? window.getComputedStyle(orbButton).display !== "none" : true)
      : false;
    hasLiveOrb = Boolean(orbButton && isOrbVisible);

    const allButtons = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ":scope > button, :scope > .desktop-create-rail > button, :scope > .room-toolbar-visibility-button"
      )
    ).filter((b) => {
      if (typeof window !== "undefined") {
        return window.getComputedStyle(b).display !== "none";
      }
      return true;
    });

    const nonOrbButtons = allButtons.filter(
      (b) => !b.matches(".room-live-rail-button, .live-pane-orb-button")
    );
    toolbarButtonCount = nonOrbButtons.length;
  }

  const hasTitlebar = Boolean(shell.querySelector(".desktop-window-titlebar"));

  const scale = calculateRailScale({
    viewportHeight: typeof window !== "undefined" ? window.innerHeight : 900,
    toolbarButtonCount,
    hasHealthRail,
    isHealthExpanded,
    healthItemCount,
    hasLiveOrb,
    hasTitlebar,
    hasMinToggle,
  });

  applyRailScaleToShell(shell, scale);
  return scale;
}
