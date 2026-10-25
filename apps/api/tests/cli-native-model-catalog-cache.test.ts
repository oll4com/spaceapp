import { describe, expect, it, vi } from "vitest";
import {
  createNativeCliModelCatalog,
  NATIVE_CLI_MODEL_CATALOG_FRESH_MS,
  type NativeCliModelCatalogRunner
} from "../src/cli-native-model-picker.js";

const gemini = "/opt/spaceapp/bin/gemini-vscode-parity";
const tsv = "gemini-3.8-flash-low\tGemini Flash (Low)\ngemini-3.8-flash-high\tGemini Flash (High)\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("native CLI model catalog cache", () => {
  it("shares one wrapper run and serves the catalog for the freshness window", async () => {
    let nowMs = 0;
    const run = vi.fn<NativeCliModelCatalogRunner>(async () => ({ stdout: tsv }));
    const load = createNativeCliModelCatalog({ run, now: () => nowMs });

    const [first, second] = await Promise.all([load(gemini, "main"), load(gemini, "main")]);
    expect(first.map((model) => model.id)).toEqual(["gemini-3.8-flash"]);
    expect(second).toBe(first);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(gemini, ["models"], expect.objectContaining({ timeout: 35_000 }));

    nowMs = NATIVE_CLI_MODEL_CATALOG_FRESH_MS - 1;
    expect(await load(gemini, "main")).toBe(first);
    expect(run).toHaveBeenCalledOnce();
  });

  it("serves the previous catalog immediately while one background refresh runs", async () => {
    let nowMs = 0;
    const refresh = deferred<{ stdout: string }>();
    const run = vi.fn<NativeCliModelCatalogRunner>()
      .mockResolvedValueOnce({ stdout: tsv })
      .mockReturnValueOnce(refresh.promise);
    const load = createNativeCliModelCatalog({ run, now: () => nowMs });
    const first = await load(gemini, null);

    nowMs = NATIVE_CLI_MODEL_CATALOG_FRESH_MS + 1;
    expect(await load(gemini, null)).toBe(first);
    expect(await load(gemini, null)).toBe(first);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

    refresh.resolve({ stdout: "gemini-4-pro-high\tGemini Pro (High)\n" });
    await vi.waitFor(async () => expect((await load(gemini, null)).map((model) => model.id)).toEqual(["gemini-4-pro"]));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps account profiles separate and forwards the profile to the wrapper", async () => {
    const run = vi.fn<NativeCliModelCatalogRunner>(async () => ({ stdout: tsv }));
    const load = createNativeCliModelCatalog({ run });
    await load(gemini, "main");
    await load(gemini, "work");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[2].env.SPACE_GEMINI_ACCOUNT_PROFILE).toBeUndefined();
    expect(run.mock.calls[1]?.[2].env.SPACE_GEMINI_ACCOUNT_PROFILE).toBe("work");
  });

  it("caches an unavailable catalog only briefly and bypasses the cache on force", async () => {
    let nowMs = 0;
    const run = vi.fn<NativeCliModelCatalogRunner>()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { killed: true }))
      .mockResolvedValue({ stdout: tsv });
    const load = createNativeCliModelCatalog({ run, now: () => nowMs });

    await expect(load(gemini, null)).rejects.toMatchObject({ errorCode: "CLI_MODEL_CATALOG_UNAVAILABLE" });
    nowMs = 14_999;
    await expect(load(gemini, null)).rejects.toMatchObject({ errorCode: "CLI_MODEL_CATALOG_UNAVAILABLE" });
    expect(run).toHaveBeenCalledOnce();

    nowMs = 15_000;
    await expect(load(gemini, null)).resolves.toHaveLength(1);
    await load(gemini, null, { force: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("keeps the last catalog when a background refresh fails", async () => {
    let nowMs = 0;
    const run = vi.fn<NativeCliModelCatalogRunner>()
      .mockResolvedValueOnce({ stdout: tsv })
      .mockRejectedValueOnce(new Error("wrapper failed"))
      .mockResolvedValue({ stdout: tsv });
    const load = createNativeCliModelCatalog({ run, now: () => nowMs });
    const first = await load(gemini, null);

    nowMs = NATIVE_CLI_MODEL_CATALOG_FRESH_MS + 1;
    expect(await load(gemini, null)).toBe(first);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await load(gemini, null)).toBe(first);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
