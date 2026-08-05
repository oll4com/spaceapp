import type {
  TelegramIntegrationStatus,
  TelegramPairingResponse,
  UpdateTelegramIntegrationInput
} from "@space/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEMO_LOCAL_REPLY, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";

export interface TelegramIntegrationClient {
  telegramIntegration(): Promise<TelegramIntegrationStatus>;
  createTelegramPairing(botToken: string): Promise<TelegramPairingResponse>;
  checkTelegramPairing(pairingId: string): Promise<TelegramIntegrationStatus>;
  sendTelegramTestDelivery(): Promise<TelegramIntegrationStatus>;
  updateTelegramIntegration(input: UpdateTelegramIntegrationInput): Promise<TelegramIntegrationStatus>;
  disconnectTelegramIntegration(): Promise<TelegramIntegrationStatus>;
}

export type TelegramPendingAction = "load" | "connect" | "check" | "test" | "toggle" | "disconnect" | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useTelegramIntegration(client: TelegramIntegrationClient) {
  const feedbackFor = (liveMessage: string) => getSpaceRuntimeKind() === "demo" ? DEMO_LOCAL_REPLY : liveMessage;
  const [status, setStatus] = useState<TelegramIntegrationStatus | null>(null);
  const [pairing, setPairing] = useState<TelegramPairingResponse["pairing"] | null>(null);
  const [botToken, setBotToken] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [pendingAction, setPendingAction] = useState<TelegramPendingAction>("load");
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const confirmDisconnectRef = useRef<HTMLButtonElement>(null);

  useAutoDismiss(actionError, setActionError);
  useAutoDismiss(feedback, setFeedback);

  async function loadStatus() {
    setPendingAction("load");
    setActionError(null);
    try {
      const nextStatus = await client.telegramIntegration();
      setStatus(nextStatus);
      setPairing((currentPairing) =>
        currentPairing?.id === nextStatus.pairingId ? currentPairing : null
      );
      if (nextStatus.connectionStatus === "DISCONNECTED") setShowTokenForm(true);
    } catch (error) {
      setActionError(errorMessage(error, "Telegram status failed to load"));
    } finally {
      setPendingAction(null);
    }
  }

  useEffect(() => {
    void loadStatus();
    // The injected client is stable in production and intentionally not a reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (confirmingDisconnect) confirmDisconnectRef.current?.focus();
  }, [confirmingDisconnect]);

  async function connectBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedToken = botToken.trim();
    if (!submittedToken) return;
    setBotToken("");
    setPendingAction("connect");
    setActionError(null);
    setFeedback("");
    try {
      const result = await client.createTelegramPairing(submittedToken);
      setStatus(result.integration);
      setPairing(result.pairing);
      setShowTokenForm(false);
      setFeedback(feedbackFor("Bot validated. Open the private pairing link, then check pairing."));
    } catch (error) {
      setActionError(errorMessage(error, "Telegram bot connection failed"));
    } finally {
      setPendingAction(null);
    }
  }

  async function checkPairing() {
    const pairingId = pairing?.id ?? status?.pairingId;
    if (!pairingId) return;
    setPendingAction("check");
    setActionError(null);
    setFeedback("");
    try {
      const nextStatus = await client.checkTelegramPairing(pairingId);
      setStatus(nextStatus);
      if (nextStatus.connectionStatus === "CONNECTED" && !nextStatus.pairingId) {
        setPairing(null);
        setFeedback(feedbackFor("Pairing confirmed. The automatic Telegram test message was sent."));
      } else {
        setFeedback(feedbackFor("Pairing is still waiting for the private Telegram chat."));
      }
    } catch (error) {
      setActionError(errorMessage(error, "Telegram pairing check failed"));
    } finally {
      setPendingAction(null);
    }
  }

  async function sendTest() {
    setPendingAction("test");
    setActionError(null);
    setFeedback("");
    try {
      setStatus(await client.sendTelegramTestDelivery());
      setFeedback(feedbackFor("Telegram test message sent."));
    } catch (error) {
      setActionError(errorMessage(error, "Telegram test message failed"));
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleEnabled(isEnabled: boolean) {
    setPendingAction("toggle");
    setActionError(null);
    setFeedback("");
    try {
      setStatus(await client.updateTelegramIntegration({ isEnabled }));
      setFeedback(feedbackFor(isEnabled ? "Completion notifications enabled." : "Completion notifications disabled."));
    } catch (error) {
      setActionError(errorMessage(error, "Telegram notification setting failed"));
    } finally {
      setPendingAction(null);
    }
  }

  async function disconnect() {
    setPendingAction("disconnect");
    setActionError(null);
    setFeedback("");
    try {
      const nextStatus = await client.disconnectTelegramIntegration();
      const disconnected = nextStatus.connectionStatus === "DISCONNECTED";
      setStatus(nextStatus);
      if (disconnected) setPairing(null);
      setShowTokenForm(disconnected);
      setConfirmingDisconnect(false);
      setFeedback(feedbackFor("Telegram disconnected. Pending deliveries were cancelled."));
    } catch (error) {
      setActionError(errorMessage(error, "Telegram disconnect failed"));
    } finally {
      setPendingAction(null);
    }
  }

  return {
    status,
    pairing,
    botToken,
    setBotToken,
    showTokenForm,
    setShowTokenForm,
    pendingAction,
    actionError,
    feedback,
    dismissActionError: () => setActionError(null),
    dismissFeedback: () => setFeedback(""),
    confirmingDisconnect,
    setConfirmingDisconnect,
    confirmDisconnectRef,
    loadStatus,
    connectBot,
    checkPairing,
    sendTest,
    toggleEnabled,
    disconnect
  };
}
