import React, { useEffect, useState, useRef } from "react";
import { Monitor, Maximize2, X, ExternalLink } from "../ui-theme/app-icons.js";
import "./desktop-display-controls.css";

export interface DesktopDisplayInfo {
  id: number;
  label: string;
  isPrimary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
  isPortrait: boolean;
  positionLabel: string;
  hasActiveWindow: boolean;
}

interface DesktopDisplayControlsProps {
  activeRoomId?: string | null;
  activePaneId?: string | null;
  variant?: "titlebar" | "rail" | "toolbar";
}

export function DesktopDisplayControls({
  activeRoomId,
  activePaneId,
  variant = "titlebar"
}: DesktopDisplayControlsProps) {
  const [displays, setDisplays] = useState<DesktopDisplayInfo[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const desktopBridge = typeof window !== "undefined" ? (window as any).spaceDesktop : null;
  const isDesktop = typeof window !== "undefined" && Boolean(
    desktopBridge?.isDesktop ||
    desktopBridge?.displays ||
    desktopBridge
  );
  const hasNativeMultiDisplay = Boolean(desktopBridge?.displays?.getAll);

  const fetchDisplays = async () => {
    if (desktopBridge?.displays?.getAll) {
      try {
        const list = await desktopBridge.displays.getAll();
        if (Array.isArray(list) && list.length > 0) {
          setDisplays(list);
          return;
        }
      } catch (err) {
        console.warn("Could not fetch displays:", err);
      }
    }

    if (typeof window !== "undefined" && window.screen) {
      setDisplays([{
        id: 1,
        label: "Primary Display",
        isPrimary: true,
        bounds: {
          x: 0,
          y: 0,
          width: window.screen.width,
          height: window.screen.height
        },
        workArea: {
          x: 0,
          y: 0,
          width: window.screen.availWidth,
          height: window.screen.availHeight
        },
        scaleFactor: window.devicePixelRatio || 1,
        rotation: 0,
        isPortrait: window.screen.height > window.screen.width,
        positionLabel: "Center",
        hasActiveWindow: true
      }]);
    }
  };

  useEffect(() => {
    if (!isDesktop) return;
    void fetchDisplays();
    const interval = setInterval(() => {
      void fetchDisplays();
    }, 5000);
    return () => clearInterval(interval);
  }, [isDesktop]);

  useEffect(() => {
    const handleOpenDisplays = () => {
      setIsOpen(true);
      void fetchDisplays();
    };
    window.addEventListener("space:desktop:open-displays", handleOpenDisplays);
    return () => window.removeEventListener("space:desktop:open-displays", handleOpenDisplays);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isOpen) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!isDesktop) {
    return null;
  }

  const handleLaunchAll = async () => {
    if (!desktopBridge?.displays?.launchAll) return;
    setActionPending(true);
    setStatusMessage("Opening fullscreen windows on all secondary displays…");
    try {
      const res = await desktopBridge.displays.launchAll();
      setStatusMessage(`Launched ${res.openedCount} fullscreen displays.`);
      await fetchDisplays();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || String(err)}`);
    } finally {
      setActionPending(false);
    }
  };

  const handleCloseAll = async () => {
    if (!desktopBridge?.displays?.closeAll) return;
    setActionPending(true);
    try {
      await desktopBridge.displays.closeAll();
      setStatusMessage("Closed all satellite windows.");
      await fetchDisplays();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || String(err)}`);
    } finally {
      setActionPending(false);
    }
  };

  const handleOpenDisplay = async (displayId: number, options?: { roomId?: string; paneId?: string }) => {
    if (!desktopBridge?.displays?.openWindow) return;
    setActionPending(true);
    try {
      await desktopBridge.displays.openWindow({
        displayId,
        fullscreen: true,
        roomId: options?.roomId,
        paneId: options?.paneId
      });
      await fetchDisplays();
    } catch (err: any) {
      setStatusMessage(`Error: ${err?.message || String(err)}`);
    } finally {
      setActionPending(false);
    }
  };

  const displayCount = displays.length;
  const secondaryDisplays = displays.filter((d) => !d.isPrimary);
  const hasActiveSatellites = secondaryDisplays.some((d) => d.hasActiveWindow);

  return (
    <div className="desktop-display-controls" data-variant={variant} ref={containerRef}>
      {variant === "rail" ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary desktop-display-trigger ${isOpen ? "is-active" : ""}`}
          data-rail-id="displays"
          onClick={() => {
            setIsOpen((prev) => !prev);
            void fetchDisplays();
          }}
          title={`Multi-Screen Displays (${displayCount} detected)`}
          aria-label="Multi-Screen Displays"
          aria-expanded={isOpen}
        >
          <Monitor aria-hidden="true" />
          {displayCount > 1 ? (
            <span className="desktop-display-badge">{displayCount}</span>
          ) : null}
        </button>
      ) : (
        <button
          type="button"
          className={`desktop-display-trigger ${isOpen ? "is-active" : ""}`}
          onClick={() => {
            setIsOpen((prev) => !prev);
            void fetchDisplays();
          }}
          title={`Displays: ${displayCount} detected (${displays.map((d) => d.positionLabel || d.label).join(", ")})`}
          aria-label="Desktop Displays and Multi-Screen Controls"
          aria-expanded={isOpen}
        >
          <Monitor aria-hidden="true" style={{ width: "1rem", height: "1rem" }} />
          {displayCount > 1 ? (
            <span className="desktop-display-badge">{displayCount}</span>
          ) : null}
        </button>
      )}

      {isOpen && (
        <div className="desktop-display-popover">
          <div className="desktop-display-header">
            <div>
              <h3>
                <Monitor aria-hidden="true" style={{ width: "1.1rem", height: "1.1rem" }} />
                Multi-Screen Workspace
              </h3>
              <small>{displayCount} {displayCount === 1 ? "Display" : "Displays"} Detected</small>
            </div>
            <button
              type="button"
              className="desktop-display-mini-btn"
              style={{ width: "28px", height: "28px", flex: "none", padding: 0 }}
              onClick={() => setIsOpen(false)}
            >
              <X aria-hidden="true" style={{ width: "14px", height: "14px" }} />
            </button>
          </div>

          {!hasNativeMultiDisplay ? (
            <div className="desktop-display-notice">
              <strong>SpaceApp Native Desktop Required</strong>
              <p>
                To launch native fullscreen windows across all monitors automatically, please run SpaceApp Desktop v0.1.15.
              </p>
              <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                <a
                  href="/api/desktop/download/SpaceApp-0.1.15.AppImage"
                  download="SpaceApp-0.1.15.AppImage"
                  className="desktop-display-action-btn primary"
                  style={{ textDecoration: "none", fontSize: "0.8rem", padding: "6px 10px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  Download Linux AppImage
                </a>
                <a
                  href="/api/desktop/download/SpaceApp-Setup-0.1.15.exe"
                  download="SpaceApp-Setup-0.1.15.exe"
                  className="desktop-display-action-btn secondary"
                  style={{ textDecoration: "none", fontSize: "0.8rem", padding: "6px 10px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                >
                  Download Windows App
                </a>
              </div>
            </div>
          ) : (
            <div className="desktop-display-quick-actions">
              <button
                type="button"
                className="desktop-display-action-btn primary"
                onClick={handleLaunchAll}
                disabled={actionPending || secondaryDisplays.length === 0}
              >
                <Maximize2 aria-hidden="true" style={{ width: "15px", height: "15px" }} />
                Launch Multi-Screen Fullscreen ({secondaryDisplays.length})
              </button>
              {hasActiveSatellites && (
                <button
                  type="button"
                  className="desktop-display-action-btn secondary"
                  onClick={handleCloseAll}
                  disabled={actionPending}
                >
                  Close Satellite Windows
                </button>
              )}
              {statusMessage && (
                <small style={{ color: "#58a6ff", textAlign: "center", fontSize: "0.75rem" }}>
                  {statusMessage}
                </small>
              )}
            </div>
          )}

          <div className="desktop-display-list">
            {displays.map((disp, idx) => {
              const cardClass = [
                "desktop-display-card",
                disp.isPrimary ? "is-primary" : "",
                disp.isPortrait ? "is-portrait" : "",
                disp.positionLabel === "Top" ? "is-top" : ""
              ].filter(Boolean).join(" ");

              return (
                <div key={disp.id || idx} className={cardClass}>
                  <div className="desktop-display-card-header">
                    <span className="desktop-display-card-title">
                      <Monitor aria-hidden="true" style={{ width: "13px", height: "13px" }} />
                      Display {idx + 1}
                    </span>
                    <span className="desktop-display-tag">
                      {disp.isPrimary
                        ? "Primary"
                        : `${disp.positionLabel || "Secondary"} · ${disp.isPortrait ? "Portrait" : "Landscape"}`}
                    </span>
                  </div>

                  <div className="desktop-display-card-meta">
                    {disp.bounds.width}×{disp.bounds.height} · {disp.isPortrait ? "Vertical" : "Horizontal"}
                    {disp.scaleFactor && disp.scaleFactor !== 1 ? ` · ${Math.round(disp.scaleFactor * 100)}% Scale` : ""}
                    {disp.hasActiveWindow && !disp.isPrimary ? " · (Window Active)" : ""}
                  </div>

                  {!disp.isPrimary && (
                    <div className="desktop-display-card-buttons">
                      <button
                        type="button"
                        className="desktop-display-mini-btn"
                        onClick={() => handleOpenDisplay(disp.id)}
                        disabled={actionPending}
                      >
                        <ExternalLink aria-hidden="true" style={{ width: "12px", height: "12px" }} />
                        Fullscreen
                      </button>
                      {activeRoomId && (
                        <button
                          type="button"
                          className="desktop-display-mini-btn"
                          onClick={() => handleOpenDisplay(disp.id, { roomId: activeRoomId })}
                          disabled={actionPending}
                        >
                          Send Room
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
