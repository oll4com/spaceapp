import type { TelegramIntegrationStatus, TelegramPairingResponse } from "@space/contracts";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCw,
  Send,
  Unplug,
  X
} from "lucide-react";
import type { FormEvent, RefObject } from "react";
import { api } from "../../api.js";
import { resolveExternalResource } from "../../runtime/SpaceRuntime.js";
import {
  useTelegramIntegration,
  type TelegramIntegrationClient,
  type TelegramPendingAction
} from "./use-telegram-integration.js";

const statusPresentation: Record<
  TelegramIntegrationStatus["connectionStatus"],
  { label: string; tone: "ok" | "warn" | "bad" | "muted" }
> = {
  DISCONNECTED: { label: "Disconnected", tone: "muted" },
  PAIRING: { label: "Pairing", tone: "warn" },
  CONNECTED: { label: "Connected", tone: "ok" },
  DISABLED: { label: "Disabled", tone: "warn" },
  ERROR: { label: "Error", tone: "bad" }
};

function connectionSummary(status: TelegramIntegrationStatus | null, loading: boolean): string {
  if (!status) return loading ? "Loading secure integration status" : "Secure integration status unavailable";
  if (status.chatDisplayName) return status.chatDisplayName;
  if (status.botUsername) return `@${status.botUsername}`;
  if (status.connectionStatus === "PAIRING") return "Waiting for a private Telegram chat";
  return "Codex completion notifications";
}

function pairingExpiryLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function TelegramSetupGuide({
  botToken,
  hasPairedBot,
  isBusy,
  pendingAction,
  onTokenChange,
  onSubmit,
  onCancel
}: {
  botToken: string;
  hasPairedBot: boolean;
  isBusy: boolean;
  pendingAction: TelegramPendingAction;
  onTokenChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const botFatherHref = resolveExternalResource("https://t.me/BotFather") ?? "#";
  return (
    <div className="telegram-setup-guide">
      <div className="telegram-setup-step">
        <span aria-hidden="true">1</span>
        <p>Create a dedicated bot, then copy its HTTP API token.</p>
        <a href={botFatherHref} target="_blank" rel="noreferrer" className="compact-action">
          Open BotFather
          <ExternalLink aria-hidden="true" />
        </a>
      </div>
      <form className="telegram-token-form" aria-label="Connect Telegram bot" onSubmit={onSubmit}>
        <label>
          <span>Bot token</span>
          <input
            type="password"
            name="telegram-bot-token"
            aria-label="Telegram bot token"
            autoComplete="off"
            spellCheck={false}
            required
            minLength={20}
            maxLength={256}
            value={botToken}
            onChange={(event) => onTokenChange(event.target.value)}
            disabled={isBusy}
            placeholder="Paste token once"
          />
        </label>
        <small>The token is validated server-side and is never shown again.</small>
        <div className="telegram-action-row">
          <button
            className="compact-action primary-action"
            type="submit"
            disabled={isBusy || !botToken.trim()}
            aria-label={hasPairedBot ? "Submit Telegram reconnect token" : "Connect Telegram bot"}
          >
            {pendingAction === "connect" ? <Loader2 className="telegram-spinner" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            <span>{hasPairedBot ? "Reconnect" : "Connect"}</span>
          </button>
          {hasPairedBot ? (
            <button className="compact-action" type="button" onClick={onCancel} disabled={isBusy}>
              <X aria-hidden="true" />
              <span>Cancel</span>
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function TelegramPairingPanel({
  pairing,
  pairingId,
  pairingExpiresAt,
  isBusy,
  pendingAction,
  onCheck,
  onReconnect
}: {
  pairing: TelegramPairingResponse["pairing"] | null;
  pairingId: string | null;
  pairingExpiresAt: string | null;
  isBusy: boolean;
  pendingAction: TelegramPendingAction;
  onCheck: () => void;
  onReconnect: () => void;
}) {
  const pairingHref = pairing ? resolveExternalResource(pairing.pairingUrl) ?? "#" : null;
  return (
    <div className="telegram-pairing-panel">
      <div>
        <strong>Finish in a private Telegram chat</strong>
        <small>The pairing code is single-use and expires after ten minutes.</small>
      </div>
      {pairingExpiresAt ? (
        <small>
          Expires <time dateTime={pairingExpiresAt}>{pairingExpiryLabel(pairingExpiresAt)}</time>
        </small>
      ) : null}
      {pairing ? (
        <a href={pairingHref ?? "#"} target="_blank" rel="noreferrer" className="compact-action primary-action">
          <Send aria-hidden="true" />
          <span>Open private Telegram pairing</span>
        </a>
      ) : (
        <small>Use the pairing link created in this browser, or reconnect to create a new one.</small>
      )}
      <div className="telegram-action-row">
        <button
          className="compact-action"
          type="button"
          onClick={onCheck}
          disabled={isBusy || !pairingId}
          aria-label="Check Telegram pairing"
        >
          {pendingAction === "check" ? <Loader2 className="telegram-spinner" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          <span>Check pairing</span>
        </button>
        <button
          className="compact-action"
          type="button"
          onClick={onReconnect}
          disabled={isBusy}
          aria-label="Reconnect Telegram bot"
        >
          <RotateCw aria-hidden="true" />
          <span>Reconnect</span>
        </button>
      </div>
    </div>
  );
}

function TelegramConnectedControls({
  status,
  isBusy,
  pendingAction,
  confirmingDisconnect,
  confirmDisconnectRef,
  showReconnect,
  onToggle,
  onTest,
  onReconnect,
  onRequestDisconnect,
  onConfirmDisconnect,
  onCancelDisconnect
}: {
  status: TelegramIntegrationStatus;
  isBusy: boolean;
  pendingAction: TelegramPendingAction;
  confirmingDisconnect: boolean;
  confirmDisconnectRef: RefObject<HTMLButtonElement | null>;
  showReconnect: boolean;
  onToggle: (isEnabled: boolean) => void;
  onTest: () => void;
  onReconnect: () => void;
  onRequestDisconnect: () => void;
  onConfirmDisconnect: () => void;
  onCancelDisconnect: () => void;
}) {
  return (
    <>
      <label className="settings-toggle-row telegram-enable-toggle">
        <input
          type="checkbox"
          name="telegram-completion-notifications"
          checked={status.isEnabled}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={isBusy}
          aria-label="Enable completion notifications"
        />
        <span>Enable completion notifications</span>
      </label>
      <div className="telegram-action-row">
        <button className="compact-action" type="button" onClick={onTest} disabled={isBusy} aria-label="Send Telegram test message">
          {pendingAction === "test" ? <Loader2 className="telegram-spinner" aria-hidden="true" /> : <Send aria-hidden="true" />}
          <span>Send test</span>
        </button>
        {showReconnect ? (
          <button className="compact-action" type="button" onClick={onReconnect} disabled={isBusy} aria-label="Reconnect Telegram bot">
            <RotateCw aria-hidden="true" />
            <span>Reconnect</span>
          </button>
        ) : null}
        <button
          className="compact-action telegram-danger-action"
          type="button"
          onClick={onRequestDisconnect}
          disabled={isBusy || confirmingDisconnect}
          aria-label="Disconnect Telegram"
        >
          <Unplug aria-hidden="true" />
          <span>Disconnect</span>
        </button>
      </div>
      {confirmingDisconnect ? (
        <div className="telegram-disconnect-confirmation" role="alertdialog" aria-label="Confirm Telegram disconnect">
          <p>Disconnecting deletes the bot credential and cancels pending Telegram deliveries.</p>
          <div className="telegram-action-row">
            <button
              ref={confirmDisconnectRef}
              className="compact-action telegram-danger-action"
              type="button"
              onClick={onConfirmDisconnect}
              disabled={isBusy}
              aria-label="Confirm Telegram disconnect"
            >
              {pendingAction === "disconnect" ? <Loader2 className="telegram-spinner" aria-hidden="true" /> : <Unplug aria-hidden="true" />}
              <span>Disconnect</span>
            </button>
            <button className="compact-action" type="button" onClick={onCancelDisconnect} disabled={isBusy}>
              <X aria-hidden="true" />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function TelegramIntegrationCard({
  canManage,
  client = api
}: {
  canManage: boolean;
  client?: TelegramIntegrationClient;
}) {
  const integration = useTelegramIntegration(client);
  const { status, pairing, pendingAction } = integration;
  const isBusy = pendingAction !== null;
  const isDisconnected = status?.connectionStatus === "DISCONNECTED";
  const hasPendingPairing = Boolean(
    status?.connectionStatus === "PAIRING" || pairing || status?.pairingId
  );
  const hasPairedBot = Boolean(
    status?.botUsername && status.connectionStatus !== "DISCONNECTED" && status.connectionStatus !== "PAIRING"
  );
  const presentation = status ? statusPresentation[status.connectionStatus] : null;
  const pairingExpiresAt = pairing?.expiresAt ?? status?.pairingExpiresAt ?? null;

  return (
    <section className="agent-settings-card telegram-integration-card" aria-label="Telegram notifications">
      <div className="agent-settings-section-title telegram-integration-title">
        <Bot aria-hidden="true" />
        <span>
          <strong>Telegram notifications</strong>
          <small>{connectionSummary(status, pendingAction === "load")}</small>
        </span>
        <button
          className="icon-action"
          type="button"
          onClick={() => void integration.loadStatus()}
          disabled={isBusy}
          title="Refresh Telegram status"
          aria-label="Refresh Telegram status"
        >
          {pendingAction === "load" ? <Loader2 className="telegram-spinner" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
        </button>
      </div>

      <div className="telegram-status-panel" role="status" aria-live="polite">
        <div>
          <span className={`status ${presentation?.tone ?? "muted"}`}>
            {presentation?.label ?? (pendingAction === "load" ? "Loading" : "Unavailable")}
          </span>
          {status?.botUsername ? <strong>@{status.botUsername}</strong> : <strong>Space bot</strong>}
        </div>
        <small>{status?.chatDisplayName ?? "One global private Telegram destination."}</small>
      </div>

      {status?.connectionStatus === "ERROR" && status.errorCode ? (
        <div className="validation-result bad" role="status">
          <strong>{status.errorCode}</strong>
          <small>Delivery is paused until the integration is reconnected or repaired.</small>
        </div>
      ) : null}
      {integration.actionError ? (
        <div className="validation-result bad" role="alert">
          <strong>TELEGRAM_INTEGRATION_ERROR</strong>
          <small>{integration.actionError}</small>
        </div>
      ) : null}
      <div className="telegram-feedback" role="status" aria-live="polite">{integration.feedback}</div>

      {!canManage ? <p className="telegram-admin-note">Admin access is required to change this integration.</p> : null}
      {canManage && (isDisconnected || integration.showTokenForm) ? (
        <TelegramSetupGuide
          botToken={integration.botToken}
          hasPairedBot={hasPairedBot}
          isBusy={isBusy}
          pendingAction={pendingAction}
          onTokenChange={integration.setBotToken}
          onSubmit={(event) => void integration.connectBot(event)}
          onCancel={() => integration.setShowTokenForm(false)}
        />
      ) : null}
      {canManage && hasPendingPairing ? (
        <TelegramPairingPanel
          pairing={pairing}
          pairingId={pairing?.id ?? status?.pairingId ?? null}
          pairingExpiresAt={pairingExpiresAt}
          isBusy={isBusy}
          pendingAction={pendingAction}
          onCheck={() => void integration.checkPairing()}
          onReconnect={() => integration.setShowTokenForm(true)}
        />
      ) : null}
      {canManage && hasPairedBot && status ? (
        <TelegramConnectedControls
          status={status}
          isBusy={isBusy}
          pendingAction={pendingAction}
          confirmingDisconnect={integration.confirmingDisconnect}
          confirmDisconnectRef={integration.confirmDisconnectRef}
          showReconnect={!hasPendingPairing}
          onToggle={(isEnabled) => void integration.toggleEnabled(isEnabled)}
          onTest={() => void integration.sendTest()}
          onReconnect={() => integration.setShowTokenForm(true)}
          onRequestDisconnect={() => integration.setConfirmingDisconnect(true)}
          onConfirmDisconnect={() => void integration.disconnect()}
          onCancelDisconnect={() => integration.setConfirmingDisconnect(false)}
        />
      ) : null}
    </section>
  );
}
