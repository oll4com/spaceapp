/** The nearest ancestor that scrolls (overflow-y auto or scroll), or null. */
export const scrollerOf = (target: Element): HTMLElement | null => {
  for (let element = target.parentElement; element; element = element.parentElement) if (/auto|scroll/.test(getComputedStyle(element).overflowY)) return element;
  return null;
};

/** Brings target into view by scrolling only `list`, never an element around it. scrollIntoView also scrolled the dock and the
 * shell, which slid the whole app up and left a gap at the bottom until it was reopened (operator 16/11, nous_msg:556e6cfd). */
export function scrollWithin(target: Element, block: "start" | "center" | "nearest", behavior: ScrollBehavior = "auto", list = scrollerOf(target)): void {
  if (!list) return;
  const box = target.getBoundingClientRect();
  const top = list.getBoundingClientRect().top + list.clientTop, bottom = top + list.clientHeight;
  const offset = block === "start" ? box.top - top : block === "center" ? (box.top + box.bottom - top - bottom) / 2
    : box.top < top ? box.top - top : box.bottom > bottom ? Math.min(box.top - top, box.bottom - bottom) : 0;
  if (offset) list.scrollTo?.({ top: list.scrollTop + offset, behavior });
}
