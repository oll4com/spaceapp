import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TelegramIntegrationStatus, TelegramPairingResponse } from "@space/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramIntegrationCard } from "../src/features/telegram-integration/TelegramIntegrationCard.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const syntheticToken = "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE";

function telegramStatus(
  connectionStatus: TelegramIntegrationStatus["connectionStatus"],
  overrides: Partial<TelegramIntegrationStatus> = {}
): TelegramIntegrationStatus {
  const connected = connectionStatus === "CONNECTED" || connectionStatus === "DISABLED" || connectionStatus === "ERROR";
  return {
    connectionStatus,
    isEnabled: connectionStatus === "CONNECTED",
    botUsername: connected || connectionStatus === "PAIRING" ? "space_test_bot" : null,
    chatDisplayName: connected ? "Space operator (@operator)" : null,
    pairingId: connectionStatus === "PAIRING" ? "telegram_pairing:test" : null,
    pairingExpiresAt: connectionStatus === "PAIRING" ? "2026-07-14T12:10:00.000Z" : null,
    pairedAt: connected ? "2026-07-14T12:02:00.000Z" : null,
    enabledAt: connectionStatus === "CONNECTED" ? "2026-07-14T12:02:00.000Z" : null,
    disabledAt: connectionStatus === "DISABLED" ? "2026-07-14T12:04:00.000Z" : null,
    lastTestedAt: connected ? "2026-07-14T12:02:00.000Z" : null,
    lastDeliveredAt: null,
    errorCode: connectionStatus === "ERROR" ? "TELEGRAM_TOKEN_REJECTED" : null,
    errorAt: connectionStatus === "ERROR" ? "2026-07-14T12:05:00.000Z" : null,
    updatedAt: "2026-07-14T12:05:00.000Z",
    ...overrides
  };
}

function createClient(initialStatus: TelegramIntegrationStatus) {
  return {
    telegramIntegration: vi.fn(async () => initialStatus),
    createTelegramPairing: vi.fn(async (_botToken: string): Promise<TelegramPairingResponse> => {
      throw new Error("Pairing response not configured");
    }),
    checkTelegramPairing: vi.fn(async (_pairingId: string) => initialStatus),
    sendTelegramTestDelivery: vi.fn(async () => initialStatus),
    updateTelegramIntegration: vi.fn(async (_input: { isEnabled: boolean }) => initialStatus),
    disconnectTelegramIntegration: vi.fn(async () => initialStatus)
  };
}

