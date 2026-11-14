import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Info } from "../ui-theme/app-icons.js";
import "./info-tip.css";

const supportsPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/**
 * A small ⓘ beside a label whose text explains it: shown while a mouse hovers it or it has keyboard focus, held open by a click or
 * tap, closed by Esc, a tap outside or a second tap. The text is the button's description (aria-describedby) and sits in the top
 * layer (native popover), so a narrow dock's overflow never clips it. `text` and `label` come already in the interface language.
 */
export function InfoTip({ text, label }: { text: string; label: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const close = () => { pinned.current = false; setOpen(false); };
  const toggle = () => { if (open && pinned.current) close(); else { pinned.current = true; setOpen(true); } };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) close(); };
    // Esc closes the tip first, not the fullscreen dock around it (that listens on window).
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!open || !tip) return;
    if (supportsPopover) tip.showPopover();
    const place = () => {
      const anchor = wrapRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(288, window.innerWidth - 16);
      tip.style.width = `${width}px`;
      tip.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
      const below = anchor.bottom + 6;
      tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - tip.offsetHeight - 6) : below}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      if (supportsPopover && tip.matches(":popover-open")) tip.hidePopover();
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="info-tip"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse" && !pinned.current && !wrapRef.current?.contains(document.activeElement)) setOpen(false); }}
    >
      {/* A span, not a <button>: Settings rows are <label>s, and a button inside would become the label's control instead of the select. */}
      <span
        role="button"
        tabIndex={0}
        className="info-tip-button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => { if (!pinned.current) setOpen(false); }}
        onClick={(event) => {
          // Inside a <label> or a header the tap is the tip's alone.
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          toggle();
        }}
      >
        <Info aria-hidden="true" />
      </span>
      <span ref={tipRef} id={id} role="tooltip" className="info-tip-text" hidden={!open}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} popover={supportsPopover ? "manual" : undefined}>{text}</span>
    </span>
  );
}
