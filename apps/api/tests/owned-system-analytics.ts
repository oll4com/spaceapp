import { InMemorySystemAnalyticsRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { SystemAnalyticsService } from "../src/system-analytics-service.js";

/** Keep route fixtures independent of the host's private CLI history and processes. */
export function ownedSystemAnalytics(store: SpaceStore, root: string): SystemAnalyticsService {
  return new SystemAnalyticsService({
    store,
    repository: new InMemorySystemAnalyticsRepository(),
    codexHome: root,
    stateRoot: root,
    hermesHome: root,
    liveSessions: async () => [],
    readProcessTable: async () => [],
    readMeminfo: async () => "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n",
    readProcStat: async () => "cpu 0 0 0 100 0 0 0 0 0 0\n",
    coreCount: 1
  });
}
