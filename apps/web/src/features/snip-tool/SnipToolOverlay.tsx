import React, { useState, useRef, useEffect, useCallback } from "react";
import { Crop, Maximize2, X, Crosshair, Check, ChevronDown, Monitor, RefreshCw } from "../ui-theme/app-icons.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import "./snip-tool.css";

export interface SnipTargetPane {
  id: string;
  title: string;
  mode: string;
}

export interface SnipToolOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  isMobile?: boolean;
  activePaneId?: string | null;
  activePaneTitle?: string | null;
  activePaneMode?: string | null;
  availablePanes?: SnipTargetPane[];
  onSelectTargetPane?: (paneId: string) => void;
  onCapture: (file: File, targetPaneId?: string) => Promise<void>;
}

interface Point {
  x: number;
  y: number;
}

export function SnipToolOverlay({
  isOpen,
  onClose,
  isMobile,
  activePaneId,
  activePaneTitle,
  activePaneMode,
  availablePanes,
  onSelectTargetPane,
  onCapture
}: SnipToolOverlayProps) {
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);
  const [snipCount, setSnipCount] = useState(0);
  const [isBumpingCounter, setIsBumpingCounter] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [mobileNotice, setMobileNotice] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [isSourceMismatch, setIsSourceMismatch] = useState(false);

  const effectiveTargetId = selectedTargetId ?? activePaneId ?? availablePanes?.[0]?.id ?? null;

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const isMountedRef = useRef(false);

  const isDesktop = typeof window !== "undefined" && Boolean((window as any).spaceDesktop?.capturePage);
  const isMobileApp = typeof window !== "undefined" && Boolean((window as any).SpaceNative?.requestPageCapture);
  const isNativeApp = isDesktop || isMobileApp;

  // Initialize or teardown capture resources
  useEffect(() => {
    isMountedRef.current = true;
    if (!isOpen) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current = null;
      }
      setSnipCount(0);
      setSelectedTargetId(null);
      setSourceLabel(null);
      setIsSourceMismatch(false);
      setIsDragging(false);
      setStartPoint(null);
      setCurrentPoint(null);
      setIsPickerOpen(false);
      return;
    }

    // Keyboard listener for Escape key to close
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (isPickerOpen) {
          setIsPickerOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, onClose, isPickerOpen]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

function checkDisplayMediaSupported(): boolean {
  try {
    return Boolean(getSpaceRuntime()?.platform?.displayMediaSupported);
  } catch {
    return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  }
}

function waitForVideoFrame(video: HTMLVideoElement, timeoutMs = 3000): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let resolved = false;
    const clean = () => {
      clearTimeout(timer);
      for (const event of ["loadeddata", "canplay", "playing", "resize", "timeupdate"]) {
        video.removeEventListener(event, check);
      }
    };
    const check = () => {
      if (!resolved && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        resolved = true;
        clean();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clean();
        resolve();
      }
    }, timeoutMs);
    for (const event of ["loadeddata", "canplay", "playing", "resize", "timeupdate"]) {
      video.addEventListener(event, check);
    }
    void video.play().catch(() => {});
    check();
  });
}

