import { Globe2, Keyboard, Loader2, Lock, Maximize2, Monitor, Unplug } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Pane, VncPreset } from "@space/contracts";
import { api } from "../../api.js";
import RFB from "@novnc/novnc";

interface VncPaneProps {
  pane: Pane;
  observerOnly?: boolean;
}

type VncConnectionState = "idle" | "connecting" | "connected" | "error" | "closed";

export function VncPane({ pane, observerOnly = false }: VncPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const pendingTargetRef = useRef<{ host: string; port: number; password?: string } | null>(null);
  const [presets, setPresets] = useState<VncPreset[]>([]);
  const [dialogOpen, setDialogOpen] = useState(!pane.vncTarget);
  const [presetId, setPresetId] = useState(pane.vncTarget?.presetId ?? "");
  const [host, setHost] = useState(pane.vncTarget?.host ?? "");
  const [port, setPort] = useState(pane.vncTarget?.port ? String(pane.vncTarget.port) : "5900");
  const [password, setPassword] = useState(pane.vncTarget?.password ?? "");
  const [remember, setRemember] = useState(Boolean(pane.vncTarget));
  const [state, setState] = useState<VncConnectionState>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [desktopName, setDesktopName] = useState<string | null>(null);

  useEffect(() => {
    void api
      .vncPresets()
      .then((response) => setPresets(response.presets))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (state !== "idle" || observerOnly || !pane.vncTarget) return;
    pendingTargetRef.current = {
      host: pane.vncTarget.host,
      port: pane.vncTarget.port,
      password: pane.vncTarget.password ?? undefined
    };
    setState("connecting");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.vncTarget, state, observerOnly]);

  useEffect(() => {
    if (state !== "connecting" || dialogOpen) return;
    const target = pendingTargetRef.current;
    const container = containerRef.current;
    if (!target || !container) return;
    pendingTargetRef.current = null;
    setStatusMessage(null);
    setDesktopName(null);
    const url = api.vncStreamWebSocketUrl(pane.id, target.host, target.port);
    const rfb = new RFB(container, url, {
      credentials: target.password ? { password: target.password } : undefined
    });
    rfb.viewOnly = observerOnly;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = true;
    rfb.addEventListener("connect", () => {
      setState("connected");
      setStatusMessage(null);
    });
    rfb.addEventListener("disconnect", (event) => {
      setState("closed");
      setStatusMessage(event.detail.message || (event.detail.clean ? "Disconnected." : "Connection closed."));
      rfbRef.current = null;
    });
    rfb.addEventListener("credentialsrequired", () => {
      setState("error");
      setStatusMessage("Password required. Reconnect with the VNC password.");
    });
    rfb.addEventListener("securityfailure", (event) => {
      setState("error");
      setStatusMessage(event.detail.reason || "VNC security failure.");
    });
    rfb.addEventListener("desktopname", (event) => setDesktopName(event.detail.name));
    rfbRef.current = rfb;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, dialogOpen]);

  useEffect(
    () => () => {
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    },
    []
  );

  function handleConnectSubmit(event: FormEvent) {
    event.preventDefault();
    const targetHost = host.trim();
    const targetPort = Number(port);
    if (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) return;
    pendingTargetRef.current = { host: targetHost, port: targetPort, password: password || undefined };
    setState("connecting");
    setDialogOpen(false);
    if (remember) {
      void api
        .updatePane(pane.id, {
          vncTarget: { presetId: presetId || null, host: targetHost, port: targetPort, password: password || null }
        })
        .catch(() => undefined);
    } else if (pane.vncTarget) {
      void api.updatePane(pane.id, { vncTarget: null }).catch(() => undefined);
    }
  }

  function handleDisconnect() {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setState("closed");
    setStatusMessage("Disconnected.");
  }

  function handleFullscreen() {
    rfbRef.current?.requestFullscreen();
  }

  function applyPreset(id: string) {
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) return;
    setPresetId(preset.id);
    setHost(preset.host);
    setPort(String(preset.port));
  }

  return (
    <div className="vnc-pane">
      <div className="vnc-pane-toolbar">
        <span className="vnc-pane-status" data-state={state}>
          {state === "connected"
            ? desktopName || "Connected"
            : state === "connecting"
              ? "Connecting..."
              : state === "error"
                ? "Error"
                : state === "closed"
                  ? "Disconnected"
                  : "Idle"}
        </span>
        <div className="vnc-pane-actions">
          <button type="button" title="Connect to a VNC server" aria-label="Connect to a VNC server" onClick={() => setDialogOpen(true)} disabled={state === "connecting"}>
            <Globe2 aria-hidden="true" />
            <span>Connect</span>
          </button>
          <button type="button" title="Disconnect" aria-label="Disconnect" onClick={handleDisconnect} disabled={!rfbRef.current}>
            <Unplug aria-hidden="true" />
          </button>
          <button type="button" title="Fullscreen" aria-label="Fullscreen" onClick={handleFullscreen} disabled={state !== "connected"}>
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
      </div>
      {statusMessage ? (
        <div className="vnc-pane-notice" role="status">
          <span>{statusMessage}</span>
          {state === "error" ? (
            <button type="button" className="vnc-pane-notice-close" aria-label="Dismiss message" onClick={() => setStatusMessage(null)}>
              ×
            </button>
          ) : null}
        </div>
      ) : null}
      {dialogOpen ? (
        <form className="vnc-connect-dialog" onSubmit={handleConnectSubmit}>
          <div className="vnc-connect-head">
            <Monitor aria-hidden="true" />
            <strong>VNC connection</strong>
          </div>
          {presets.length > 0 ? (
            <label className="vnc-connect-field">
              <span>Preset</span>
              <select value={presetId} onChange={(event) => applyPreset(event.target.value)}>
                <option value="">Custom…</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="vnc-connect-field">
            <span>Host</span>
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.0.2.20" autoComplete="off" required />
          </label>
          <label className="vnc-connect-field">
            <span>Port</span>
            <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="5900" required />
          </label>
          <label className="vnc-connect-field">
            <span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
          </label>
          <label className="vnc-connect-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            <span>Remember this target</span>
          </label>
          <div className="vnc-connect-actions">
            <button type="submit" disabled={state === "connecting"}>
              {state === "connecting" ? <Loader2 className="spin" aria-hidden="true" /> : <Lock aria-hidden="true" />}
              <span>Connect</span>
            </button>
            <button type="button" onClick={() => setDialogOpen(false)} className="vnc-connect-cancel">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="vnc-pane-screen" ref={containerRef} />
      )}
      {observerOnly ? <div className="vnc-pane-observer-note">Observer mode — input is disabled.</div> : null}
      <div className="vnc-pane-hint">
        <Keyboard aria-hidden="true" />
        <span>Click the screen to capture keyboard input.</span>
      </div>
    </div>
  );
}