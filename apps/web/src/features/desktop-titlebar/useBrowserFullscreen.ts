import { useEffect, useState } from "react";
import { isDocumentFullscreen, toggleBrowserFullscreen } from "./fullscreen.js";

/**
 * Whether the browser (or the desktop app window) is full screen. Follows the
 * document and desktop-bridge fullscreen events and toggles on F11.
 */
export function useBrowserFullscreen(): boolean {
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(() => isDocumentFullscreen());

  useEffect(() => {
    const bridge = (window as any).spaceDesktop;
    let disposed = false;
    const handleFullscreenChange = () => {
      if (typeof bridge?.isFullscreen === "function") {
        void bridge.isFullscreen().then((fullscreen: boolean) => {
          if (!disposed) setIsBrowserFullscreen(fullscreen || isDocumentFullscreen());
        }).catch(() => {});
      } else {
        setIsBrowserFullscreen(isDocumentFullscreen());
      }
    };
    const unsubscribe = bridge?.onFullscreenChange?.((fullscreen: boolean) => {
      if (!disposed) setIsBrowserFullscreen(fullscreen);
    });
    if (typeof bridge?.isFullscreen === "function") {
      void bridge.isFullscreen().then((fullscreen: boolean) => {
        if (!disposed) setIsBrowserFullscreen(fullscreen);
      }).catch(() => {});
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F11") {
        event.preventDefault();
        void toggleBrowserFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      disposed = true;
      if (typeof unsubscribe === "function") unsubscribe();
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return isBrowserFullscreen;
}
