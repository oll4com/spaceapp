/**
 * Utility functions to prevent floating windows, menus, dialogs, and popovers
 * from automatically closing when the user clicks the Snip Tool or while Snip Tool is active.
 *
 * This ensures the user can capture open menus/plans (e.g. Open Plans in CLI tools,
 * shortcuts, launchers, settings, etc.) without them being dismissed upon clicking Snip Tool.
 */

export function isSnipToolTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (!(target instanceof Element)) {
    if (target instanceof Node && target.parentElement) {
      target = target.parentElement;
    } else {
      return false;
    }
  }
  const el = target as Element;
  return Boolean(
    el.closest(
      [
        '[data-rail-id="snip-tool"]',
        '[data-action-id="snip-tool"]',
        '[data-snip-tool]',
        '.snip-tool-overlay',
        '.snip-tool-hud',
        '.snip-tool-float-icon',
        '.snip-selection-box',
        '.snip-crop-box',
        '.snip-image-stage',
        '.snip-preview-scroll',
        '.snip-edit-tools',
        '.snip-actions',
        'button[aria-label="Snip Tool"]',
        'button[title*="Snip Tool"]'
      ].join(", ")
    )
  );
}

export function isSnipToolActive(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.body?.hasAttribute("data-snip-tool-active") ||
    document.querySelector(".snip-tool-overlay") ||
    document.querySelector(".snip-tool-float-icon")
  );
}

export function shouldPreserveForSnipTool(
  event?: { target?: EventTarget | null; relatedTarget?: EventTarget | null } | null
): boolean {
  if (isSnipToolActive()) return true;
  if (!event) return false;
  if (event.target && isSnipToolTarget(event.target)) return true;
  if (event.relatedTarget && isSnipToolTarget(event.relatedTarget)) return true;
  return false;
}
