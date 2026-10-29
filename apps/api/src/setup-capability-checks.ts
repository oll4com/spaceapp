import { checkWorkspaceWidgetFunction, codexUsageAccountListSchema, antigravityUsageAccountListSchema,
  apiProviderAccountListSchema, systemHealthSnapshotSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { SetupCapabilityChecks } from "./setup-production-actions.js";
import { listDirectory, WORKSPACE_ROOT } from "./files-service.js";
import { runGit } from "./source-control/git-engine.js";

/** Bounded service reads only. These checks neither open panes nor request credentials. */
export function createSetupCapabilityChecks(options: {
  store: SpaceStore;
  workspaceRoot?: string;
  checkBrowser?: () => Promise<void>;
  checkStreamingMetrics?: () => Promise<void>;
  readQuotaSources?: () => Promise<Array<{ kind: "codex" | "antigravity" | "api"; snapshot: unknown }>>;
  readSystemHealth?: () => Promise<unknown>;
  checkSourceControl: (ownerId: string) => Promise<void>;
}): SetupCapabilityChecks {
  const root = options.workspaceRoot ?? WORKSPACE_ROOT;
  const checkQuota = async () => {
    const sources = await options.readQuotaSources!();
    const schemas = { codex: codexUsageAccountListSchema, antigravity: antigravityUsageAccountListSchema, api: apiProviderAccountListSchema };
    const observed = sources.map(source => schemas[source.kind].safeParse(source.snapshot));
    if (!observed.some(item => item.success && !item.data.isStale && !item.data.error)) throw new Error("The selected quota source is unavailable.");
    // An empty or unreported balance is valid source state; the widget presents it as unavailable.
  };
  return {
    "widget:clock": async (ownerId) => { checkWorkspaceWidgetFunction("clock", (await options.store.getUserSettings(ownerId)).dateTime.timeZone); },
    "widget:countdown-timer": async () => { checkWorkspaceWidgetFunction("countdown-timer", "UTC"); },
    "widget:pushup-reminder": async () => { checkWorkspaceWidgetFunction("pushup-reminder", "UTC"); },
    "widget:spaceapp-promo": async () => { checkWorkspaceWidgetFunction("spaceapp-promo", "UTC"); },
    ...(options.readQuotaSources ? { "widget:ai-quota": checkQuota } : {}),
    ...(options.readSystemHealth ? { "utility:system-health": async () => {
      const snapshot = systemHealthSnapshotSchema.parse(await options.readSystemHealth!());
      if (!["cpu", "memory"].every(group => snapshot.metrics.some(metric => metric.group === group && metric.value !== null))) {
        throw new Error("System health does not report supported CPU and memory metrics.");
      }
    } } : {}),
    "dock:media": async () => { await options.store.listArtifacts({ page: 1, pageSize: 1, sortOrder: "desc" }); },
    "dock:shared-chat": async () => { await options.store.listSharedChatMessages({ limit: 1 }); },
    "pane:files": async () => { await listDirectory({ workspaceRoot: root, targetPath: root, mode: "user" }); },
    "dock:source-control": async (ownerId) => {
      await runGit(root, ["--version"], { timeout: 5_000 });
      await options.checkSourceControl(ownerId);
    },
    ...(options.checkBrowser ? { "pane:browser": options.checkBrowser } : {}),
    ...(options.checkStreamingMetrics ? { "widget:streaming-metrics": options.checkStreamingMetrics } : {})
  };
}