function cropDataUrlViaCanvas(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number }
): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);

        const scaleX = img.naturalWidth / Math.max(1, window.innerWidth);
        const scaleY = img.naturalHeight / Math.max(1, window.innerHeight);

        const sx = Math.max(0, Math.min(img.naturalWidth - 1, Math.round(rect.x * scaleX)));
        const sy = Math.max(0, Math.min(img.naturalHeight - 1, Math.round(rect.y * scaleY)));
        const sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(rect.width * scaleX)));
        const sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(rect.height * scaleY)));

        canvas.width = sw;
        canvas.height = sh;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

  // Web capture helper: ensure active MediaStream video
  const ensureWebStreamVideo = useCallback(async (): Promise<HTMLVideoElement> => {
    if (videoRef.current && streamRef.current && streamRef.current.active) {
      return videoRef.current;
    }

    const runtime = getSpaceRuntime();
    let stream: MediaStream | null = null;

    // Progressive display media acquisition:
    // 1. Try standard constraints with preferCurrentTab hint (Chrome/Edge desktop)
    // NEVER specify displaySurface: "browser" inside video constraints because Linux Wayland/PipeWire
    // and Firefox reject it with DOMException: "Not supported" (NotSupportedError).
    try {
      stream = await runtime.platform.getDisplayMedia({
        video: {
          cursor: "always"
        } as any,
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "exclude"
      } as any);
    } catch (firstErr: any) {
      if (firstErr?.name === "NotAllowedError" || firstErr?.message?.includes("Permission denied")) {
        throw firstErr;
      }
      console.warn("[SnipTool] Tab-preferred displayMedia failed, trying universal constraints:", firstErr);
      // 2. Universal fallback (Linux Wayland, X11, Firefox, etc.)
      stream = await runtime.platform.getDisplayMedia({
        video: true,
        audio: false
      } as any);
    }

    if (!stream) {
      throw new Error("No display media stream available");
    }
    streamRef.current = stream;

    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    let friendlyName = "Display";
    if (settings.displaySurface === "browser") {
      friendlyName = "SpaceApp Tab";
    } else if (settings.displaySurface === "window") {
      friendlyName = track?.label ? `Window: ${track.label}` : "Window";
    } else if (settings.displaySurface === "monitor") {
      friendlyName = track?.label ? `${track.label}` : "Full Display";
    }
    setSourceLabel(friendlyName);

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    await waitForVideoFrame(video);
    videoRef.current = video;

    const rawWidth = (video.videoWidth > 0 ? video.videoWidth : 0) || (settings.width && settings.width > 0 ? settings.width : 0) || window.innerWidth;
    const rawHeight = (video.videoHeight > 0 ? video.videoHeight : 0) || (settings.height && settings.height > 0 ? settings.height : 0) || window.innerHeight;
    const isScreenPortrait = window.screen.width < window.screen.height;
    const isStreamPortrait = rawWidth < rawHeight;
    const mismatch = settings.displaySurface === "monitor" && (isScreenPortrait !== isStreamPortrait || Math.abs(rawWidth - window.screen.width) > 80);
    setIsSourceMismatch(mismatch);
    if (mismatch) {
      setMobileNotice("Stream is from another screen. Click 'Source' to select SpaceApp.");
      setTimeout(() => {
        if (isMountedRef.current) setMobileNotice(null);
      }, 5000);
    }

    // Listen for stream end (e.g. user clicks "Stop sharing" in browser)
    track?.addEventListener("ended", () => {
      if (isMountedRef.current) {
        streamRef.current = null;
        videoRef.current = null;
        setSourceLabel(null);
        setIsSourceMismatch(false);
      }
    });

    return video;
  }, []);

  const handleSwitchSource = useCallback(async () => {
    if (isCapturing) return;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    setSourceLabel(null);
    setIsSourceMismatch(false);
    try {
      await ensureWebStreamVideo();
    } catch (err: any) {
      console.warn("[SnipTool] Switch source cancelled or failed:", err);
      const isNotAllowed = err?.name === "NotAllowedError" || err?.message?.includes("Permission denied");
      if (!isNotAllowed) {
        setMobileNotice(err?.message || "Source switch failed");
        setTimeout(() => {
          if (isMountedRef.current) setMobileNotice(null);
        }, 3000);
      }
    }
  }, [isCapturing, ensureWebStreamVideo]);

  // Flash & counter animation feedback
  const triggerFeedback = useCallback(() => {
    setIsFlashing(true);
    setIsBumpingCounter(true);
    setTimeout(() => {
      if (isMountedRef.current) setIsFlashing(false);
    }, 220);
    setTimeout(() => {
      if (isMountedRef.current) setIsBumpingCounter(false);
    }, 300);
    setSnipCount((prev) => prev + 1);
  }, []);

  // Mobile capture helper via Android SpaceNative bridge
  const captureViaMobileBridge = useCallback(
    async (cropRect?: { x: number; y: number; width: number; height: number }): Promise<Blob | null> => {
      const spaceNative = typeof window !== "undefined" ? (window as any).SpaceNative : null;
      if (!spaceNative || typeof spaceNative.requestPageCapture !== "function") return null;

      return new Promise<Blob>((resolve, reject) => {
        const callbackId = "snip_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
        const timeout = setTimeout(() => {
          delete (window as any).__spaceNativeCaptureCallbacks?.[callbackId];
          reject(new Error("Mobile screen capture timed out"));
        }, 8000);

        if (!(window as any).__spaceNativeCaptureCallbacks) {
          (window as any).__spaceNativeCaptureCallbacks = {};
          (window as any).__onSpaceNativeCapture = (id: string, success: boolean, errMsg?: string) => {
            const cb = (window as any).__spaceNativeCaptureCallbacks?.[id];
            if (cb) {
              delete (window as any).__spaceNativeCaptureCallbacks[id];
              cb(success, errMsg);
            }
          };
        }

        (window as any).__spaceNativeCaptureCallbacks[callbackId] = (success: boolean, errMsg?: string) => {
          clearTimeout(timeout);
          if (!success) {
            reject(new Error(errMsg || "Mobile screen capture failed"));
            return;
          }
          try {
            const dataUrl = spaceNative.getCapturedData?.(callbackId);
            if (!dataUrl) {
              reject(new Error("Captured image data was empty"));
              return;
            }
            const parts = dataUrl.split(",");
            const byteString = atob(parts[1]);
            const mime = parts[0].split(":")[1].split(";")[0];
            const ab = new ArrayBuffer(byteString.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteString.length; i++) {
              ia[i] = byteString.charCodeAt(i);
            }
            resolve(new Blob([ab], { type: mime }));
          } catch (e: any) {
            reject(e);
          }
        };

        const density = window.devicePixelRatio || 1;
        const x = cropRect && cropRect.width > 0 ? Math.round(cropRect.x * density) : 0;
        const y = cropRect && cropRect.height > 0 ? Math.round(cropRect.y * density) : 0;
        const w = cropRect && cropRect.width > 0 ? Math.round(cropRect.width * density) : 0;
        const h = cropRect && cropRect.height > 0 ? Math.round(cropRect.height * density) : 0;

        spaceNative.requestPageCapture(x, y, w, h, callbackId);
      });
    },
    []
  );

  // Execute capture for a region or full screen
  const performCapture = useCallback(
    async (cropRect?: { x: number; y: number; width: number; height: number }) => {
      if (isCapturing) return;
      setIsCapturing(true);

      try {
        let blob: Blob | null = null;
        const now = Date.now();
        const filename = cropRect
          ? `space-snip-${now}.png`
          : `space-snip-fullscreen-${now}.png`;

        const desktopBridge = typeof window !== "undefined" ? (window as any).spaceDesktop : null;
        const hasNativeCapture = typeof desktopBridge?.capturePage === "function";
        const hasMobileCapture = typeof (window as any).SpaceNative?.requestPageCapture === "function";

        // For native captures (desktop & mobile), temporarily hide overlay HUD/dimmer for a pristine image
        const overlayEl = overlayRef.current;
        if (overlayEl && (hasNativeCapture || hasMobileCapture)) {
          overlayEl.style.visibility = "hidden";
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        try {
          if (hasNativeCapture) {
            // Native Desktop capture via Electron bridge
            try {
              const rect = cropRect && cropRect.width > 0 && cropRect.height > 0
                ? {
                    x: Math.round(cropRect.x),
                    y: Math.round(cropRect.y),
                    width: Math.round(cropRect.width),
                    height: Math.round(cropRect.height)
                  }
                : undefined;

              let res = await desktopBridge.capturePage(rect);
              // Fallback for desktop: if capture with rect returned failure/empty image, capture full window and crop in memory
              if ((!res?.success || !res?.dataUrl) && rect) {
                console.warn("[SnipTool] Native capturePage with rect failed, falling back to full capture + canvas crop:", res?.reason);
                const fullRes = await desktopBridge.capturePage();
                if (fullRes?.success && fullRes.dataUrl) {
                  const croppedDataUrl = await cropDataUrlViaCanvas(fullRes.dataUrl, rect);
                  if (croppedDataUrl) {
                    res = { success: true, dataUrl: croppedDataUrl };
                  }
                }
              }

              if (res?.success && res.dataUrl) {
                const parts = res.dataUrl.split(",");
                const byteString = atob(parts[1]);
                const mime = parts[0].split(":")[1].split(";")[0];
                const ab = new ArrayBuffer(byteString.length);
                const ia = new Uint8Array(ab);
                for (let i = 0; i < byteString.length; i++) {
                  ia[i] = byteString.charCodeAt(i);
                }
                blob = new Blob([ab], { type: mime });
              }
            } catch (deskErr) {
              console.warn("[SnipTool] Native capturePage failed, falling back to display stream:", deskErr);
            }
          } else if (hasMobileCapture) {
            // Native Mobile capture via Android SpaceNative bridge
            try {
              blob = await captureViaMobileBridge(cropRect);
            } catch (mobErr) {
              console.warn("[SnipTool] Mobile native capture failed:", mobErr);
              throw mobErr;
            }
          }
        } finally {
          if (overlayEl && (hasNativeCapture || hasMobileCapture)) {
            overlayEl.style.visibility = "";
          }
        }

        if (!blob) {
          const runtime = getSpaceRuntime();
          if (!runtime.platform.displayMediaSupported) {
            throw new DOMException("Screen capture is not supported in mobile web browsers. Please use the SpaceApp Android app or upload an image.", "NotSupportedError");
          }

          // Web capture via getDisplayMedia + Canvas crop
          const video = await ensureWebStreamVideo();
          await waitForVideoFrame(video);
          const track = streamRef.current?.getVideoTracks()[0];
          const settings = track?.getSettings?.() ?? {};
          const rawWidth = (video.videoWidth > 0 ? video.videoWidth : 0) || (settings.width && settings.width > 0 ? settings.width : 0) || window.innerWidth || 1920;
          const rawHeight = (video.videoHeight > 0 ? video.videoHeight : 0) || (settings.height && settings.height > 0 ? settings.height : 0) || window.innerHeight || 1080;
          const videoWidth = Math.max(1, Math.round(rawWidth));
          const videoHeight = Math.max(1, Math.round(rawHeight));

          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas context is unavailable");

          if (cropRect && cropRect.width > 0 && cropRect.height > 0) {
            const scaleX = videoWidth / Math.max(1, window.innerWidth);
            const scaleY = videoHeight / Math.max(1, window.innerHeight);

            const sx = Math.max(0, Math.min(videoWidth - 1, Math.round(cropRect.x * scaleX)));
            const sy = Math.max(0, Math.min(videoHeight - 1, Math.round(cropRect.y * scaleY)));
            const sw = Math.max(1, Math.min(videoWidth - sx, Math.round(cropRect.width * scaleX)));
            const sh = Math.max(1, Math.min(videoHeight - sy, Math.round(cropRect.height * scaleY)));

            canvas.width = sw;
            canvas.height = sh;
            ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          } else {
            canvas.width = videoWidth;
            canvas.height = videoHeight;
            ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
          }

          blob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((nextBlob) => {
              if (nextBlob) resolve(nextBlob);
              else reject(new Error("Canvas export to PNG failed"));
            }, "image/png");
          });
        }

        if (blob) {
          const file = new File([blob], filename, { type: "image/png" });
          await onCapture(file, effectiveTargetId ?? undefined);
          triggerFeedback();
        }
      } catch (err: any) {
        console.error("[SnipTool] Capture error:", err);
        const isNotAllowed = err?.name === "NotAllowedError" || err?.message?.includes("Permission denied");
        const isNotSupported = err?.name === "NotSupportedError" || err?.message?.toLowerCase().includes("not supported");
        let noticeText = "Capture failed";
        if (isNotAllowed) {
          noticeText = "Capture cancelled";
        } else if (isNotSupported) {
          noticeText = "Screen capture not supported by system display manager. Try desktop app.";
        } else if (err?.message) {
          noticeText = err.message;
        }
        setMobileNotice(noticeText);
        setTimeout(() => {
          if (isMountedRef.current) setMobileNotice(null);
        }, 4000);
      } finally {
        if (isMountedRef.current) {
          setIsCapturing(false);
          setIsDragging(false);
          setStartPoint(null);
          setCurrentPoint(null);
        }
      }
    },
    [isCapturing, ensureWebStreamVideo, captureViaMobileBridge, onCapture, triggerFeedback, effectiveTargetId]
  );

  // Fullscreen snip handler (1-click)
  const handleFullScreenSnip = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void performCapture();
  };

  // Pointer event handlers for drag selection
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isPickerOpen) setIsPickerOpen(false);
    if ((e.pointerType === "mouse" && e.button !== 0) || isCapturing) return;
    const target = e.target as HTMLElement;
    if (target.closest(".snip-tool-hud") || target.closest(".snip-tool-target-dropdown")) return;

    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const point = { x: e.clientX, y: e.clientY };
    setStartPoint(point);
    setCurrentPoint(point);
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !startPoint || isCapturing) return;
    e.preventDefault();
    setCurrentPoint({ x: e.clientX, y: e.clientY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !startPoint || !currentPoint || isCapturing) {
      setIsDragging(false);
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    const rect = {
      x: Math.min(startPoint.x, currentPoint.x),
      y: Math.min(startPoint.y, currentPoint.y),
      width: Math.abs(currentPoint.x - startPoint.x),
      height: Math.abs(currentPoint.y - startPoint.y)
    };

    // Minimum size check (must be at least 15x15 px to avoid accidental clicks)
    if (rect.width >= 15 && rect.height >= 15) {
      setIsDragging(false);
      setStartPoint(null);
      setCurrentPoint(null);
      void performCapture(rect);
    } else {
      setIsDragging(false);
      setStartPoint(null);
      setCurrentPoint(null);
    }
  };

  if (!isOpen) return null;

  // Resolve current target pane display information
  const currentTarget =
    availablePanes?.find((p) => p.id === effectiveTargetId) ??
    (activePaneTitle ? { id: activePaneId || "", title: activePaneTitle, mode: activePaneMode || "" } : null) ??
    availablePanes?.[0] ??
    null;

  const currentTitle = currentTarget?.title || activePaneTitle || "Active pane";
  const currentMode = currentTarget?.mode || activePaneMode || "Normal";

  // Compute selection box dimensions
  let selectionBoxStyle: React.CSSProperties | null = null;
  let dimensionsText = "";
  if (isDragging && startPoint && currentPoint) {
    const left = Math.min(startPoint.x, currentPoint.x);
    const top = Math.min(startPoint.y, currentPoint.y);
    const width = Math.abs(currentPoint.x - startPoint.x);
    const height = Math.abs(currentPoint.y - startPoint.y);

    selectionBoxStyle = {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`
    };
    dimensionsText = `${Math.round(width)} × ${Math.round(height)} px`;
  }

  return (
    <>
      {isFlashing ? <div className="snip-tool-flash" aria-hidden="true" /> : null}
      <div
        ref={overlayRef}
        className="snip-tool-overlay"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          setIsDragging(false);
          setStartPoint(null);
          setCurrentPoint(null);
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Snip Tool - drag to capture or click full screen"
      >
        {/* Floating Top Control HUD */}
        <div className={`snip-tool-hud${isMobile ? " is-mobile" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
          <div className="snip-tool-title-group">
            <Crop size={16} aria-hidden="true" />
            <span className="snip-tool-title-text">Snip Tool</span>
          </div>

          <div className="snip-tool-divider" aria-hidden="true" />

          {availablePanes && availablePanes.length > 1 ? (
            <div className="snip-tool-target-picker-wrapper">
              <button
                type="button"
                className="snip-tool-target-badge snip-tool-target-picker-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsPickerOpen((prev) => !prev);
                }}
                title={`Target pane: ${currentTitle} (${currentMode}) - Click to select another pane`}
                aria-haspopup="listbox"
                aria-expanded={isPickerOpen}
              >
                <Crosshair size={13} aria-hidden="true" className="snip-tool-target-icon" />
                <span className="snip-tool-target-label">Target:</span>
                <span className="snip-tool-target-title" title={currentTitle}>{currentTitle}</span>
                <ChevronDown size={12} aria-hidden="true" className="snip-tool-chevron-icon" />
              </button>
              {isPickerOpen ? (
                <div
                  className="snip-tool-target-dropdown"
                  role="listbox"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="snip-tool-target-dropdown-header">Select Target Pane:</div>
                  {availablePanes.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`snip-tool-target-option ${p.id === currentTarget?.id ? "selected" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedTargetId(p.id);
                        onSelectTargetPane?.(p.id);
                        setIsPickerOpen(false);
                      }}
                      role="option"
                      aria-selected={p.id === currentTarget?.id}
                      title={p.title || p.mode}
                    >
                      <div className="snip-tool-target-option-left">
                        {p.id === currentTarget?.id ? (
                          <Check size={12} className="snip-tool-option-check" />
                        ) : (
                          <Crosshair size={12} className="snip-tool-option-crosshair" />
                        )}
                        <span className="snip-tool-target-option-title">{p.title || p.mode}</span>
                      </div>
                      <span className="snip-tool-target-option-mode">{p.mode}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div
              className="snip-tool-target-badge"
              title={`Target pane: ${currentTitle} (${currentMode})`}
            >
              <Crosshair size={13} aria-hidden="true" className="snip-tool-target-icon" />
              <span className="snip-tool-target-label">Target:</span>
              <span className="snip-tool-target-title" title={currentTitle}>{currentTitle}</span>
            </div>
          )}

          <div className="snip-tool-divider" aria-hidden="true" />

          {!isNativeApp && checkDisplayMediaSupported() ? (
            <>
              <button
                type="button"
                className={`snip-tool-btn snip-tool-btn-source${isSourceMismatch ? " is-mismatch" : ""}`}
                onClick={handleSwitchSource}
                disabled={isCapturing}
                title={
                  sourceLabel
                    ? `Capture source: ${sourceLabel} - Click to switch display or tab`
                    : "Select screen or SpaceApp tab"
                }
              >
                <Monitor size={13} aria-hidden="true" />
                <span className="snip-tool-source-text">
                  {sourceLabel ? (sourceLabel.length > 15 ? `${sourceLabel.slice(0, 13)}…` : sourceLabel) : "Source"}
                </span>
                <RefreshCw size={11} aria-hidden="true" className="snip-tool-refresh-icon" />
              </button>
              <div className="snip-tool-divider" aria-hidden="true" />
            </>
          ) : null}

          <button
            type="button"
            className="snip-tool-btn snip-tool-btn-fullscreen"
            onClick={handleFullScreenSnip}
            disabled={isCapturing}
            title="Take a full screen snip and attach to active pane"
          >
            <Maximize2 size={13} aria-hidden="true" />
            <span className="snip-tool-btn-text-full">Full Screen</span>
            <span className="snip-tool-btn-text-short">Full</span>
          </button>

          <div
            className={`snip-tool-counter-badge${isBumpingCounter ? " bump" : ""}`}
            title="Snips captured in this session"
          >
            {snipCount > 0 ? (
              <>
                <Check size={12} aria-hidden="true" />
                <span className="snip-tool-counter-text-full">{snipCount} captured</span>
                <span className="snip-tool-counter-text-short">{snipCount}</span>
              </>
            ) : (
              <>
                <span className="snip-tool-counter-text-full">0 captured</span>
                <span className="snip-tool-counter-text-short">0</span>
              </>
            )}
          </div>

          <span className="snip-tool-hint">Drag area to snip</span>

          <button
            type="button"
            className="snip-tool-btn snip-tool-btn-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close Snip Tool (Esc)"
            aria-label="Close Snip Tool"
          >
            <X size={14} aria-hidden="true" />
            <span className="snip-tool-btn-text-done">Done</span>
          </button>
        </div>

        {/* Floating Mobile Instruction Banner */}
        <div className={`snip-tool-mobile-banner${mobileNotice ? " is-notice" : ""}`} aria-live="polite">
          <span>{mobileNotice || "Drag to snip • Tap Full for screen"}</span>
        </div>

        {/* Selection Rectangle with Live Dimensions */}
        {selectionBoxStyle ? (
          <div className="snip-selection-box" style={selectionBoxStyle}>
            <div className="snip-selection-dimensions">{dimensionsText}</div>
          </div>
        ) : null}
      </div>
    </>
  );
}
