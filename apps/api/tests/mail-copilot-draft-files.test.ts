import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mailDraftFileSchema } from "../src/mail-copilot/agent-routes.js";

// 27/11 (stable req:I6Vm4b7SK-k0): a 3.3 MB attachment's base64 threw RangeError in the old regex check, so the draft route answered 500.
describe("Mail Copilot draft files", () => {
  const file = (data: string) => mailDraftFileSchema.safeParse({ filename: "OUTSCALE reply.pdf", mimeType: "application/pdf", data });

  it("accepts a ~4 MB base64 attachment", () => {
    const data = randomBytes(4 * 1024 * 1024 + 1).toString("base64");
    expect(file(data).success).toBe(true);
  });

  it("rejects base64 that is not standard and padded", () => {
    const good = randomBytes(4 * 1024 * 1024 + 1).toString("base64");
    for (const bad of [`${good.slice(0, 1000)}!${good.slice(1001)}`, good.replace(/.{76}/, "$&\n"), good.replace(/=+$/, ""), `${good}A`, "A=A=", ""]) {
      expect(file(bad).success).toBe(false);
    }
  });
});
