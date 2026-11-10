import { InMemorySpaceStore } from "@space/runtime";
import { describe, expect, it } from "vitest";
import { ActivityLogService } from "../src/activity-log.js";
import { AppDiagnosticsService } from "../src/app-diagnostics.js";
import { createDefaultActivityLogService, createDefaultAppDiagnosticsService, createDefaultStore } from "../src/default-app-services.js";

const memoryConfig = { runtimeStore: "memory", codexLbConfigured: false, codexLbBaseUrl: null } as any;

describe("default app services", () => {
  it("builds in-memory services when the store is not PostgreSQL", async () => {
    const store = createDefaultStore(memoryConfig);
    expect(store).toBeInstanceOf(InMemorySpaceStore);
    expect(createDefaultActivityLogService(memoryConfig, store)).toBeInstanceOf(ActivityLogService);
    const diagnostics = createDefaultAppDiagnosticsService(memoryConfig, store);
    expect(diagnostics).toBeInstanceOf(AppDiagnosticsService);
    await diagnostics.dispose();
  });

  it("refuses a PostgreSQL store without a database URL", () => {
    expect(() => createDefaultStore({ ...memoryConfig, runtimeStore: "postgres", databaseUrl: undefined }))
      .toThrow("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
  });
});
