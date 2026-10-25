import { describe, expect, it } from "vitest";
import { z } from "zod";
import "@space/contracts";

describe("validation under the app's script policy", () => {
  it("runs zod jitless in the browser, so no eval probe reaches the CSP reports (security addendum step 7)", () => {
    expect(z.config().jitless).toBe(true);
    expect(z.object({ id: z.string() }).parse({ id: "x" })).toEqual({ id: "x" });
  });
});
