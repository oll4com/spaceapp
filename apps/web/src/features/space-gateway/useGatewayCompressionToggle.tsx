import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GatewayCompressionMode, GatewaySettings } from "@space/contracts";
import { api } from "../../api.js";
import { ConfirmationDialog } from "../toolbar-metrics/MetricLayers.js";
import { announceGatewaySettings, GATEWAY_SETTINGS_EVENT } from "./gateway-settings-events.js";

export interface GatewayCompressionClient {
  settings(): Promise<GatewaySettings>;
  update(mode: GatewayCompressionMode): Promise<GatewaySettings>;
}

const defaultClient: GatewayCompressionClient = {
  settings: () => api.gatewaySettings(),
  update: (mode) => api.updateGatewaySettings({ compressionMode: mode })
};

/** What turning compression on or off changes, shown before the change is made. */
function ConfirmationCopy({ next }: { next: GatewayCompressionMode }) {
  return next === "ON" ? (
    <>
      <p>Space Gateway will compress tool output (logs, JSON, search results, diffs, source code and prose) before it
        reaches Claude, Codex and the other providers.</p>
      <ul>
        <li>Fewer input tokens: less cost and more room in account quotas (often half or more of large tool output).</li>
        <li>File reads and your own messages are never changed; tool output is compressed the same way on every turn, so
          the provider's prompt cache keeps hitting.</li>
        <li>A model may occasionally miss a detail that compression shortened; error lines in logs and the failures,
          assertions and counts of a test run are kept.</li>
      </ul>
      <p>It applies at once to new requests of every provider that follows the global setting; a provider with its own
        setting (Compression tab, By provider) keeps it.</p>
    </>
  ) : (
    <>
      <p>Space Gateway will send every request to the providers unchanged.</p>
      <ul>
        <li>Models see all tool output in full.</li>
        <li>More input tokens: higher cost, and account quotas run out sooner.</li>
        <li>Requests in progress finish as they started.</li>
      </ul>
      <p>It applies at once to new requests of every provider that follows the global setting; a provider with its own
        setting (Compression tab, By provider) keeps it.</p>
    </>
  );
}

/**
 * The Space Gateway compression quick toggle (ADMIN): the current mode, and a confirmation that explains what turning it
 * on or off changes before it is changed.
 */
export function useGatewayCompressionToggle(input: { enabled: boolean; client?: GatewayCompressionClient }): {
  mode: GatewayCompressionMode | null;
  pending: boolean;
  request: () => void;
  dialog: ReactNode;
} {
  const client = input.client ?? defaultClient;
  const [mode, setMode] = useState<GatewayCompressionMode | null>(null);
  const [confirming, setConfirming] = useState<GatewayCompressionMode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!input.enabled) {
      setMode(null);
      return undefined;
    }
    let cancelled = false;
    // A response without settings (an older API or a test fixture) leaves the toggle unset instead of throwing.
    client.settings().then((settings) => { if (!cancelled && settings?.compressionMode) setMode(settings.compressionMode); }, () => undefined);
    const onChange = (event: Event) => {
      const settings = (event as CustomEvent<GatewaySettings>).detail;
      if (settings?.compressionMode) setMode(settings.compressionMode);
    };
    window.addEventListener(GATEWAY_SETTINGS_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(GATEWAY_SETTINGS_EVENT, onChange);
    };
    // The client is fixed for the hook's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.enabled]);

  const request = useCallback(() => {
    if (pending || mode === null) return;
    setError(null);
    setConfirming(mode === "ON" ? "OFF" : "ON");
  }, [mode, pending]);

  async function confirm() {
    if (!confirming) return;
    setPending(true);
    try {
      const settings = await client.update(confirming);
      setMode(settings.compressionMode);
      announceGatewaySettings(settings);
      setConfirming(null);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "The compression setting could not be changed.");
    } finally {
      setPending(false);
    }
  }

  const dialog = confirming ? (
    <ConfirmationDialog
      busy={pending}
      label={confirming === "ON" ? "Turn on context compression?" : "Turn off context compression?"}
      confirmLabel={confirming === "ON" ? "Turn on compression" : "Turn off compression"}
      onCancel={() => { if (!pending) setConfirming(null); }}
      onConfirm={() => void confirm()}
    >
      <ConfirmationCopy next={confirming} />
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  ) : null;

  return { mode, pending, request, dialog };
}
