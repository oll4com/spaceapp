import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { setSnipRailOpen } from "../desktop-widgets/widget-storage.js";

// Snip Tool visibility and its PrintScreen shortcut (keyboard and the desktop bridge).

export interface SnipTool {
  isSnipToolOpen: boolean;
  setIsSnipToolOpen: Dispatch<SetStateAction<boolean>>;
  /** "capturing" only for an open from PrintScreen; reset when the tool closes. */
  snipToolInitialModeRef: MutableRefObject<"float" | "capturing">;
}

export function useSnipTool(): SnipTool {
  const [isSnipToolOpen, setIsSnipToolOpen] = useState(false);
  useEffect(() => {
    if (isSnipToolOpen) {
      document.body.setAttribute("data-snip-tool-active", "true");
    } else {
      document.body.removeAttribute("data-snip-tool-active");
    }
    // A Snip Tool docked on the right rail holds its slot only while it is open.
    setSnipRailOpen(isSnipToolOpen);
  }, [isSnipToolOpen]);

  const snipToolInitialModeRef = useRef<"float" | "capturing">("float");
  const lastPrintScreenRef = useRef({ keyDownAt: 0, triggeredAt: 0 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    // A PrtScn open is one-shot: reopening from the rail shows the capsule again.
    if (!isSnipToolOpen) snipToolInitialModeRef.current = "float";

    const triggerSnipShortcut = () => {
      const now = Date.now();
      if (now - lastPrintScreenRef.current.triggeredAt < 350) return;
      lastPrintScreenRef.current.triggeredAt = now;

      console.log("[SpaceApp Web] Triggering Snip Tool shortcut (PrtScn)");
      if (isSnipToolOpen) {
        window.dispatchEvent(new CustomEvent("space:snip-tool:trigger"));
      } else {
        snipToolInitialModeRef.current = "capturing";
        setIsSnipToolOpen(true);
      }
    };

    const isPrintScreenEvent = (event: KeyboardEvent) => {
      return (
        event.key === "PrintScreen" ||
        event.code === "PrintScreen" ||
        (event as any).key === "Snapshot" ||
        (event as any).key === "Print" ||
        event.keyCode === 44 ||
        event.which === 44
      );
    };

    const handlePrintScreenKey = (event: KeyboardEvent) => {
      if (!isPrintScreenEvent(event)) return;

      console.log(`[SpaceApp] PrintScreen caught: type=${event.type}, key=${event.key}, code=${event.code}, keyCode=${event.keyCode}`);

      event.preventDefault();
      event.stopPropagation();

      // Most platforms send keydown + keyup; Windows sends only keyup. Act once per press,
      // otherwise a slower press opens the selection on keydown and cancels it on keyup.
      if (event.type === "keydown") {
        if (event.repeat) return;
        lastPrintScreenRef.current.keyDownAt = Date.now();
      } else if (Date.now() - lastPrintScreenRef.current.keyDownAt < 2000) {
        return;
      }

      // Clear any multi-monitor screenshot Windows may have placed on clipboard
      try {
        if (navigator?.clipboard?.writeText) {
          void navigator.clipboard.writeText("").catch(() => {});
        }
      } catch {}

      triggerSnipShortcut();
    };

    window.addEventListener("keydown", handlePrintScreenKey, true);
    window.addEventListener("keyup", handlePrintScreenKey, true);

    const desktopBridge = (window as any).spaceDesktop;
    let unsubscribePrintScreen: (() => void) | undefined;
    if (typeof desktopBridge?.onPrintScreen === "function") {
      const unsub = desktopBridge.onPrintScreen(() => {
        triggerSnipShortcut();
      });
      if (typeof unsub === "function") {
        unsubscribePrintScreen = unsub;
      }
    }

    return () => {
      window.removeEventListener("keydown", handlePrintScreenKey, true);
      window.removeEventListener("keyup", handlePrintScreenKey, true);
      unsubscribePrintScreen?.();
    };
  }, [isSnipToolOpen]);

  return { isSnipToolOpen, setIsSnipToolOpen, snipToolInitialModeRef };
}
