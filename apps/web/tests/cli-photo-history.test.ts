import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceApiError } from "../src/api.js";
import { api } from "../src/live-api.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { loadCliPhotoHistory } from "../src/features/terminal-pane/cli-photo-history.js";

const page = (data: unknown[]) => ({ data, pagination: { page: 1, pageSize: 100, total: data.length, totalPages: 1 } }) as never;
const photo = { id: "a1", roomId: "r", paneId: "p", kind: "IMAGE", deletedAt: null, storageUri: "space-artifact://cli-uploads/a1.png",
  mimeType: "image/png", metadata: { originalFilename: "shot.png" } };
const transport = () => new SpaceApiError("UPSTREAM_UNAVAILABLE: Space API request failed before a response.", { code: "UPSTREAM_UNAVAILABLE", status: 0 });

installSpaceRuntime(liveRuntime);

describe("loadCliPhotoHistory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries a page once after a transport failure", async () => {
    const artifacts = vi.spyOn(api, "artifacts").mockRejectedValueOnce(transport()).mockResolvedValueOnce(page([photo]));
    const photos = await loadCliPhotoHistory("r", "p", () => true);
    expect(artifacts).toHaveBeenCalledTimes(2);
    expect(photos.map((item) => [item.id, item.name])).toEqual([["a1", "shot.png"]]);
  });

  it("gives up after the one retry and never retries other errors", async () => {
    const artifacts = vi.spyOn(api, "artifacts").mockRejectedValue(transport());
    await expect(loadCliPhotoHistory("r", "p", () => true)).rejects.toThrow("UPSTREAM_UNAVAILABLE");
    expect(artifacts).toHaveBeenCalledTimes(2);
    artifacts.mockReset().mockRejectedValue(new SpaceApiError("Forbidden", { code: "FORBIDDEN", status: 403 }));
    await expect(loadCliPhotoHistory("r", "p", () => true)).rejects.toThrow("Forbidden");
    expect(artifacts).toHaveBeenCalledTimes(1);
  });
});
