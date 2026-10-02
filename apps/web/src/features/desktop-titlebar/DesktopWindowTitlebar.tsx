import React, { useState, useEffect, useRef } from "react";
import { DesktopDisplayControls } from "../desktop-screens/DesktopDisplayControls.js";
import {
  Maximize2,
  RefreshCw,
  CircleHelp,
  X,
  Download,
  Check,
  Sparkles,
  Monitor,
  Play,
  FolderOpen,
  Video,
  Camera,
  Square,
  Crop
} from "../ui-theme/app-icons.js";
import "./desktop-window-titlebar.css";
import { toggleBrowserFullscreen } from "./fullscreen.js";

const ChevronDownIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ opacity: 0.65 }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

interface DesktopWindowTitlebarProps {
  activeRoomName?: string;
  activeRoomId?: string | null;
  activePaneId?: string | null;
  isFullscreen?: boolean;
}

interface DesktopSystemInfo {
  platform: string;
  arch: string;
  version: string;
  electronVersion: string;
  nodeVersion?: string;
  isWayland?: boolean;
}

interface DesktopReleaseInfo {
  version: string;
  name?: string;
  builtAt?: string;
  download7zUrl?: string;
  downloadZipUrl?: string;
  installerUrl?: string;
  targets?: any[];
}

function isVersionNewer(remoteVersion?: string, localVersion?: string): boolean {
  if (!remoteVersion || !localVersion) return false;
  const parse = (v: string) =>
    v.replace(/^[^\d]*/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);

  const [rMaj = 0, rMin = 0, rPat = 0] = parse(remoteVersion);
  const [lMaj = 0, lMin = 0, lPat = 0] = parse(localVersion);

  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPat > lPat;
}

