import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * A plain browser pane is heard only while the operator has it in front of them (operator 2/11 14:22 BKK): this Space
 * window is shown and focused, the pane's room is on screen (`visible`), and its card is neither minimized nor hidden
 * and is the room's selected pane or maximized. The YouTube pane, Music and the Playlist do not use this gate.
 * The card's classes come from PaneCard (`is-target`, `is-maximized`, `is-minimized`, `is-shell-hidden`).
 */
export function browserPaneAudible(visible: boolean, windowAttended: boolean, cardClass: string | null): boolean {
  if (!visible || !windowAttended) return false;
  if (cardClass === null) return true;
  const classes = cardClass.split(/\s+/);
  if (classes.includes("is-minimized") || classes.includes("is-shell-hidden")) return false;
  return classes.includes("is-target") || classes.includes("is-maximized");
}

function windowAttended() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useBrowserPaneAudible(paneRef: RefObject<HTMLElement | null>, visible: boolean): boolean {
  const [attended, setAttended] = useState(windowAttended);
  const [cardClass, setCardClass] = useState<string | null>(null);
  const observed = useRef<{ card: Element; stop: () => void } | null>(null);

  useEffect(() => {
    const check = () => setAttended(windowAttended());
    // Focus moving into an iframe blurs the window while the document keeps focus: read it after the event settles.
    const later = () => { window.setTimeout(check, 0); };
    window.addEventListener("focus", check);
    window.addEventListener("blur", later);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", later);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  useEffect(() => {
    const card = paneRef.current?.closest(".pane-card") ?? null;
    if (observed.current?.card === card) return;
    observed.current?.stop();
    observed.current = null;
    setCardClass(card ? card.className : null);
    if (!card) return;
    const observer = new MutationObserver(() => setCardClass(card.className));
    observer.observe(card, { attributes: true, attributeFilter: ["class"] });
    observed.current = { card, stop: () => observer.disconnect() };
  });
  useEffect(() => () => { observed.current?.stop(); observed.current = null; }, []);

  return browserPaneAudible(visible, attended, cardClass);
}
