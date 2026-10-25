import {
  activityLogEventSchema,
  activityLogSettingsSchema,
  type ActivityLogEvent,
  type ActivityLogSettings,
  type ListActivityLogEventsQuery
} from "@space/contracts";
import {
  type ActivityLogEventRecord,
  type ActivityLogRepository
} from "@space/db";

function defaultActivityLogId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID().replaceAll("-", "")}`;
}

export interface ActivityLogServiceOptions {
  repository: ActivityLogRepository;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

export interface RecordActivityLogRoomCreateInput {
  roomId: string;
  actorUserId?: string | null;
  reason?: string | null;
  traceId: string;
  metadata?: Record<string, unknown>;
}

export interface ListActivityLogEventsResult {
  data: ActivityLogEvent[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

function toContractEvent(record: ActivityLogEventRecord): ActivityLogEvent {
  return activityLogEventSchema.parse({
    id: record.id,
    roomId: record.roomId,
    actorUserId: record.actorUserId,
    action: record.action as ActivityLogEvent["action"],
    reason: record.reason,
    traceId: record.traceId,
    metadata: record.metadata,
    createdAt: record.createdAt
  });
}

export class ActivityLogService {
  private readonly repository: ActivityLogRepository;
  private readonly now: () => Date;
  private readonly createId: (prefix: string) => string;

  constructor(options: ActivityLogServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? defaultActivityLogId;
  }

  async isEnabled(): Promise<boolean> {
    return (await this.repository.getSetting()).enabled;
  }

  async getSettings(): Promise<ActivityLogSettings> {
    const setting = await this.repository.getSetting();
    return activityLogSettingsSchema.parse({
      enabled: setting.enabled,
      enabledAt: setting.enabledAt,
      enabledByUserId: setting.enabledByUserId,
      disabledAt: setting.disabledAt,
      disabledByUserId: setting.disabledByUserId,
      updatedAt: setting.updatedAt
    });
  }

  async setEnabled(enabled: boolean, actorUserId: string): Promise<ActivityLogSettings> {
    const at = this.now().toISOString();
    await this.repository.setEnabled({ enabled, actorUserId, at });
    return this.getSettings();
  }

  /**
   * Records a room creation event. When the activity log is disabled (off =
   * no capture), the call is a cheap no-op that returns null.
   */
  async recordRoomCreate(input: RecordActivityLogRoomCreateInput): Promise<ActivityLogEvent | null> {
    const setting = await this.repository.getSetting();
    if (!setting.enabled) return null;
    const record = await this.repository.createEvent({
      id: this.createId("activity_log"),
      roomId: input.roomId,
      actorUserId: input.actorUserId ?? null,
      action: "room.create",
      reason: input.reason?.trim() ? input.reason.trim() : null,
      traceId: input.traceId,
      metadata: input.metadata ?? {},
      createdAt: this.now().toISOString()
    });
    return toContractEvent(record);
  }

  async listEvents(query: ListActivityLogEventsQuery): Promise<ListActivityLogEventsResult> {
    const result = await this.repository.listEvents({
      roomId: query.roomId,
      action: query.action,
      actorUserId: query.actorUserId,
      hasReason: query.hasReason,
      page: query.page,
      pageSize: query.pageSize
    });
    return {
      data: result.items.map(toContractEvent),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / query.pageSize)
      }
    };
  }

  async dispose(): Promise<void> {
    await this.repository.dispose();
  }
}
