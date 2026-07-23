import { randomBytes } from "node:crypto";
import {
  cliRuntimeDisablePreviewSchema,
  cliToggleRuntimeIdSchema,
  eventSchema,
  updateCliRuntimeSettingResultSchema,
  type CliRuntimeDisablePreview,
  type CliToggleRuntimeId,
  type Event,
  type UpdateCliRuntimeSettingResult
} from "@space/contracts";
import {
  SpaceFeatureDisabledError,
  makeSpaceId,
  nowIso,
  type SpaceStore
} from "@space/runtime";

interface CliRuntimeImpact {
  sessionIds: string[];
  paneIds: string[];
}

interface DisableConfirmation extends CliRuntimeImpact {
  runtimeId: CliToggleRuntimeId;
  expiresAtMs: number;
}

export interface CliRuntimeVisibilityPolicyOptions {
  store: SpaceStore;
  terminateSession: (sessionId: string) => Promise<boolean>;
  publishEvent?: (event: Event) => void;
  now?: () => number;
  confirmationTtlMs?: number;
}

const defaultConfirmationTtlMs = 2 * 60 * 1000;

function sameIdentities(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((identity, index) => identity === right[index]);
}

export class CliRuntimeDisableConfirmationStaleError extends Error {
  readonly errorCode = "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE";

  constructor(public readonly preview: CliRuntimeDisablePreview) {
    super("CLI runtime disable confirmation is stale or expired. Review the current impact and confirm again.");
    this.name = "CliRuntimeDisableConfirmationStaleError";
  }
}

export class CliRuntimeVisibilityPolicy {
  private readonly confirmations = new Map<string, DisableConfirmation>();
  private readonly now: () => number;
  private readonly confirmationTtlMs: number;

  constructor(private readonly options: CliRuntimeVisibilityPolicyOptions) {
    this.now = options.now ?? Date.now;
    this.confirmationTtlMs = options.confirmationTtlMs ?? defaultConfirmationTtlMs;
  }

  async enabledRuntimeIds(): Promise<CliToggleRuntimeId[]> {
    return (await this.options.store.listCliRuntimeSettings())
      .filter((setting) => setting.enabled)
      .map((setting) => setting.runtimeId);
  }

  async isEnabled(runtimeId: string): Promise<boolean> {
    const parsed = cliToggleRuntimeIdSchema.safeParse(runtimeId);
    if (!parsed.success) return true;
    return (await this.options.store.getCliRuntimeSetting(parsed.data)).enabled;
  }

  async assertEnabled(runtimeId: string): Promise<void> {
    const parsed = cliToggleRuntimeIdSchema.safeParse(runtimeId);
    if (!parsed.success || await this.isEnabled(parsed.data)) return;
    throw new SpaceFeatureDisabledError(
      "CLI_RUNTIME_DISABLED",
      `${parsed.data} is disabled by the global CLI runtime policy.`,
      { runtimeId: parsed.data }
    );
  }

