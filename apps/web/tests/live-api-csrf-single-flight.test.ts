import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

// Desktop start-up 10/11: the first writes arrived together and each read its own CSRF token (three reads in one start-up).
describe("live API CSRF token", () => {
  it("reads the token once for writes that start together, and again after a 403 drops it", async () => {
    let denied = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => String(input) === "/api/auth/csrf"
      ? Response.json({ csrfToken: "csrf:one", headerName: "x-space-csrf-token" })
      : Response.json({}, { status: denied ? 403 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("../src/live-api.js");
    const csrfReads = () => fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/csrf").length;
    await Promise.all([api.clearNousMessages(), api.clearNousMessages(), api.clearNousMessages()]);
    expect(csrfReads()).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) !== "/api/auth/csrf").every(([, init]) => (init?.headers as Record<string, string>)["x-space-csrf-token"] === "csrf:one")).toBe(true);
    denied = true;
    await api.clearNousMessages().catch(() => undefined);
    denied = false;
    await api.clearNousMessages();
    expect(csrfReads()).toBe(2);
  });
});
