import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryTaskTitleRepository } from "@space/db";
import {
  taskTitleSettingsSchema,
  type CodexUsageAccountList,
} from "@space/contracts";
import { getApiConfig } from "../src/config.js";
import {
  generateNativeOpenCodeTitle,
  resolveNativeOpenCodeRuntime,
  nativeOpenCodeModelCatalog,
} from "../src/task-title-opencode.js";
import { TaskTitleProviders, TitleProviderFailure } from "../src/task-title-providers.js";
import { OpenCodeTitleModelRetired } from "../src/task-title-opencode.js";

vi.mock("../src/task-title-opencode.js", () => ({
  OpenCodeTitleModelRetired: class OpenCodeTitleModelRetired extends Error {},
  resolveNativeOpenCodeRuntime: vi.fn(async () => process.execPath),
  nativeOpenCodeModelCatalog: vi.fn(async () => ({
    providers: [
      {
        id: "opencode",
        models: { "standalone-free": { cost: { input: 0, output: 0 } } },
      },
    ],
  })),
  generateNativeOpenCodeTitle: vi.fn(
    async () =>
      '{"title":"Task title","description":"Task details","steps":[]}',
  ),
}));
vi.mock("@space/opencode-control", () => ({
  resolveOpenCodeTitleFallbackControl: async () => ({
    serverPort: 4096,
    serverHost: "localhost",
    serverUsername: "test",
    serverPassword: "test",
  }),
  openCodeServerBaseUrl: () => "http://localhost:4096",
}));
function fixture({
  remaining = 80,
  stale = false,
  trustedGateway = true,
  keyFile = "/test-only/subscription-key",
  freeModelStatePath = "/test-only/missing-free-model-state.json",
  models,
}: {
  remaining?: number | null;
  stale?: boolean;
  trustedGateway?: boolean;
  keyFile?: string;
  freeModelStatePath?: string;
  models?: Record<string, unknown>;
} = {}) {
  const repository = new InMemoryTaskTitleRepository();
  const store = new InMemorySpaceStore();
  vi.spyOn(store, "listProviders").mockReturnValue([
    {
      id: "codex-lb",
      type: "CODEX_LB",
      status: "VERIFIED",
      baseUrl: "https://subscription.invalid/v1/",
    },
  ] as any);
  vi.spyOn(store, "listModels").mockReturnValue([
    {
      id: "mini",
      providerId: "codex-lb",
      status: "VERIFIED",
      runtimeId: "mini",
      displayName: "Mini",
    },
  ] as any);
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/config/providers"))
      return Response.json({
        providers: [
          {
            id: "opencode",
            models: models ?? {
              "free-flash": { cost: { input: 0, output: 0 } },
              "paid-model": { cost: { input: 1, output: 1 } },
              "missing-price": {},
              "old-free": {
                cost: { input: 0, output: 0 },
                status: "deprecated",
              },
            },
          },
          {
            id: "unverified-provider",
            models: { "free-claim": { cost: { input: 0, output: 0 } } },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            content:
              '{"title":"Task title","description":"Task details","steps":[]}',
          },
        },
      ],
    });
  });
  const usage = async () =>
    ({
      data: [
        {
          id: "account",
          fiveHourRemainingPercent: remaining,
          weeklyRemainingPercent: remaining,
        },
      ],
      isStale: stale,
    }) as CodexUsageAccountList;
  const service = new TaskTitleProviders({
    store,
    repository,
    config: getApiConfig(trustedGateway ? {
      SPACE_CODEX_LB_BASE_URL: "https://subscription.invalid/v1",
      SPACE_CODEX_LB_KEY_FILE: keyFile,
      SPACE_CODEX_LB_KEY_NAME: "space-title-test",
    } : {}),
    opencodeCommand: process.execPath,
    usage,
    fetchImpl: fetchImpl as typeof fetch,
    freeModelStatePath,
  });
  return { service, repository, fetchImpl };
}
describe("economical title model routing", () => {
  it("does not trust a catalog's subscription label without the configured dedicated gateway", async () => {
    const f = fixture({ trustedGateway: false });
    await f.service.refresh();
    expect((await f.service.eligible(taskTitleSettingsSchema.parse({}), null)).every(c => c.billing === "free")).toBe(true);
  });
  it("uses a native metadata catalog when no running server is available", async () => {
    const f = fixture();
    f.fetchImpl.mockRejectedValueOnce(Error("No server"));
    await f.service.refresh();
    expect(nativeOpenCodeModelCatalog).toHaveBeenCalled();
    expect(
      (await f.service.eligible(taskTitleSettingsSchema.parse({}), null))[0]
        ?.modelId,
    ).toBe("standalone-free");
  });
  it("excludes native generations when the runtime controls are not verified", async () => {
    vi.mocked(resolveNativeOpenCodeRuntime).mockResolvedValueOnce(null);
    const f = fixture();
    await f.service.refresh();
    expect(
      (await f.service.eligible(taskTitleSettingsSchema.parse({}), null)).every(
        (c) => c.billing === "subscription",
      ),
    ).toBe(true);
  });
  it("discovers metadata without prompts and excludes paid, deprecated and unknown-cost routes", async () => {
    const f = fixture();
    await f.service.refresh();
    await f.service.refresh();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      (await f.service.eligible(taskTitleSettingsSchema.parse({}), null)).map(
        (c) => c.modelId,
      ),
    ).toEqual(["free-flash", "mini"]);
  });
  it("uses one bounded text call with no tools and records successful availability", async () => {
    const f = fixture();
    await f.service.refresh();
    const candidate = (
      await f.service.eligible(taskTitleSettingsSchema.parse({}), null)
    )[0]!;
    await candidate.generate(
      "Summarize menu repair",
      AbortSignal.timeout(1000),
    );
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(generateNativeOpenCodeTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        modelId: "free-flash",
        prompt: "Summarize menu repair",
      }),
    );
    expect((await f.service.status())[0]?.availability).toBe("available");
  });
  it.each([{ remaining: null }, { remaining: 10 }, { stale: true }])(
    "excludes subscription routes with unknown, exhausted or stale quota (%j)",
    async (input) => {
      const f = fixture(input);
      await f.service.refresh();
      expect(
        (
          await f.service.eligible(taskTitleSettingsSchema.parse({}), null)
        ).every((c) => c.billing === "free"),
      ).toBe(true);
    },
  );
  it("honors provider cooldowns, subscription allowlists and global provider exclusions", async () => {
    const f = fixture();
    await f.service.refresh();
    await f.repository.cooldown(
      "provider:opencode",
      new Date(Date.now() + 60000).toISOString(),
    );
    expect(
      (await f.service.eligible(taskTitleSettingsSchema.parse({}), null)).map(
        (c) => c.modelId,
      ),
    ).toEqual(["mini"]);
    expect(
      await f.service.eligible(
        taskTitleSettingsSchema.parse({ subscriptionProviderIds: ["another"] }),
        null,
      ),
    ).toEqual([]);
    expect(
      await f.service.eligible(
        taskTitleSettingsSchema.parse({ allowedProviderIds: ["opencode"] }),
        null,
      ),
    ).toEqual([]);
  });
  it("prefers the picker-verified free model and sends screenshots to a model that can see them", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-picker-"));
    try {
      const freeModelStatePath = join(root, "state.json");
      await writeFile(freeModelStatePath, JSON.stringify({ healthy: true, rawModelId: "big-pickle" }));
      const free = { cost: { input: 0, output: 0 } };
      const f = fixture({
        freeModelStatePath,
        models: {
          "free-flash": free,
          "big-pickle": free,
          "vision-free": { ...free, capabilities: { attachment: true, input: { text: true, image: true } } },
          "text-only-free": { ...free, capabilities: { attachment: false, input: { text: true, image: false } } },
        },
      });
      await f.service.refresh();
      const policy = taskTitleSettingsSchema.parse({});
      expect((await f.service.eligible(policy, null))[0]?.modelId).toBe("big-pickle");
      const withImages = await f.service.eligible(policy, null, { images: true });
      expect(withImages.map((c) => [c.modelId, c.vision])).toEqual([
        ["vision-free", true],
        ["mini", true],
        ["big-pickle", false],
        ["free-flash", false],
        ["text-only-free", false],
      ]);
      await withImages[0]!.generate("Name the task", AbortSignal.timeout(1000), ["/uploads/shot.png"]);
      expect(generateNativeOpenCodeTitle).toHaveBeenLastCalledWith(
        expect.objectContaining({ modelId: "vision-free", images: ["/uploads/shot.png"] }),
      );
      await withImages[2]!.generate("Name the task", AbortSignal.timeout(1000), ["/uploads/shot.png"]);
      expect(generateNativeOpenCodeTitle).toHaveBeenLastCalledWith(
        expect.objectContaining({ modelId: "big-pickle", images: undefined }),
      );
      expect((await f.service.status()).some((c) => "pickerVerified" in c)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("attaches screenshots to the subscription gateway as input images", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-gateway-"));
    try {
      const keyFile = join(root, "key"), image = join(root, "shot.png");
      await writeFile(keyFile, "secret-test-key\n");
      await writeFile(image, "png-bytes");
      vi.mocked(resolveNativeOpenCodeRuntime).mockResolvedValueOnce(null);
      const f = fixture({ keyFile });
      await f.service.refresh();
      const [gateway] = await f.service.eligible(taskTitleSettingsSchema.parse({}), null, { images: true });
      expect(gateway?.billing).toBe("subscription");
      await gateway!.generate("Name the task", AbortSignal.timeout(1000), [image]);
      const body = JSON.parse(String(f.fetchImpl.mock.calls.at(-1)?.[1]?.body));
      expect(body.input[1].content).toEqual([
        { type: "input_text", text: "Name the task" },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` },
      ]);
      expect(body.tools).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rests a free model the service has retired for a day", async () => {
    const f = fixture();
    await f.service.refresh();
    const [free] = await f.service.eligible(taskTitleSettingsSchema.parse({}), null);
    vi.mocked(generateNativeOpenCodeTitle).mockRejectedValueOnce(new OpenCodeTitleModelRetired());
    const failure = await free!.generate("Name the task", AbortSignal.timeout(1000)).catch((error) => error);
    expect(failure).toBeInstanceOf(TitleProviderFailure);
    expect([failure.status, failure.retryAfterSeconds]).toEqual([410, 86_400]);
  });
});