  async createDisablePreview(runtimeId: CliToggleRuntimeId): Promise<CliRuntimeDisablePreview> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    this.deleteExpiredConfirmations();
    const impact = await this.collectImpact(parsedRuntimeId);
    return this.issuePreview(parsedRuntimeId, impact);
  }

  async enable(runtimeId: CliToggleRuntimeId, updatedBy: string, traceId: string): Promise<UpdateCliRuntimeSettingResult> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const setting = await this.options.store.updateCliRuntimeSetting(parsedRuntimeId, { enabled: true }, updatedBy);
    this.publishVisibilityEvent(parsedRuntimeId, true, traceId, null);
    return updateCliRuntimeSettingResultSchema.parse({ setting, cleanup: null });
  }

  async disable(
    runtimeId: CliToggleRuntimeId,
    confirmationToken: string,
    updatedBy: string,
    traceId: string
  ): Promise<UpdateCliRuntimeSettingResult> {
    const parsedRuntimeId = cliToggleRuntimeIdSchema.parse(runtimeId);
    const confirmation = this.confirmations.get(confirmationToken);
    this.confirmations.delete(confirmationToken);

    const impact = await this.collectImpact(parsedRuntimeId);
    if (
      !confirmation ||
      confirmation.runtimeId !== parsedRuntimeId ||
      confirmation.expiresAtMs < this.now() ||
      !sameIdentities(confirmation.sessionIds, impact.sessionIds) ||
      !sameIdentities(confirmation.paneIds, impact.paneIds)
    ) {
      throw new CliRuntimeDisableConfirmationStaleError(this.issuePreview(parsedRuntimeId, impact));
    }

    const setting = await this.options.store.updateCliRuntimeSetting(
      parsedRuntimeId,
      { enabled: false, confirmationToken },
      updatedBy
    );

    const terminatedSessionIds: string[] = [];
    const unresolvedSessionIds: string[] = [];
    for (const sessionId of impact.sessionIds) {
      try {
        const terminated = await this.options.terminateSession(sessionId);
        if (!terminated) {
          unresolvedSessionIds.push(sessionId);
          continue;
        }
        await this.options.store.updatePaneCliSession(
          sessionId,
          {
            status: "EXITED",
            statusReason: `CLI runtime ${parsedRuntimeId} disabled by an administrator.`,
            exitCode: null,
            isActive: false,
            endedAt: nowIso()
          },
          traceId
        );
        terminatedSessionIds.push(sessionId);
      } catch {
        unresolvedSessionIds.push(sessionId);
      }
    }

    const closedPaneIds: string[] = [];
    const unresolvedPaneIds: string[] = [];
    for (const paneId of impact.paneIds) {
      try {
        const pane = await this.options.store.updatePane(
          paneId,
          { isClosed: true, status: "CLOSED" },
          traceId
        );
        closedPaneIds.push(paneId);
        const paneEvent = await this.options.store.getLatestEvent(pane.roomId);
        if (paneEvent) this.options.publishEvent?.(paneEvent);
      } catch {
        unresolvedPaneIds.push(paneId);
      }
    }

    const cleanup = {
      requestedActiveSessionCount: impact.sessionIds.length,
      requestedOpenPaneCount: impact.paneIds.length,
      terminatedSessionIds,
      closedPaneIds,
      unresolvedSessionIds,
      unresolvedPaneIds
    };
    this.publishVisibilityEvent(parsedRuntimeId, false, traceId, cleanup);
    return updateCliRuntimeSettingResultSchema.parse({ setting, cleanup });
  }

  private async collectImpact(runtimeId: CliToggleRuntimeId): Promise<CliRuntimeImpact> {
    const rooms = await this.options.store.listRooms();
    const panes = (await Promise.all(rooms.map((room) => this.options.store.listPanes(room.id, true)))).flat();
    const paneIds = panes
      .filter((pane) => pane.mode === "TERMINAL" && pane.terminalRuntimeId === runtimeId && !pane.isClosed)
      .map((pane) => pane.id)
      .sort();
    const sessions = await Promise.all(
      panes
        .filter((pane) => pane.mode === "TERMINAL")
        .map((pane) => this.options.store.getActivePaneCliSession(pane.id))
    );
    const sessionIds = sessions
      .filter((session) =>
        session?.runtimeId === runtimeId &&
        session.isActive &&
        session.status !== "EXITED" &&
        session.status !== "ERROR"
      )
      .map((session) => session!.sessionId)
      .sort();
    return {
      sessionIds: [...new Set(sessionIds)],
      paneIds: [...new Set(paneIds)]
    };
  }

  private issuePreview(runtimeId: CliToggleRuntimeId, impact: CliRuntimeImpact): CliRuntimeDisablePreview {
    const confirmationToken = randomBytes(24).toString("base64url");
    const expiresAtMs = this.now() + this.confirmationTtlMs;
    this.confirmations.set(confirmationToken, { runtimeId, ...impact, expiresAtMs });
    return cliRuntimeDisablePreviewSchema.parse({
      runtimeId,
      activeSessionCount: impact.sessionIds.length,
      openPaneCount: impact.paneIds.length,
      confirmationToken,
      expiresAt: new Date(expiresAtMs).toISOString()
    });
  }

  private deleteExpiredConfirmations(): void {
    const nowMs = this.now();
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.expiresAtMs < nowMs) this.confirmations.delete(token);
    }
  }

  private publishVisibilityEvent(
    runtimeId: CliToggleRuntimeId,
    enabled: boolean,
    traceId: string,
    cleanup: UpdateCliRuntimeSettingResult["cleanup"]
  ): void {
    this.options.publishEvent?.(eventSchema.parse({
      id: makeSpaceId("event"),
      roomId: null,
      paneId: null,
      turnId: null,
      workflowId: null,
      traceId,
      type: "CAPABILITY_STATUS_CHANGED",
      message: `${runtimeId} ${enabled ? "enabled" : "disabled"}.`,
      payload: { capability: "cli-runtime", runtimeId, enabled, cleanup },
      createdAt: nowIso()
    }));
  }
}
