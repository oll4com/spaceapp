import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/live-api.js";

afterEach(() => vi.unstubAllGlobals());

it("serializes the optional graph limit without changing the ordinary default request", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await api.memoryGraphOverview();
  await api.memoryGraphOverview({ limit: 50000, q: "synthetic" });
  await api.memoryGraphOverview({ limit: 0 });
  const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
  expect(urls[0]).toBe("/api/admin/memory/graph/overview");
  expect(new URL(urls[1]!, "https://local.invalid").searchParams.get("limit")).toBe("50000");
  expect(new URL(urls[1]!, "https://local.invalid").searchParams.get("q")).toBe("synthetic");
  expect(new URL(urls[2]!, "https://local.invalid").searchParams.get("limit")).toBe("0");
});