export function DesktopWindowTitlebar({
  activeRoomName,
  activeRoomId,
  activePaneId,
  isFullscreen
}: DesktopWindowTitlebarProps) {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return false;
    const bridge = (window as any).spaceDesktop;
    return Boolean(bridge?.isDesktop || bridge?.displays || bridge);
  });
  const [isWindowMaximized, setIsWindowMaximized] = useState(true);

  const desktopBridge = typeof window !== "undefined" ? (window as any).spaceDesktop : null;

  useEffect(() => {
    const checkBridge = () => {
      const bridge = typeof window !== "undefined" ? (window as any).spaceDesktop : null;
      if (Boolean(bridge?.isDesktop || bridge?.displays || bridge)) {
        setIsDesktop(true);
      }
    };
    checkBridge();
    const interval = setInterval(checkBridge, 200);
    const timeout = setTimeout(() => clearInterval(interval), 4000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!desktopBridge) return;
    if (desktopBridge.isMaximized) {
      desktopBridge.isMaximized().then((max: boolean) => {
        if (typeof max === "boolean") setIsWindowMaximized(max);
      }).catch(() => {});
    }
    if (typeof desktopBridge.onMaximizeChange === "function") {
      const unsub = desktopBridge.onMaximizeChange((max: boolean) => {
        if (typeof max === "boolean") setIsWindowMaximized(max);
      });
      return () => {
        if (typeof unsub === "function") unsub();
      };
    }
  }, [desktopBridge]);

  const [systemInfo, setSystemInfo] = useState<DesktopSystemInfo | null>(null);
  const [latestRelease, setLatestRelease] = useState<DesktopReleaseInfo | null>(null);
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "in-progress" | "fallback-downloaded" | "installer-ready">("idle");
  const [activeAspectRatio, setActiveAspectRatio] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [isRecordingDialogOpen, setIsRecordingDialogOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isDesktop) return;
    if (desktopBridge?.getSystemInfo) {
      desktopBridge.getSystemInfo().then((info: DesktopSystemInfo) => {
        if (info) setSystemInfo(info);
      }).catch(() => {
        setSystemInfo({
          platform: "win32",
          arch: "x64",
          version: "",
          electronVersion: ""
        });
      });
    } else {
      setSystemInfo({
        platform: "win32",
        arch: "x64",
        version: "",
        electronVersion: ""
      });
    }
  }, [isDesktop, desktopBridge]);

  const checkForUpdates = async () => {
    try {
      const res = await fetch("/api/desktop/latest", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data?.version) {
          setLatestRelease(data);
        }
      }
    } catch (err) {
      console.warn("Could not check for desktop updates:", err);
    }
  };

  useEffect(() => {
    if (!isDesktop) return;
    void checkForUpdates();
    const interval = setInterval(() => {
      void checkForUpdates();
    }, 60_000);
    return () => clearInterval(interval);
  }, [isDesktop]);

  useEffect(() => {
    let interval: any = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRecording]);

  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (recordedVideoUrl) {
        URL.revokeObjectURL(recordedVideoUrl);
      }
    };
  }, [recordedVideoUrl]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setIsAppMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAppMenuOpen(false);
        setIsAboutDialogOpen(false);
        setIsUpdateDialogOpen(false);
        setIsRecordingDialogOpen(false);
      }
    };
    if (isAppMenuOpen || isAboutDialogOpen || isUpdateDialogOpen || isRecordingDialogOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAppMenuOpen, isAboutDialogOpen, isUpdateDialogOpen, isRecordingDialogOpen]);

  if (!isDesktop || isFullscreen) {
    return null;
  }

  const currentVersion = systemInfo?.version || "unknown";
  const targetVersion = latestRelease?.version || currentVersion;
  const hasUpdate = Boolean(latestRelease?.version && isVersionNewer(latestRelease.version, currentVersion));

  const platformLabel = systemInfo?.platform === "win32"
    ? `Windows (${systemInfo?.arch || "x64"})`
    : systemInfo?.platform === "darwin"
    ? `macOS (${systemInfo?.arch || "universal"})`
    : `Linux (${systemInfo?.arch || "x64"})`;

  const handleToggleFullscreen = () => {
    setIsAppMenuOpen(false);
    void toggleBrowserFullscreen();
  };

  const handleReloadWindow = () => {
    setIsAppMenuOpen(false);
    window.location.reload();
  };

  const formatDuration = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const handleSelectAspectRatio = async (preset: "16:9" | "1:1" | "4:5" | "9:16" | "maximize") => {
    try {
      if (desktopBridge?.setAspectRatio) {
        const res = await desktopBridge.setAspectRatio(preset);
        if (res?.success) {
          setActiveAspectRatio(preset === "maximize" ? null : preset);
        }
      }
    } catch (err) {
      console.warn("Could not set aspect ratio:", err);
    }
  };

  const handleToggleRecording = async () => {
    if (isRecording) {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        try {
          mediaRecorderRef.current.stop();
        } catch (err) {
          console.warn("Error stopping MediaRecorder:", err);
          setIsRecording(false);
        }
      }
      return;
    }

    try {
      let stream: MediaStream | null = null;
      if (desktopBridge?.getWindowMediaSourceId) {
        const res = await desktopBridge.getWindowMediaSourceId();
        if (res?.success && res.sourceId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: res.sourceId,
                  minWidth: 1280,
                  maxWidth: 3840,
                  minHeight: 720,
                  maxHeight: 2160,
                  minFrameRate: 30,
                  maxFrameRate: 60
                }
              } as any
            });
          } catch (gumErr) {
            console.warn("getUserMedia with sourceId notice:", gumErr);
          }
        }
      }

      if (!stream) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false
        });
      }

      if (!stream) {
        throw new Error("Screen capture stream could not be acquired.");
      }

      const preferredMime = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ].find((type) => MediaRecorder.isTypeSupported(type)) || "video/webm";

      const recorder = new MediaRecorder(stream, { mimeType: preferredMime });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        const finalBlob = new Blob(chunks, { type: preferredMime });
        stream?.getTracks().forEach((track) => track.stop());
        setRecordedBlob(finalBlob);
        setRecordedVideoUrl(URL.createObjectURL(finalBlob));
        setIsRecording(false);
        setIsRecordingDialogOpen(true);
        setSaveStatus("idle");
      };

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          if (recorder.state === "recording") {
            try {
              recorder.stop();
            } catch {}
          }
        };
      }

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      mediaStreamRef.current = stream;
      setIsRecording(true);
      setRecordingSeconds(0);
    } catch (err: any) {
      console.warn("Could not start recording:", err);
      setIsRecording(false);
    }
  };

  const handleSaveRecording = async () => {
    if (!recordedBlob) return;
    setSaveStatus("saving");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `SpaceApp-Recording-${timestamp}.webm`;

    try {
      if (desktopBridge?.saveRecording) {
        let arrayBuffer: ArrayBuffer;
        if (typeof (recordedBlob as any).arrayBuffer === "function") {
          arrayBuffer = await recordedBlob.arrayBuffer();
        } else if (typeof Response !== "undefined") {
          arrayBuffer = await new Response(recordedBlob).arrayBuffer();
        } else {
          arrayBuffer = new Uint8Array(await new Promise<number[]>((res) => {
            const reader = new FileReader();
            reader.onload = () => res(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
            reader.readAsArrayBuffer(recordedBlob);
          })).buffer;
        }
        const res = await desktopBridge.saveRecording({ buffer: new Uint8Array(arrayBuffer), filename });
        if (res?.success) {
          setSaveStatus("saved");
          return;
        }
      }

      const a = document.createElement("a");
      a.href = recordedVideoUrl || URL.createObjectURL(recordedBlob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setSaveStatus("saved");
    } catch (err) {
      console.warn("Could not save recording:", err);
      setSaveStatus("idle");
    }
  };

  const handleCaptureSnapshot = async () => {
    setIsAppMenuOpen(false);
    try {
      let blob: Blob | null = null;
      if (desktopBridge?.capturePage) {
        const res = await desktopBridge.capturePage();
        if (res?.success && res.dataUrl) {
          const raw = atob(res.dataUrl.slice(res.dataUrl.indexOf(",") + 1));
          blob = new Blob([Uint8Array.from(raw, (c) => c.charCodeAt(0))], { type: "image/png" });
        }
      }

      if (!blob) {
        throw new Error("Snapshot capture not supported or returned empty");
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `SpaceApp-Snapshot-${timestamp}.png`;

      if (typeof window !== "undefined" && window.navigator?.clipboard && typeof ClipboardItem !== "undefined") {
        try {
          await window.navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob })
          ]);
        } catch {}
      }

      if (desktopBridge?.saveRecording) {
        let arrayBuffer: ArrayBuffer;
        if (typeof (blob as any).arrayBuffer === "function") {
          arrayBuffer = await blob.arrayBuffer();
        } else if (typeof Response !== "undefined") {
          arrayBuffer = await new Response(blob).arrayBuffer();
        } else {
          arrayBuffer = new Uint8Array(await new Promise<number[]>((res) => {
            const reader = new FileReader();
            reader.onload = () => res(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
            reader.readAsArrayBuffer(blob!);
          })).buffer;
        }
        await desktopBridge.saveRecording({ buffer: new Uint8Array(arrayBuffer), filename });
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      setToastMessage("Snapshot copied to clipboard & saved to Downloads!");
      setTimeout(() => setToastMessage(null), 3500);
    } catch (err) {
      console.warn("Snapshot capture failed:", err);
    }
  };

  const handleDownloadSetup = () => {
    try {
      const isLinux = systemInfo?.platform === "linux";
      const filename = isLinux
        ? `SpaceApp-${targetVersion}.AppImage`
        : `SpaceApp-Setup-${targetVersion}.exe`;
      const a = document.createElement("a");
      a.href = `/api/desktop/download/${filename}`;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.warn("Could not download setup installer:", err);
    }
  };

  const handleStartAutoUpdate = () => {
    setIsAppMenuOpen(false);
    setIsUpdateDialogOpen(true);
    setIsUpdating(false);
    setUpdateStatus("idle");
  };

  const handleOpenDownloads = async () => {
    try {
      if ((desktopBridge as any)?.openDownloadsFolder) {
        await (desktopBridge as any).openDownloadsFolder();
      }
    } catch (err) {
      console.warn("Could not open downloads folder:", err);
    }
  };

  const handleRunInstaller = async () => {
    try {
      if ((desktopBridge as any)?.runInstaller) {
        const res = await (desktopBridge as any).runInstaller({ version: targetVersion });
        if (res?.success) return;
      }
      if (desktopBridge?.installUpdate) {
        await desktopBridge.installUpdate({ version: targetVersion });
      }
    } catch (err) {
      console.warn("Could not run installer:", err);
    }
  };

  const handleOneClickUpdate = async () => {
    setIsUpdating(true);
    // 1. Download directly to user's Downloads folder
    handleDownloadSetup();

    // 2. Also notify desktopBridge if present to initiate background preparation and auto-launch
    if (desktopBridge?.installUpdate) {
      try {
        void desktopBridge.installUpdate({ version: targetVersion });
      } catch (err) {
        console.warn("Desktop bridge installUpdate notice:", err);
      }
    }

    // 3. Set status to installer-ready so the user can choose to run it or open Downloads
    setUpdateStatus("installer-ready");
    setIsUpdating(false);
  };

  return (
    <>
      <header
        className="desktop-window-titlebar"
        role="banner"
        aria-label="Window title bar"
        data-window-maximized={isWindowMaximized ? "true" : "false"}
      >
        <div className="desktop-window-titlebar-left">
          <div className="desktop-window-app-menu-container" ref={menuContainerRef}>
            <button
              type="button"
              className={`desktop-window-titlebar-menu-trigger ${isAppMenuOpen ? "is-active" : ""} ${hasUpdate ? "has-update-pending" : ""}`}
              onClick={() => setIsAppMenuOpen((prev) => !prev)}
              aria-expanded={isAppMenuOpen}
              aria-haspopup="menu"
              title={hasUpdate ? `Update available: v${targetVersion}! Click to update.` : "SpaceApp Menu & Version Details"}
            >
              <img
                src="/brand/spaceapp-dev-icon.svg"
                alt="SpaceApp"
                className="desktop-window-titlebar-icon"
                width={16}
                height={16}
              />
              <span className="desktop-window-titlebar-app-name">SpaceApp</span>
              <span className={`desktop-window-titlebar-version-tag ${hasUpdate ? "is-update-available" : ""}`}>
                v{currentVersion}
                {hasUpdate && (
                  <>
                    <span className="desktop-window-titlebar-update-dot" aria-hidden="true" />
                    <span className="desktop-window-titlebar-update-badge">
                      Update v{targetVersion}!
                    </span>
                  </>
                )}
              </span>
              <ChevronDownIcon />
            </button>

            {isAppMenuOpen && (
              <div className="desktop-window-app-menu" role="menu">
                <div className="desktop-window-app-menu-header">
                  <div className="desktop-window-app-menu-header-brand">
                    <img
                      src="/brand/spaceapp-dev-icon.svg"
                      alt="SpaceApp"
                      width={20}
                      height={20}
                    />
                    <div>
                      <strong>SpaceApp Desktop</strong>
                      <small>{platformLabel} · v{currentVersion}</small>
                    </div>
                  </div>
                </div>

                <div className="desktop-window-app-menu-body">
                  {hasUpdate && (
                    <div className="desktop-window-app-menu-update-card">
                      <div className="desktop-window-app-menu-update-header">
                        <div className="desktop-window-app-menu-update-icon">
                          <Sparkles aria-hidden="true" style={{ width: 14, height: 14, color: "#3fb950" }} />
                        </div>
                        <div>
                          <strong>New Version Available!</strong>
                          <p>SpaceApp v{targetVersion} is ready to install</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="desktop-window-app-menu-update-action"
                        onClick={handleStartAutoUpdate}
                      >
                        <Download aria-hidden="true" style={{ width: 14, height: 14 }} />
                        <span>Update to v{targetVersion} Now</span>
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    className="desktop-window-app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIsAppMenuOpen(false);
                      setIsAboutDialogOpen(true);
                    }}
                  >
                    <CircleHelp aria-hidden="true" style={{ width: 14, height: 14, color: "#58a6ff" }} />
                    <div className="desktop-window-app-menu-item-text">
                      <span>Version & System Info</span>
                      <small>v{currentVersion} · {platformLabel}</small>
                    </div>
                    {hasUpdate && (
                      <span className="desktop-window-menu-item-update-tag">v{targetVersion} available</span>
                    )}
                  </button>

                  <button
                    type="button"
                    className="desktop-window-app-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setIsAppMenuOpen(false);
                      window.dispatchEvent(new CustomEvent("space:desktop:open-displays"));
                    }}
                  >
                    <Monitor aria-hidden="true" style={{ width: 14, height: 14, color: "#3fb950" }} />
                    <div className="desktop-window-app-menu-item-text">
                      <span>Multi-Screen Displays</span>
                      <small>Manage monitors & satellite windows</small>
                    </div>
                  </button>

                  <div className="desktop-window-app-menu-divider" />

                  <button
                    type="button"
                    className="desktop-window-app-menu-item"
                    role="menuitem"
                    onClick={handleToggleFullscreen}
                  >
                    <Maximize2 aria-hidden="true" style={{ width: 14, height: 14 }} />
                    <div className="desktop-window-app-menu-item-text">
                      <span>Full Screen</span>
                      <small>F11</small>
                    </div>
                  </button>

                  {/* Social Media Aspect Ratio Section */}
                  <div className="desktop-window-app-menu-aspect-section">
                    <div className="desktop-window-app-menu-aspect-header">
                      <Crop aria-hidden="true" style={{ width: 13, height: 13, color: "#a371f7" }} />
                      <span>Social Media Aspect Ratio</span>
                      <small>X.com · LinkedIn</small>
                    </div>
                    <div className="desktop-window-aspect-ratio-grid">
                      <button
                        type="button"
                        className={`desktop-window-aspect-ratio-btn ${activeAspectRatio === "16:9" ? "active" : ""}`}
                        title="16:9 Landscape - Optimal for X (Twitter) & LinkedIn Video / Posts"
                        onClick={() => handleSelectAspectRatio("16:9")}
                      >
                        <strong>16:9</strong>
                        <span>Landscape</span>
                      </button>
                      <button
                        type="button"
                        className={`desktop-window-aspect-ratio-btn ${activeAspectRatio === "1:1" ? "active" : ""}`}
                        title="1:1 Square - Universal square format for X & LinkedIn feed posts"
                        onClick={() => handleSelectAspectRatio("1:1")}
                      >
                        <strong>1:1</strong>
                        <span>Square</span>
                      </button>
                      <button
                        type="button"
                        className={`desktop-window-aspect-ratio-btn ${activeAspectRatio === "4:5" ? "active" : ""}`}
                        title="4:5 Portrait - Optimal tall vertical post for LinkedIn & Mobile Feed"
                        onClick={() => handleSelectAspectRatio("4:5")}
                      >
                        <strong>4:5</strong>
                        <span>Portrait</span>
                      </button>
                      <button
                        type="button"
                        className={`desktop-window-aspect-ratio-btn ${activeAspectRatio === "9:16" ? "active" : ""}`}
                        title="9:16 Vertical - Stories, Shorts & Mobile Video"
                        onClick={() => handleSelectAspectRatio("9:16")}
                      >
                        <strong>9:16</strong>
                        <span>Vertical</span>
                      </button>
                      <button
                        type="button"
                        className={`desktop-window-aspect-ratio-btn maximize ${activeAspectRatio === null ? "active" : ""}`}
                        title="Maximize Window - Restore full size"
                        onClick={() => handleSelectAspectRatio("maximize")}
                      >
                        <Maximize2 aria-hidden="true" style={{ width: 11, height: 11 }} />
                        <span>Maximize</span>
                      </button>
                    </div>

                    <div className="desktop-window-aspect-actions">
                      <button
                        type="button"
                        className="desktop-window-aspect-action-btn"
                        onClick={handleCaptureSnapshot}
                        title="Capture clean snapshot of this window as PNG"
                      >
                        <Camera aria-hidden="true" style={{ width: 13, height: 13, color: "#58a6ff" }} />
                        <span>Snapshot Photo</span>
                      </button>
                      <button
                        type="button"
                        className={`desktop-window-aspect-action-btn ${isRecording ? "recording" : ""}`}
                        onClick={() => {
                          setIsAppMenuOpen(false);
                          void handleToggleRecording();
                        }}
                        title={isRecording ? "Stop recording" : "Record video of only this window"}
                      >
                        <Video aria-hidden="true" style={{ width: 13, height: 13, color: isRecording ? "#f85149" : "#3fb950" }} />
                        <span>{isRecording ? "Stop Recording" : "Record Window"}</span>
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="desktop-window-app-menu-item"
                    role="menuitem"
                    onClick={handleReloadWindow}
                  >
                    <RefreshCw aria-hidden="true" style={{ width: 14, height: 14 }} />
                    <div className="desktop-window-app-menu-item-text">
                      <span>Reload Window</span>
                      <small>Ctrl + R</small>
                    </div>
                  </button>

                  <div className="desktop-window-app-menu-divider" />

                  <div className="desktop-window-app-menu-meta">
                    <div className="desktop-window-app-meta-row">
                      <span>Electron</span>
                      <strong>{systemInfo?.electronVersion || "33.2.1"}</strong>
                    </div>
                    <div className="desktop-window-app-meta-row">
                      <span>Database</span>
                      <strong style={{ color: "#3fb950" }}>Embedded PG 17</strong>
                    </div>
                    <div className="desktop-window-app-meta-row">
                      <span>Local API</span>
                      <strong style={{ color: "#3fb950" }}>Port 4911</strong>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {activeRoomName ? (
            <>
              <span className="desktop-window-titlebar-separator">·</span>
              <span className="desktop-window-titlebar-room-name">{activeRoomName}</span>
            </>
          ) : null}

          <DesktopDisplayControls variant="titlebar" activeRoomId={activeRoomId} activePaneId={activePaneId} />

          <button
            type="button"
            className={`desktop-window-record-btn ${isRecording ? "is-recording" : ""}`}
            onClick={() => void handleToggleRecording()}
            title={isRecording ? "Click to stop recording" : "Record window video for X.com / LinkedIn"}
            aria-label={isRecording ? "Stop Recording" : "Record Window"}
          >
            <span className={`desktop-window-record-dot ${isRecording ? "recording-pulse" : ""}`} />
            {isRecording ? (
              <>
                <Square aria-hidden="true" style={{ width: 10, height: 10, fill: "currentColor" }} />
                <span>REC {formatDuration(recordingSeconds)}</span>
              </>
            ) : (
              <>
                <Video aria-hidden="true" style={{ width: 12, height: 12 }} />
                <span>Record Window</span>
              </>
            )}
          </button>
        </div>

        <div className="desktop-window-titlebar-drag-spacer" />

        <div className="desktop-window-titlebar-right">
          <div className="desktop-window-titlebar-wco-spacer" aria-hidden="true" />
        </div>
      </header>

      {/* Auto-Update Dialog */}
      {isUpdateDialogOpen && (
        <div className="desktop-window-about-backdrop" role="dialog" aria-modal="true">
          <div className="desktop-window-update-dialog">
            <div className="desktop-window-about-header">
              <div className="desktop-window-about-title">
                <div className="desktop-window-update-dialog-icon">
                  <Sparkles aria-hidden="true" style={{ width: 20, height: 20, color: "#3fb950" }} />
                </div>
                <div>
                  <h3>Update SpaceApp</h3>
                  <p>Upgrading from v{currentVersion} to v{targetVersion}</p>
                </div>
              </div>
              <button
                type="button"
                className="desktop-window-about-close"
                onClick={() => setIsUpdateDialogOpen(false)}
                aria-label="Close dialog"
              >
                <X aria-hidden="true" style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="desktop-window-update-body">
              <div className="desktop-window-update-single-card">
                <div className="desktop-window-update-card-banner">
                  <div className="desktop-window-update-banner-icon">
                    <Sparkles aria-hidden="true" style={{ width: 22, height: 22, color: "#3fb950" }} />
                  </div>
                  <div>
                    <strong>One-Click Automatic Update</strong>
                    <p>Upgrade SpaceApp to v{targetVersion} automatically with a single click.</p>
                  </div>
                </div>

                <div className="desktop-window-update-instructions">
                  <div className="desktop-window-update-instruction-title">
                    How it works
                  </div>
                  <div className="desktop-window-update-steps">
                    <div className="desktop-window-update-step-item">
                      <span className="desktop-window-update-step-num">1</span>
                      <div className="desktop-window-update-step-content">
                        <strong>Click the Update button below</strong>
                        <p>Initiates the automated update process instantly.</p>
                      </div>
                    </div>
                    <div className="desktop-window-update-step-item">
                      <span className="desktop-window-update-step-num">2</span>
                      <div className="desktop-window-update-step-content">
                        <strong>Automatic background update</strong>
                        <p>SpaceApp downloads the latest update, safely closes the running app, and applies all files.</p>
                      </div>
                    </div>
                    <div className="desktop-window-update-step-item">
                      <span className="desktop-window-update-step-num">3</span>
                      <div className="desktop-window-update-step-content">
                        <strong>Automatic restart</strong>
                        <p>SpaceApp automatically relaunches in seconds running v{targetVersion} with all your data intact.</p>
                      </div>
                    </div>
                  </div>
                </div>

                {updateStatus === "in-progress" && (
                  <div className="desktop-window-update-status-box">
                    <div className="desktop-window-update-status-header">
                      <div className="desktop-window-update-pulse" />
                      <strong>Update in progress...</strong>
                    </div>
                    <p>SpaceApp is updating in the background. The app will close shortly and reopen automatically with v{targetVersion}.</p>
                    <div className="desktop-window-update-progress-bar">
                      <div className="desktop-window-update-progress-fill" />
                    </div>
                  </div>
                )}

                {(updateStatus === "fallback-downloaded" || updateStatus === "installer-ready") && (
                  <div className="desktop-window-update-status-box success">
                    <div className="desktop-window-update-status-header">
                      <Check aria-hidden="true" style={{ width: 16, height: 16, color: "#3fb950" }} />
                      <strong>Setup Installer Ready in Downloads</strong>
                    </div>
                    <p>
                      {systemInfo?.platform === "linux"
                        ? `SpaceApp-${targetVersion}.AppImage was saved to your Downloads folder.`
                        : `SpaceApp-Setup-${targetVersion}.exe was saved to your Downloads folder.`}
                    </p>
                    <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="desktop-window-update-run-btn"
                        onClick={handleRunInstaller}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "6px 12px",
                          background: "#238636",
                          color: "#fff",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer"
                        }}
                      >
                        <Play aria-hidden="true" style={{ width: 13, height: 13 }} />
                        <span>Run Installer Now</span>
                      </button>
                      <button
                        type="button"
                        className="desktop-window-update-open-btn"
                        onClick={handleOpenDownloads}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "6px 12px",
                          background: "rgba(255,255,255,0.08)",
                          color: "#c9d1d9",
                          border: "1px solid rgba(255,255,255,0.15)",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 500,
                          cursor: "pointer"
                        }}
                      >
                        <FolderOpen aria-hidden="true" style={{ width: 13, height: 13 }} />
                        <span>Open Downloads Folder</span>
                      </button>
                    </div>
                    <small style={{ display: "block", marginTop: "8px", color: "#8b949e", fontSize: "11px" }}>
                      Running the installer will automatically close SpaceApp, install v{targetVersion}, and reopen.
                    </small>
                  </div>
                )}

                <button
                  type="button"
                  className="desktop-window-update-action-btn"
                  onClick={handleOneClickUpdate}
                  disabled={isUpdating && updateStatus === "in-progress"}
                >
                  <Sparkles aria-hidden="true" style={{ width: 18, height: 18 }} />
                  <span>
                    {isUpdating && updateStatus === "in-progress"
                      ? "Updating SpaceApp... Please wait"
                      : `⚡ Update & Restart SpaceApp to v${targetVersion} Now`}
                  </span>
                </button>
              </div>
            </div>

            <div className="desktop-window-about-footer">
              <small>Current v{currentVersion} → Latest v{targetVersion}</small>
              <button
                type="button"
                className="desktop-window-about-ok-btn"
                onClick={() => setIsUpdateDialogOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About SpaceApp Specs Dialog */}
      {isAboutDialogOpen && (
        <div className="desktop-window-about-backdrop" role="dialog" aria-modal="true">
          <div className="desktop-window-about-dialog">
            <div className="desktop-window-about-header">
              <div className="desktop-window-about-title">
                <img
                  src="/brand/spaceapp-dev-icon.svg"
                  alt="SpaceApp"
                  width={28}
                  height={28}
                />
                <div>
                  <h3>SpaceApp Native Desktop</h3>
                  <p>Enterprise AI Workspace Platform</p>
                </div>
              </div>
              <button
                type="button"
                className="desktop-window-about-close"
                onClick={() => setIsAboutDialogOpen(false)}
                aria-label="Close dialog"
              >
                <X aria-hidden="true" style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="desktop-window-about-body">
              <div className="desktop-window-about-version-box">
                <div className="desktop-window-about-badge">v{currentVersion}</div>
                <div>
                  <strong>SpaceApp Client Release {currentVersion}</strong>
                  <p>Built for {platformLabel} · Electron {systemInfo?.electronVersion || "33.2.1"}</p>
                </div>
              </div>

              {hasUpdate ? (
                <div className="desktop-window-about-update-banner">
                  <div>
                    <strong>Update Available: v{targetVersion}</strong>
                    <p>A new client release is ready to install.</p>
                  </div>
                  <button
                    type="button"
                    className="desktop-window-app-menu-update-action"
                    onClick={() => {
                      setIsAboutDialogOpen(false);
                      handleStartAutoUpdate();
                    }}
                  >
                    <Download aria-hidden="true" style={{ width: 14, height: 14 }} />
                    <span>Update to v{targetVersion}</span>
                  </button>
                </div>
              ) : (
                <div className="desktop-window-about-latest-banner">
                  <Check aria-hidden="true" style={{ width: 14, height: 14, color: "#3fb950" }} />
                  <span>You are running the latest version of SpaceApp.</span>
                </div>
              )}

              <div className="desktop-window-about-specs">
                <div className="desktop-window-about-spec-item">
                  <span>Architecture</span>
                  <strong>Zero-Docker Native Host</strong>
                </div>
                <div className="desktop-window-about-spec-item">
                  <span>Multi-Screen Engine</span>
                  <strong>3-Display Asymmetrical Layout Support</strong>
                </div>
                <div className="desktop-window-about-spec-item">
                  <span>Local Database</span>
                  <strong>PostgreSQL 17 + pgvector (User-Space)</strong>
                </div>
                <div className="desktop-window-about-spec-item">
                  <span>PTY Host Bridge</span>
                  <strong>ConPTY / WinPTY (Native PowerShell & CMD)</strong>
                </div>
                <div className="desktop-window-about-spec-item">
                  <span>Local Isolation</span>
                  <strong>Loopback Protected (Port 4911)</strong>
                </div>
              </div>
            </div>

            <div className="desktop-window-about-footer">
              <small>© 2026 SpaceApp · oll4com. All rights reserved.</small>
              <button
                type="button"
                className="desktop-window-about-ok-btn"
                onClick={() => setIsAboutDialogOpen(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Window Recording Finished Dialog */}
      {isRecordingDialogOpen && (
        <div className="desktop-window-about-backdrop" role="dialog" aria-modal="true">
          <div className="desktop-window-recording-dialog">
            <div className="desktop-window-about-header">
              <div className="desktop-window-about-title">
                <div className="desktop-window-recording-dialog-icon">
                  <Video aria-hidden="true" style={{ width: 20, height: 20, color: "#f85149" }} />
                </div>
                <div>
                  <h3>Window Recording</h3>
                  <p>Recorded {formatDuration(recordingSeconds)} · Ready for X.com / LinkedIn</p>
                </div>
              </div>
              <button
                type="button"
                className="desktop-window-about-close"
                onClick={() => setIsRecordingDialogOpen(false)}
                aria-label="Close dialog"
              >
                <X aria-hidden="true" style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="desktop-window-recording-body">
              {recordedVideoUrl && (
                <div className="desktop-window-recording-player-wrapper">
                  <video
                    src={recordedVideoUrl}
                    controls
                    autoPlay
                    playsInline
                    className="desktop-window-recording-player"
                  />
                </div>
              )}

              <div className="desktop-window-recording-meta-pills">
                <div className="desktop-window-recording-meta-pill">
                  <span>Duration</span>
                  <strong>{formatDuration(recordingSeconds)}</strong>
                </div>
                <div className="desktop-window-recording-meta-pill">
                  <span>Size</span>
                  <strong>{recordedBlob ? `${(recordedBlob.size / (1024 * 1024)).toFixed(2)} MB` : "—"}</strong>
                </div>
                <div className="desktop-window-recording-meta-pill">
                  <span>Format</span>
                  <strong>WebM (VP9)</strong>
                </div>
                {activeAspectRatio && (
                  <div className="desktop-window-recording-meta-pill">
                    <span>Aspect Ratio</span>
                    <strong>{activeAspectRatio}</strong>
                  </div>
                )}
              </div>

              <div className="desktop-window-recording-actions">
                <button
                  type="button"
                  className="desktop-window-recording-save-btn"
                  onClick={handleSaveRecording}
                >
                  {saveStatus === "saved" ? (
                    <>
                      <Check aria-hidden="true" style={{ width: 15, height: 15 }} />
                      <span>Saved to Downloads</span>
                    </>
                  ) : saveStatus === "saving" ? (
                    <span>Saving...</span>
                  ) : (
                    <>
                      <Download aria-hidden="true" style={{ width: 15, height: 15 }} />
                      <span>Save to Downloads</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="desktop-window-update-open-btn"
                  onClick={handleOpenDownloads}
                >
                  <FolderOpen aria-hidden="true" style={{ width: 14, height: 14 }} />
                  <span>Open Downloads Folder</span>
                </button>
              </div>
            </div>

            <div className="desktop-window-about-footer">
              <small>Saved directly to your Downloads folder for easy social upload.</small>
              <button
                type="button"
                className="desktop-window-about-ok-btn"
                onClick={() => setIsRecordingDialogOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Snapshot Toast */}
      {toastMessage && (
        <div className="desktop-window-snapshot-toast" role="status">
          <Camera aria-hidden="true" style={{ width: 14, height: 14, color: "#3fb950" }} />
          <span>{toastMessage}</span>
        </div>
      )}
    </>
  );
}
