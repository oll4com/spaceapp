// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
  it("preserves a Control request ID when a transport retry follows a lost response", async () => {
    let attempts = 0;
    const ids: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (String(url) === "/api/auth/csrf") return new Response(JSON.stringify({ csrfToken: "test", headerName: "x-space-csrf-token" }), { status: 200 });
      ids.push(JSON.parse(String(options.body)).params.arguments.requestId);
      if (++attempts === 1) return new Response(JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Lost response" } }), { status: 503 });
      return new Response(JSON.stringify({ result: { structuredContent: { status: "COMPLETED" } } }), { status: 200 });
    }));
    const { api } = await import("../src/live-api.js");
    await api.executeControlMcp("room:one", [{ kind: "pane", operation: "stop" }]);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(1);
  });

