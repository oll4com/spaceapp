import { describe, expect, it } from "vitest";
import { prefetchT3Bundle } from "../src/features/t3code-pane/t3code-prefetch.js";

describe("T3 bundle prefetch", () => {
  it("warms only the listed flat startup files, one at a time and at low priority", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let inFlight = 0, maxInFlight = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/t3code/startup-assets") return Response.json({ version: 1, basePath: "/api/t3code/assets/", files: ["app-A1.js", "../secret.js", "app-B2.css", 7] });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response("x");
    }) as unknown as typeof fetch;
    expect(await prefetchT3Bundle(fetchFn)).toBe(2);
    expect(calls.map((call) => call.url)).toEqual(["/api/t3code/startup-assets", "/api/t3code/assets/app-A1.js", "/api/t3code/assets/app-B2.css"]);
    expect(calls[1]?.init).toMatchObject({ credentials: "same-origin", priority: "low" });
    expect(maxInFlight).toBe(1);
  });

  it("does nothing when T3 Code is off, not the owner's, or answers an unexpected shape", async () => {
    for (const answer of [new Response("{}", { status: 404 }), new Response("{}", { status: 403 }), Response.json({ basePath: "https://evil.test/", files: ["a.js"] })]) {
      const calls: string[] = [];
      const fetchFn = (async (url: string) => { calls.push(url); return answer.clone(); }) as unknown as typeof fetch;
      expect(await prefetchT3Bundle(fetchFn)).toBe(0);
      expect(calls).toEqual(["/api/t3code/startup-assets"]);
    }
  });
});
