import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceFeatureDisabledError } from "@space/runtime";
import type { CodexConfiguredModel } from "@space/codex-app-server";
import {
  createCodexCliModeDefaultsService,
  type CodexCliModeDefaultsControl
} from "../src/codex-cli-mode-defaults.js";
import { createApp } from "../src/app.js";

function model(id: string, defaultReasoningEffort = "high", efforts = ["medium", "high", "xhigh"]) {
  return {
    id,
    displayName: id,
    isDefault: id === "gpt-catalog-default",
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts,
    reasoningOptions: efforts.map((reasoningEffort) => ({ reasoningEffort }))
  };
}

function control(configured: CodexConfiguredModel | null = { model: "gpt-configured", reasoningEffort: "xhigh" }) {
  const calls = { listModels: 0, readConfiguredModel: 0 };
  const runtimeControl: CodexCliModeDefaultsControl & { configured: CodexConfiguredModel | null; offline: boolean } = {
    configured,
    offline: false,
    async listModels() {
      calls.listModels += 1;
      if (runtimeControl.offline) throw new Error("catalog offline");
      return [model("gpt-other", "low"), model("gpt-catalog-default", "medium"), model("gpt-configured")];
    },
    async readConfiguredModel() {
      calls.readConfiguredModel += 1;
      if (runtimeControl.offline || !runtimeControl.configured) throw new Error("config offline");
      return runtimeControl.configured;
    }
  };
  return { runtimeControl, calls };
}

describe("Codex CLI defaults service", () => {
  it("starts fresh Codex sessions on the model and effort Codex's own configuration names", async () => {
    const { runtimeControl } = control();
    const service = createCodexCliModeDefaultsService({ control: runtimeControl });

    await expect(service.build()).resolves.toEqual({ modelId: "gpt-configured", reasoningEffort: "xhigh" });
    await expect(service.read()).resolves.toMatchObject({
      defaults: { build: { modelId: "gpt-configured", reasoningEffort: "xhigh" } },
      catalog: { status: "AVAILABLE", error: null }
    });
  });

  it("fills what the configuration leaves unset the way Codex does", async () => {
    const effortOnly = createCodexCliModeDefaultsService({
      control: control({ model: null, reasoningEffort: "high" }).runtimeControl
    });
    const modelOnly = createCodexCliModeDefaultsService({
      control: control({ model: "gpt-configured", reasoningEffort: null }).runtimeControl
    });
    const unreadable = createCodexCliModeDefaultsService({ control: control(null).runtimeControl });

    await expect(effortOnly.build()).resolves.toEqual({ modelId: "gpt-catalog-default", reasoningEffort: "high" });
    await expect(modelOnly.build()).resolves.toEqual({ modelId: "gpt-configured", reasoningEffort: "high" });
    await expect(unreadable.build()).resolves.toEqual({ modelId: "gpt-catalog-default", reasoningEffort: "medium" });
  });

  it("does not invent an effort for a configured model the catalog does not describe", async () => {
    const service = createCodexCliModeDefaultsService({
      control: control({ model: "gpt-private", reasoningEffort: null }).runtimeControl
    });

    await expect(service.build()).rejects.toMatchObject({ errorCode: "CLI_CODEX_DEFAULTS_UNRESOLVED" });
  });

  it("follows a changed Codex configuration after the refresh interval and keeps its last answer during an outage", async () => {
    let now = 0;
    const { runtimeControl, calls } = control();
    const service = createCodexCliModeDefaultsService({ control: runtimeControl, refreshIntervalMs: 1000, now: () => now });

    await service.build();
    runtimeControl.configured = { model: "gpt-other", reasoningEffort: "low" };
    await expect(service.build()).resolves.toEqual({ modelId: "gpt-configured", reasoningEffort: "xhigh" });
    expect(calls.readConfiguredModel).toBe(1);

    now = 1000;
    await expect(service.build()).resolves.toEqual({ modelId: "gpt-other", reasoningEffort: "low" });

    now = 2000;
    runtimeControl.offline = true;
    await expect(service.build()).resolves.toEqual({ modelId: "gpt-other", reasoningEffort: "low" });
    await expect(service.read()).resolves.toMatchObject({ catalog: { status: "UNAVAILABLE", models: [] } });
  });

  it("shares one Codex lookup between concurrent launches", async () => {
    const { runtimeControl, calls } = control();
    const service = createCodexCliModeDefaultsService({ control: runtimeControl });

    await Promise.all([service.build(), service.build(), service.build()]);

    expect(calls).toEqual({ listModels: 1, readConfiguredModel: 1 });
  });

  it("fails closed until Codex answers for the first time", async () => {
    const { runtimeControl } = control();
    runtimeControl.offline = true;
    const service = createCodexCliModeDefaultsService({ control: runtimeControl });

    await expect(service.build()).rejects.toBeInstanceOf(SpaceFeatureDisabledError);
    runtimeControl.offline = false;
    await expect(service.build()).resolves.toEqual({ modelId: "gpt-configured", reasoningEffort: "xhigh" });
    await expect(createCodexCliModeDefaultsService({ control: null }).build())
      .rejects.toMatchObject({ errorCode: "CLI_CODEX_DEFAULTS_UNRESOLVED" });
  });

  it("serves Codex's own defaults read-only and keeps no Space-wide override", async () => {
    const store = new InMemorySpaceStore();
    store.initializeCodexCliModeDefaults({
      build: { modelId: "gpt-other", reasoningEffort: "low" },
      plan: { modelId: "gpt-other", reasoningEffort: "low" }
    });
    const app = await createApp({
      store,
      codexCliModeDefaultsService: createCodexCliModeDefaultsService({ control: control().runtimeControl }),
      auth: {
        sessionSecret: "test-secret-with-enough-length",
        devLogin: true,
        secureCookies: false
      }
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "space@space.local", password: "space-dev" }
      });
      const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
      const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
      const headers = { cookie, "x-space-csrf-token": csrf.json().csrfToken as string };

      const current = await app.inject({ method: "GET", url: "/api/cli/codex-defaults", headers: { cookie } });
      const update = await app.inject({
        method: "PATCH",
        url: "/api/cli/codex-defaults",
        headers,
        payload: { mode: "plan", modelId: "gpt-other", reasoningEffort: "low" }
      });

      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        defaults: { build: { modelId: "gpt-configured", reasoningEffort: "xhigh" } },
        catalog: { status: "AVAILABLE" }
      });
      expect(current.json().defaults).not.toHaveProperty("plan");
      expect(update.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
