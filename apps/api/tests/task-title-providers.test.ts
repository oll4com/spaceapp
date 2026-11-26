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
import { TaskTitleProviders } from "../src/task-title-providers.js";
import type { CliMoveRunner } from "../src/chess/chess-cli.js";

function fixture({
  remaining = 80,
  stale = false,
  trustedGateway = true,
  keyFile = "/test-only/subscription-key",
  runClaude,
}: {
  remaining?: number | null;
  stale?: boolean;
  trustedGateway?: boolean;
  keyFile?: string;
  runClaude?: CliMoveRunner;
} = {}) {
  const repository = new InMemoryTaskTitleRepository();
  const store = new InMemorySpaceStore();
  vi.spyOn(store, "listProviders").mockReturnValue([
    { id: "codex-lb", type: "CODEX_LB", status: "VERIFIED", baseUrl: "https://subscription.invalid/v1/" },
  ] as any);
  // Only Codex's cheap model names tasks; the others on the same gateway are never asked.
  vi.spyOn(store, "listModels").mockReturnValue(
    ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"].map((id) => ({ id, providerId: "codex-lb", status: "VERIFIED", runtimeId: id, displayName: id })) as any,
  );
  const fetchImpl = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(async () =>
    Response.json({ output_text: '{"title":"Task title","summary":"Task details"}' }),
  );
  const usage = async () =>
    ({
      data: [{ id: "account", fiveHourRemainingPercent: remaining, weeklyRemainingPercent: remaining }],
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
    usage,
    fetchImpl: fetchImpl as typeof fetch,
    runClaude,
  });
  return { service, repository, fetchImpl };
}
const gemini = ["gemini-3.5-flash-lite", "gemini-3.8-flash-tiered", "gemini-3-flash"];
const ids = async (f: ReturnType<typeof fixture>, policy = taskTitleSettingsSchema.parse({})) =>
  (await f.service.eligible(policy, null)).map((c) => c.modelId);

describe("cheap main-provider title models (operator 22/11: no free models)", () => {
  it("asks only Claude Haiku, Codex Luna and Antigravity Gemini Flash, cheapest first, never a free model", async () => {
    const f = fixture({ runClaude: vi.fn() });
    await f.service.refresh();
    await f.service.refresh();
    const all = await f.service.eligible(taskTitleSettingsSchema.parse({}), null);
    expect(new Set(all.map((c) => c.modelId))).toEqual(new Set([...gemini, "gpt-5.6-luna", "claude-haiku-5-5"]));
    expect(all.every((c) => c.billing === "subscription")).toBe(true);
    expect(all.some((c) => /^(opencode|gateway:pool):/.test(c.id))).toBe(false);
    // Metadata only: discovery sends no prompt.
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it("offers nothing without the configured dedicated gateway or a Claude worker", async () => {
    const f = fixture({ trustedGateway: false });
    await f.service.refresh();
    expect(await ids(f)).toEqual([]);
  });
  it.each([{ remaining: null }, { remaining: 10 }, { stale: true }])(
    "drops Codex with unknown, exhausted or stale quota but keeps the others (%j)",
    async (input) => {
      const f = fixture(input);
      await f.service.refresh();
      expect(new Set(await ids(f))).toEqual(new Set(gemini));
    },
  );
  it("honors provider cooldowns, subscription allowlists and provider exclusions", async () => {
    const f = fixture();
    await f.service.refresh();
    await f.repository.cooldown("provider:gateway-antigravity", new Date(Date.now() + 60000).toISOString());
    expect(await ids(f)).toEqual(["gpt-5.6-luna"]);
    expect(await ids(f, taskTitleSettingsSchema.parse({ subscriptionProviderIds: ["another"] }))).toEqual([]);
    expect(await ids(f, taskTitleSettingsSchema.parse({ allowedProviderIds: ["codex-lb"] }))).toEqual(["gpt-5.6-luna"]);
  });
  it("attaches screenshots to Codex as input images and names the gateway row", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-gateway-"));
    try {
      const keyFile = join(root, "key"), image = join(root, "shot.png");
      await writeFile(keyFile, "secret-test-key\n");
      await writeFile(image, "png-bytes");
      const f = fixture({ keyFile });
      await f.service.refresh();
      const [codex] = await f.service.eligible(taskTitleSettingsSchema.parse({}), null, { images: true });
      expect(codex?.modelId).toBe("gpt-5.6-luna");
      await codex!.generate("Name the task", AbortSignal.timeout(1000), [image]);
      const body = JSON.parse(String(f.fetchImpl.mock.calls.at(-1)?.[1]?.body));
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.input[1].content).toEqual([
        { type: "input_text", text: "Name the task" },
        { type: "input_image", image_url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` },
      ]);
      expect(body.tools).toEqual([]);
      expect(new Headers(f.fetchImpl.mock.calls.at(-1)?.[1]?.headers).get("x-request-id")).toBeNull();
      await codex!.generate("Name the task", AbortSignal.timeout(1000), undefined, "cli:codex:default:task-1");
      expect(new Headers(f.fetchImpl.mock.calls.at(-1)?.[1]?.headers).get("x-request-id")).toBe("cli:codex:default:task-1");
      expect((await f.service.status()).find((c) => c.modelId === "gpt-5.6-luna")?.availability).toBe("available");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("asks Antigravity Gemini through the gateway with the dedicated key", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-gemini-"));
    try {
      const keyFile = join(root, "key");
      await writeFile(keyFile, "secret-test-key\n");
      const f = fixture({ keyFile });
      await f.service.refresh();
      const all = await f.service.eligible(taskTitleSettingsSchema.parse({}), null);
      const flash = all.find((c) => c.id === "gateway:antigravity:gemini-3.8-flash-tiered")!;
      f.fetchImpl.mockResolvedValueOnce(Response.json({ text: '{"title":"T"}' }));
      expect(await flash.generate("Name the task", AbortSignal.timeout(1000), undefined, "cli:codex:default:task-1")).toBe('{"title":"T"}');
      const [url, init] = f.fetchImpl.mock.calls.at(-1)!;
      expect(String(url)).toBe("https://subscription.invalid/gemini/v1/generate");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-test-key");
      expect(JSON.parse(String(init?.body))).toEqual({ model: "gemini-3.8-flash-tiered", prompt: expect.stringMatching(/^You name tasks[\s\S]*Name the task$/) });
      f.fetchImpl.mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "60" } }));
      const failure = await flash.generate("Name the task", AbortSignal.timeout(1000)).catch((error) => error);
      expect([failure.status, failure.retryAfterSeconds]).toEqual([429, 60]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("runs Claude Haiku as headless Claude Code on the gateway profile", async () => {
    const runClaude = vi.fn(async () => '{"title":"T","summary":"S"}');
    const f = fixture({ trustedGateway: false, runClaude });
    await f.service.refresh();
    const [haiku] = await f.service.eligible(taskTitleSettingsSchema.parse({}), null);
    expect(haiku?.id).toBe("claude:claude-haiku-5-5");
    const signal = AbortSignal.timeout(1000);
    expect(await haiku!.generate("Name the task", signal, ["/uploads/shot.png"], "trace-1")).toBe('{"title":"T","summary":"S"}');
    expect(runClaude).toHaveBeenCalledWith({
      runtimeId: "cli:claude", model: "claude-haiku-5-5", effort: null, claudeProfile: "space-gateway",
      prompt: expect.stringMatching(/^You name tasks[\s\S]*Name the task$/), signal, traceId: "trace-1",
    });
  });
});