function runTelegramAction(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Telegram notification actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("TelegramIntegrationCard", () => {
  beforeEach(() => installSpaceRuntime(liveRuntime));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps completion setup visible but OFF and blocks every mutation", async () => {
    const client = createClient(telegramStatus("DISCONNECTED"));

    render(<TelegramIntegrationCard canManage client={client} isCodexEnabled={false} />);

    const card = await screen.findByLabelText("Telegram notifications");
    expect(within(card).getByText("OFF")).toBeTruthy();
    expect((within(card).getByLabelText("Telegram bot token") as HTMLInputElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Connect Telegram bot" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card).getByRole("button", { name: "Telegram notification actions" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByRole("link", { name: "Open BotFather" }).getAttribute("aria-disabled")).toBe("true");

    fireEvent.submit(within(card).getByRole("form", { name: "Connect Telegram bot" }));
    expect(client.createTelegramPairing).not.toHaveBeenCalled();
  });

  it("connects, pairs, tests, toggles, reconnects and confirms disconnect without retaining the token", async () => {
    const disconnected = telegramStatus("DISCONNECTED");
    const pairingStatus = telegramStatus("PAIRING");
    const connected = telegramStatus("CONNECTED");
    const disabled = telegramStatus("DISABLED");
    const pairingResponse: TelegramPairingResponse = {
      integration: pairingStatus,
      pairing: {
        id: "telegram_pairing:test",
        pairingUrl: "https://t.me/space_test_bot?start=pairing-code",
        expiresAt: "2026-07-14T12:10:00.000Z",
        statusCode: "PAIRING_PENDING"
      }
    };
    const client = createClient(disconnected);
    client.createTelegramPairing.mockResolvedValue(pairingResponse);
    client.checkTelegramPairing.mockResolvedValue(connected);
    client.sendTelegramTestDelivery.mockResolvedValue(connected);
    client.updateTelegramIntegration.mockResolvedValue(disabled);
    client.disconnectTelegramIntegration.mockResolvedValue(disconnected);

    render(<TelegramIntegrationCard canManage client={client} />);

    const card = await screen.findByLabelText("Telegram notifications");
    expect(within(card).getByText("Disconnected")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open BotFather" }).getAttribute("href")).toBe("https://t.me/BotFather");
    const tokenInput = within(card).getByLabelText("Telegram bot token") as HTMLInputElement;
    expect(tokenInput.type).toBe("password");

    fireEvent.change(tokenInput, { target: { value: syntheticToken } });
    fireEvent.submit(within(card).getByRole("form", { name: "Connect Telegram bot" }));

    await waitFor(() => expect(client.createTelegramPairing).toHaveBeenCalledWith(syntheticToken));
    const pairingLink = await within(card).findByRole("link", { name: "Open private Telegram pairing" });
    expect(pairingLink.getAttribute("href")).toBe("https://t.me/space_test_bot?start=pairing-code");
    expect(within(card).queryByDisplayValue(syntheticToken)).toBeNull();

    runTelegramAction("Check pairing");
    await waitFor(() => expect(client.checkTelegramPairing).toHaveBeenCalledWith("telegram_pairing:test"));
    expect(await within(card).findByText("Connected")).toBeTruthy();
    expect(within(card).getAllByText("Space operator (@operator)")).toHaveLength(2);

    runTelegramAction("Send test message");
    await waitFor(() => expect(client.sendTelegramTestDelivery).toHaveBeenCalledTimes(1));

    fireEvent.click(within(card).getByLabelText("Enable completion notifications"));
    await waitFor(() => expect(client.updateTelegramIntegration).toHaveBeenCalledWith({ isEnabled: false }));
    expect(await within(card).findByText("Disabled", { selector: ".status" })).toBeTruthy();

    runTelegramAction("Reconnect bot");
    expect((within(card).getByLabelText("Telegram bot token") as HTMLInputElement).value).toBe("");

    runTelegramAction("Disconnect Telegram");
    const confirmDisconnect = within(card).getByRole("button", { name: "Confirm Telegram disconnect" });
    await waitFor(() => expect(document.activeElement).toBe(confirmDisconnect));
    fireEvent.click(confirmDisconnect);
    await waitFor(() => expect(client.disconnectTelegramIntegration).toHaveBeenCalledTimes(1));
    expect(await within(card).findByText("Disconnected")).toBeTruthy();
  });

  it("shows safe error status to operators while keeping all mutations admin-only", async () => {
    const client = createClient(telegramStatus("ERROR"));

    render(<TelegramIntegrationCard canManage={false} client={client} />);

    const card = await screen.findByLabelText("Telegram notifications");
    expect(within(card).getByText("Error")).toBeTruthy();
    expect(within(card).getByText("TELEGRAM_TOKEN_REJECTED")).toBeTruthy();
    expect(within(card).getByText("Admin access is required to change this integration.")).toBeTruthy();
    expect(within(card).queryByLabelText("Telegram bot token")).toBeNull();
    expect((within(card).getByRole("button", { name: "Telegram notification actions" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(card).getByRole("button", { name: "Telegram notification actions" }));
    expect(screen.getByRole("menuitem", { name: "Refresh status" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Send test message" })).toBeNull();
  });

  it("keeps reconnect pairing controls visible while the previous bot remains connected", async () => {
    const connected = telegramStatus("CONNECTED");
    const reconnecting = telegramStatus("CONNECTED", {
      pairingId: "telegram_pairing:rotation",
      pairingExpiresAt: "2026-07-14T12:15:00.000Z"
    });
    const client = createClient(connected);
    client.telegramIntegration
      .mockResolvedValueOnce(connected)
      .mockResolvedValue(reconnecting);
    client.createTelegramPairing.mockResolvedValue({
      integration: reconnecting,
      pairing: {
        id: "telegram_pairing:rotation",
        pairingUrl: "https://t.me/space_test_bot?start=rotation-code",
        expiresAt: "2026-07-14T12:15:00.000Z",
        statusCode: "PAIRING_PENDING"
      }
    });
    client.checkTelegramPairing.mockResolvedValue(reconnecting);

    render(<TelegramIntegrationCard canManage client={client} />);

    const card = await screen.findByLabelText("Telegram notifications");
    runTelegramAction("Reconnect bot");
    fireEvent.change(within(card).getByLabelText("Telegram bot token"), { target: { value: syntheticToken } });
    fireEvent.submit(within(card).getByRole("form", { name: "Connect Telegram bot" }));

    const pairingLink = await within(card).findByRole("link", { name: "Open private Telegram pairing" });
    expect(pairingLink.getAttribute("href")).toBe("https://t.me/space_test_bot?start=rotation-code");
    fireEvent.click(within(card).getByRole("button", { name: "Telegram notification actions" }));
    expect(screen.getByRole("menuitem", { name: "Check pairing" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Send test message" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem", { name: "Reconnect bot" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("menuitem", { name: "Check pairing" }));
    await waitFor(() => expect(client.checkTelegramPairing).toHaveBeenCalledWith("telegram_pairing:rotation"));
    expect(within(card).getByText("Pairing is still waiting for the private Telegram chat.")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open private Telegram pairing" })).toBeTruthy();

    runTelegramAction("Refresh status");
    await waitFor(() => expect(client.telegramIntegration).toHaveBeenCalledTimes(2));
    expect(within(card).getByRole("link", { name: "Open private Telegram pairing" })).toBeTruthy();
  });

  it("announces status load failures and recovers through the refresh action", async () => {
    const client = createClient(telegramStatus("DISCONNECTED"));
    client.telegramIntegration
      .mockRejectedValueOnce(new Error("Status unavailable"))
      .mockResolvedValueOnce(telegramStatus("DISCONNECTED"));

    render(<TelegramIntegrationCard canManage client={client} />);

    expect((await screen.findByRole("alert")).textContent).toContain("Status unavailable");
    const liveRegion = screen.getByLabelText("Telegram notifications").querySelector("[aria-live='polite']");
    expect(liveRegion).toBeTruthy();

    runTelegramAction("Refresh status");

    expect(await screen.findByText("Disconnected")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
